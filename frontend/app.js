let map;
let signalMarkers = {};

let hospitalMarkers = [];
let fleetMarkers = [];
let incidentMarker = null;
let ws;

// ─── Map-ready gate ───────────────────────────────────────────────────────────
let _mapReadyResolve;
const mapReady = new Promise(resolve => { _mapReadyResolve = resolve; });

// ─── Route preview ────────────────────────────────────────────────────────────
let previewPolyline1 = null;
let previewPolyline2 = null;
let previewAmbMarker = null;
let previewHospMarker = null;
let previewInfoCard = null;
let previewHospitalName = "";
let previewAmbulanceId = null;   // ID of the nearest ambulance from preview call

function clearPreview() {
    if (previewPolyline1) { previewPolyline1.setMap(null); previewPolyline1 = null; }
    if (previewPolyline2) { previewPolyline2.setMap(null); previewPolyline2 = null; }
    if (previewAmbMarker) { previewAmbMarker.map = null; previewAmbMarker = null; }
    if (previewHospMarker) { previewHospMarker.map = null; previewHospMarker = null; }
    if (previewInfoCard) { previewInfoCard.remove(); previewInfoCard = null; }
}

// ─── Route progress tracking ──────────────────────────────────────────────────
let currentRoutePoints = [];
let currentPhase = 1;
let routeStartTime = null;
let totalRouteDistance = 0;
let totalRouteDuration = 0;   // seconds — from Google's TRAFFIC_AWARE routing

let remainingPolyline = null;
let travelledPolyline = null;
let glowPolyline = null;

let glowAnimId = null;
let glowOpacity = 0.3;
let glowDir = 1;

// Phase 1: orange  |  Phase 2: blue
const PHASE_COLORS = {
    1: { travelled: "#FF5500", glow: "#FFAA33", remaining: "#9fa3a7" },
    2: { travelled: "#2979FF", glow: "#82B1FF", remaining: "#9fa3a7" }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function haversineMeters(p1, p2) {
    const R = 6371000;
    const φ1 = p1.lat * Math.PI / 180, φ2 = p2.lat * Math.PI / 180;
    const Δφ = (p2.lat - p1.lat) * Math.PI / 180;
    const Δλ = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcTotalDistance(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += haversineMeters(points[i - 1], points[i]);
    return d;
}

function calcDistanceCovered(points, upToIndex) {
    let d = 0;
    for (let i = 1; i <= Math.min(upToIndex, points.length - 1); i++)
        d += haversineMeters(points[i - 1], points[i]);
    return d;
}

function formatDist(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// Parse Google Routes API duration string e.g. "1234s" → 1234 seconds
function parseDurationSeconds(durStr) {
    if (!durStr) return 0;
    const match = String(durStr).match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

// Format seconds into a human-readable ETA string
function formatEtaSecs(sec) {
    if (sec <= 0) return "0s";
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// Used in the preview card where we only have distance (not live route duration)
function formatEtaFromDist(meters, speedMps = 30) {
    return formatEtaSecs(meters / speedMps);
}

function calcBearing(p1, p2) {
    const lat1 = p1.lat * Math.PI / 180, lat2 = p2.lat * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ─── Status bar (uses real traffic duration from Google) ─────────────────────

function updateStatusBar(pointIndex) {
    const bar = document.getElementById("status-bar");
    if (!bar || currentRoutePoints.length === 0) return;

    const covered = calcDistanceCovered(currentRoutePoints, pointIndex);
    const totalDist = totalRouteDistance;
    const remaining = Math.max(0, totalDist - covered);
    const phaseName = currentPhase === 1
        ? "Phase 1 — Ambulance → Incident"
        : "Phase 2 — Incident → Hospital";
    const color = currentPhase === 1 ? "#FF5500" : "#2979FF";

    // Real traffic-aware ETA: scale the Google-provided route duration
    // proportionally by how much distance remains
    let etaStr;
    if (totalRouteDuration > 0 && totalDist > 0) {
        const fraction = remaining / totalDist;          // 0.0 – 1.0
        const remainSecs = totalRouteDuration * fraction;
        etaStr = formatEtaSecs(remainSecs);
    } else {
        // Fallback if duration missing
        etaStr = formatEtaSecs(remaining / 30);
    }

    bar.style.display = "flex";
    bar.innerHTML = `
        <span class="status-phase" style="color:${color}">● ${phaseName}</span>
        <span class="status-item">Covered: <strong>${formatDist(covered)}</strong></span>
        <span class="status-item">Remaining: <strong>${formatDist(remaining)}</strong></span>
        <span class="status-item">ETA (traffic): <strong>${etaStr}</strong></span>`;
}

// ─── Idle ambulance management ────────────────────────────────────────────────

// Hide the idle fleet marker for a given ambulance ID.
// Called as soon as ROUTE_READY phase 1 is received so it vanishes the moment
// dispatch is confirmed — not delayed until the first SIMULATION_UPDATE.
function hideIdleMarker(ambulanceId) {
    if (!ambulanceId) return;
    const marker = fleetMarkers.find(m => m.ambulanceId === ambulanceId);
    if (marker) {
        marker.map = null;          // remove from map
        marker._hidden = true;      // flag so we never try again
    }
}

// ─── Route preview ────────────────────────────────────────────────────────────

async function fetchAndDrawPreview(latLng) {
    clearPreview();
    const lat = latLng.lat(), lng = latLng.lng();

    setBtnState("calculating");

    let data;
    try {
        const res = await fetch(
            `http://localhost:8000/api/preview-route?incident_lat=${lat}&incident_lng=${lng}`
        );
        data = await res.json();
    } catch (e) {
        console.error("Preview fetch failed:", e);
        setBtnState("ready");
        return;
    }

    if (data.error) {
        console.error("Preview error:", data.error);
        setBtnState("ready");
        return;
    }

    // Remember which ambulance will be dispatched
    previewAmbulanceId = data.ambulance.id || null;

    const pts1 = data.route1.decoded_points || [];
    const pts2 = data.route2.decoded_points || [];
    const dist1 = calcTotalDistance(pts1);
    const dist2 = calcTotalDistance(pts2);

    // Use real durations from Google if available
    const dur1Secs = parseDurationSeconds(data.route1.duration);
    const dur2Secs = parseDurationSeconds(data.route2.duration);

    previewHospitalName = data.hospital.name || "Hospital";

    // Dashed preview: leg 1 orange
    const dot1 = {
        path: google.maps.SymbolPath.CIRCLE,
        fillOpacity: 1, fillColor: "#FF5500",
        strokeOpacity: 0, scale: 3
    };
    previewPolyline1 = new google.maps.Polyline({
        path: pts1, geodesic: true,
        strokeColor: "#FF5500", strokeOpacity: 0, strokeWeight: 4,
        icons: [{ icon: dot1, offset: "0", repeat: "14px" }], zIndex: 5
    });
    previewPolyline1.setMap(map);

    // Dashed preview: leg 2 blue
    const dot2 = {
        path: google.maps.SymbolPath.CIRCLE,
        fillOpacity: 1, fillColor: "#2979FF",
        strokeOpacity: 0, scale: 3
    };
    previewPolyline2 = new google.maps.Polyline({
        path: pts2, geodesic: true,
        strokeColor: "#2979FF", strokeOpacity: 0, strokeWeight: 4,
        icons: [{ icon: dot2, offset: "0", repeat: "14px" }], zIndex: 5
    });
    previewPolyline2.setMap(map);

    // Ambulance preview marker
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const ambDiv = document.createElement("div");
    ambDiv.innerHTML = `
        <div style="background:#1565C0;border:3px solid #fff;border-radius:50%;
            width:34px;height:34px;display:flex;align-items:center;
            justify-content:center;font-size:18px;line-height:1;
            box-shadow:0 0 12px 4px rgba(21,101,192,.7);">🚑</div>`;
    previewAmbMarker = new AdvancedMarkerElement({
        position: { lat: data.ambulance.lat, lng: data.ambulance.lng },
        map, content: ambDiv, title: "Nearest Ambulance", zIndex: 50
    });

    // Hospital preview marker
    const hospDiv = document.createElement("div");
    hospDiv.innerHTML = `
        <div style="background:#1565C0;border:3px solid #82B1FF;border-radius:8px;
            width:34px;height:34px;display:flex;align-items:center;
            justify-content:center;font-size:18px;line-height:1;
            box-shadow:0 0 12px 4px rgba(41,121,255,.7);">🏥</div>`;
    previewHospMarker = new AdvancedMarkerElement({
        position: { lat: data.hospital.lat, lng: data.hospital.lng },
        map, content: hospDiv, title: previewHospitalName, zIndex: 50
    });

    // Fit map to full route
    const bounds = new google.maps.LatLngBounds();
    [...pts1, ...pts2].forEach(p => bounds.extend(p));
    map.fitBounds(bounds, { top: 80, bottom: 110, left: 60, right: 60 });

    // Info card
    const eta1 = dur1Secs > 0 ? formatEtaSecs(dur1Secs) : formatEtaFromDist(dist1);
    const eta2 = dur2Secs > 0 ? formatEtaSecs(dur2Secs) : formatEtaFromDist(dist2);
    const etaTotal = (dur1Secs + dur2Secs) > 0
        ? formatEtaSecs(dur1Secs + dur2Secs)
        : formatEtaFromDist(dist1 + dist2);

    const mapContainer = document.getElementById("map-container");
    if (previewInfoCard) previewInfoCard.remove();
    previewInfoCard = document.createElement("div");
    previewInfoCard.id = "preview-info-card";
    previewInfoCard.innerHTML = `
        <div style="
            position:absolute;bottom:36px;left:50%;transform:translateX(-50%);
            background:rgba(12,16,30,.93);border:1px solid rgba(255,255,255,.12);
            border-radius:14px;padding:12px 20px;display:flex;gap:22px;
            align-items:center;backdrop-filter:blur(10px);
            box-shadow:0 4px 24px rgba(0,0,0,.55);z-index:10;white-space:nowrap;
            font-family:'Inter','Segoe UI',sans-serif;font-size:.8rem;color:#ddd;">
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
                <span style="font-size:1rem">🚑</span>
                <span style="color:#FF5500;font-weight:700;font-size:.72rem">LEG 1</span>
                <span style="color:#eee;font-weight:600">${formatDist(dist1)}</span>
                <span style="color:#aaa;font-size:.72rem">🚦 ${eta1}</span>
            </div>
            <div style="width:1px;height:40px;background:rgba(255,255,255,.15)"></div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
                <span style="font-size:1rem">🏥</span>
                <span style="color:#2979FF;font-weight:700;font-size:.72rem">LEG 2</span>
                <span style="color:#eee;font-weight:600">${formatDist(dist2)}</span>
                <span style="color:#aaa;font-size:.72rem">🚦 ${eta2}</span>
            </div>
            <div style="width:1px;height:40px;background:rgba(255,255,255,.15)"></div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
                <span style="font-size:1rem">📍</span>
                <span style="color:#fff;font-weight:700;font-size:.72rem">TOTAL</span>
                <span style="color:#eee;font-weight:600">${formatDist(dist1 + dist2)}</span>
                <span style="color:#aaa;font-size:.72rem">🚦 ${etaTotal}</span>
            </div>
            <div style="width:1px;height:40px;background:rgba(255,255,255,.15)"></div>
            <div style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;max-width:155px">
                <span style="color:#aaa;font-size:.7rem">TARGET HOSPITAL</span>
                <span style="color:#82B1FF;font-weight:600;font-size:.8rem;
                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:155px">
                    ${previewHospitalName}
                </span>
            </div>
        </div>`;
    mapContainer.style.position = "relative";
    mapContainer.appendChild(previewInfoCard);

    setBtnState("ready");
}

// ─── Button state helper (fixes prohibited cursor bug) ────────────────────────
// All button state changes go through here — NEVER touch btn.style.cursor
// anywhere else. CSS classes handle the cursor entirely.
function setBtnState(state) {
    const btn = document.getElementById("dispatch-btn");
    if (!btn) return;

    // Reset all inline overrides that could fight the CSS
    btn.style.opacity = "";
    btn.style.backgroundColor = "";
    btn.removeAttribute("disabled");
    btn.classList.remove("btn-calculating", "btn-dispatching");

    switch (state) {
        case "calculating":
            btn.innerHTML = "⏳ Calculating…";
            btn.setAttribute("disabled", true);
            btn.classList.add("btn-calculating");
            break;
        case "ready":
            btn.innerHTML = "🚨 Dispatch Ambulance";
            // enabled — CSS handles pointer cursor
            break;
        case "dispatching":
            btn.innerHTML = "⏳ Dispatching...";
            btn.setAttribute("disabled", true);
            btn.classList.add("btn-dispatching");
            break;
        case "phase1":
            btn.innerHTML = "Phase 1: 🚨 En Route → Incident";
            btn.setAttribute("disabled", true);
            btn.classList.add("btn-dispatching");
            btn.style.backgroundColor = "#ff6600";
            break;
        case "phase2":
            btn.innerHTML = `Phase 2: 🏥 En Route → ${previewHospitalName || "Hospital"}`;
            btn.setAttribute("disabled", true);
            btn.classList.add("btn-dispatching");
            btn.style.backgroundColor = "#2979FF";
            break;
        case "treating":
            btn.innerHTML = "⏳ Treating Patient at Scene...";
            btn.setAttribute("disabled", true);
            btn.classList.add("btn-dispatching");
            btn.style.backgroundColor = "#ffaa00";
            break;
        case "complete":
            btn.innerHTML = "✅ Mission Complete";
            btn.setAttribute("disabled", true);
            btn.classList.add("btn-dispatching");
            btn.style.backgroundColor = "#00c853";
            break;
        case "disabled":
        default:
            btn.innerHTML = "Dispatch Ambulance";
            btn.setAttribute("disabled", true);
            btn.style.opacity = "0.4";
            break;
    }
}

// ─── Route drawing (live animated) ───────────────────────────────────────────

function clearRouteLines() {
    if (remainingPolyline) { remainingPolyline.setMap(null); remainingPolyline = null; }
    if (travelledPolyline) { travelledPolyline.setMap(null); travelledPolyline = null; }
    if (glowPolyline) { glowPolyline.setMap(null); glowPolyline = null; }
    if (glowAnimId) { cancelAnimationFrame(glowAnimId); glowAnimId = null; }
}

function drawRouteOnReady(routeData, phase) {
    clearRouteLines();
    clearPreview();

    currentPhase = phase;
    currentRoutePoints = routeData.decoded_points || [];
    totalRouteDistance = calcTotalDistance(currentRoutePoints);
    // ── Store real traffic-aware duration from Google Routes API ──
    totalRouteDuration = parseDurationSeconds(routeData.duration);
    routeStartTime = Date.now();

    console.log(`[ROUTE_READY] Phase ${phase}: ${currentRoutePoints.length} pts, `
        + `${(totalRouteDistance / 1000).toFixed(2)} km, `
        + `${formatEtaSecs(totalRouteDuration)} (traffic)`);

    if (currentRoutePoints.length === 0) {
        console.warn('[ROUTE_READY] decoded_points empty.');
        return;
    }

    const colors = PHASE_COLORS[phase] || PHASE_COLORS[1];

    // Grey remaining — full route, shrinks each tick
    remainingPolyline = new google.maps.Polyline({
        path: [...currentRoutePoints], geodesic: true,
        strokeColor: colors.remaining, strokeOpacity: 0.7,
        strokeWeight: 6, zIndex: 1
    });
    remainingPolyline.setMap(map);

    const arrow = {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
        scale: 3, strokeColor: '#fff', strokeWeight: 2,
        fillColor: colors.travelled, fillOpacity: 1
    };

    // Vivid travelled — grows forward
    travelledPolyline = new google.maps.Polyline({
        path: [currentRoutePoints[0]], geodesic: true,
        strokeColor: colors.travelled, strokeOpacity: 1.0,
        strokeWeight: 10,
        icons: [{ icon: arrow, offset: '100%', repeat: '100px' }],
        zIndex: 3
    });
    travelledPolyline.setMap(map);

    // Glow
    glowPolyline = new google.maps.Polyline({
        path: [currentRoutePoints[0]], geodesic: true,
        strokeColor: colors.glow, strokeOpacity: 0.5,
        strokeWeight: 26, zIndex: 2
    });
    glowPolyline.setMap(map);

    startGlowPulse();
    updateStatusBar(0);
    map.panTo(currentRoutePoints[0]);
    map.setZoom(15);
}

function updateRouteProgress(pointIndex) {
    if (!travelledPolyline || !glowPolyline || !remainingPolyline) return;
    if (currentRoutePoints.length === 0) return;

    const idx = Math.min(pointIndex + 1, currentRoutePoints.length);
    const travelledPath = currentRoutePoints.slice(0, idx);
    const remainingPath = currentRoutePoints.slice(Math.max(0, idx - 1));

    travelledPolyline.setPath(travelledPath);
    glowPolyline.setPath(travelledPath);
    remainingPolyline.setPath(remainingPath);
    updateStatusBar(pointIndex);
}

function startGlowPulse() {
    if (glowAnimId) cancelAnimationFrame(glowAnimId);
    glowOpacity = 0.3; glowDir = 1;
    function pulse() {
        if (!glowPolyline) return;
        glowOpacity += glowDir * 0.012;
        if (glowOpacity >= 0.65) glowDir = -1;
        if (glowOpacity <= 0.15) glowDir = 1;
        glowPolyline.setOptions({ strokeOpacity: glowOpacity });
        glowAnimId = requestAnimationFrame(pulse);
    }
    glowAnimId = requestAnimationFrame(pulse);
}

// ─── Map init ─────────────────────────────────────────────────────────────────

async function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 12.9716, lng: 77.5946 },
        zoom: 13,
        mapId: "DEMO_MAP_ID",
        styles: [
            { elementType: "geometry", stylers: [{ color: "#1a1f2e" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#1a1f2e" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#8a9bb0" }] },
            { featureType: "road", elementType: "geometry", stylers: [{ color: "#2d3548" }] },
            { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#1a2030" }] },
            { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#3d4f6e" }] },
            { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d1520" }] },
            { featureType: "poi", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
            { featureType: "poi.medical", elementType: "labels.icon", stylers: [{ visibility: "on" }] },
            { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] }
        ]
    });
    new google.maps.TrafficLayer().setMap(map);
    map.addListener("click", (e) => placeIncidentMarker(e.latLng));
    _mapReadyResolve();
    findHospitals();
}

// ─── Incident marker ──────────────────────────────────────────────────────────

async function placeIncidentMarker(latLng) {
    if (incidentMarker) {
        incidentMarker.position = latLng;
    } else {
        const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
        const pin = new PinElement({
            background: "#ff0000", borderColor: "#ffffff",
            glyphColor: "#ffffff", scale: 1.8
        });
        incidentMarker = new AdvancedMarkerElement({
            position: latLng, map, content: pin.element, title: "Emergency Incident!"
        });
    }
    document.getElementById("incidentLocation").value =
        `${latLng.lat().toFixed(4)}, ${latLng.lng().toFixed(4)}`;
    fetchAndDrawPreview(latLng);
}

// ─── Hospitals ────────────────────────────────────────────────────────────────

async function findHospitals() {
    hospitalMarkers.forEach(m => m.map = null);
    hospitalMarkers = [];
    try {
        const res = await fetch('http://localhost:8000/api/hospitals');
        const data = await res.json();
        const hospitals = data.hospitals || [];
        for (const h of hospitals) createHospitalMarker(h);
    } catch (err) {
        console.error('Hospital fetch failed:', err);
    }
}

async function createHospitalMarker(h) {
    if (!h || h.lat == null || h.lng == null) return;
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const icon = document.createElement("div");
    icon.innerHTML = `
        <div style="background:#cc0000;border:2px solid #fff;border-radius:6px;
            width:26px;height:26px;display:flex;align-items:center;
            justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.5);">
            <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='18' height='18'>
                <rect x='10' y='2'  width='4' height='20' fill='white'/>
                <rect x='2'  y='10' width='20' height='4'  fill='white'/>
            </svg>
        </div>`;
    const marker = new AdvancedMarkerElement({
        map, position: { lat: h.lat, lng: h.lng }, title: h.name, content: icon
    });
    const iw = new google.maps.InfoWindow({
        content: `<div style="font-family:sans-serif;padding:6px;color:#111;background:#fff;
            border-radius:4px;min-width:140px"><strong>🏥 ${h.name}</strong></div>`
    });
    marker.addListener("click", () => iw.open(map, marker));
    hospitalMarkers.push(marker);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

function connectWebSocket() {
    ws = new WebSocket("ws://localhost:8000/ws/simulation");

    ws.onmessage = async function (event) {
        const data = JSON.parse(event.data);

        // ── FLEET_STATUS ──────────────────────────────────────────────────────
        if (data.type === "FLEET_STATUS") {
            await mapReady;
            const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
            data.ambulances.forEach(amb => {
                const icon = document.createElement("div");
                icon.innerHTML = `
                    <div style="background:#1565C0;border:2px solid #fff;border-radius:6px;
                        width:22px;height:22px;display:flex;align-items:center;
                        justify-content:center;box-shadow:0 2px 5px rgba(0,0,0,.5);
                        font-size:13px;line-height:1;">🚑</div>`;
                const marker = new AdvancedMarkerElement({
                    position: { lat: amb.lat, lng: amb.lng },
                    map, content: icon, title: `Idle: ${amb.id}`
                });
                marker.ambulanceId = amb.id;
                marker._hidden = false;
                fleetMarkers.push(marker);
            });
        }

        // ── ROUTE_READY ───────────────────────────────────────────────────────
        else if (data.type === "ROUTE_READY") {
            await mapReady;

            // ── FIX: Hide idle marker immediately on phase 1 confirmation ──
            // We know which ambulance was dispatched from the preview call.
            // This fires BEFORE the first SIMULATION_UPDATE so the icon
            // vanishes the moment the backend confirms dispatch.
            if (data.phase === 1 && previewAmbulanceId) {
                hideIdleMarker(previewAmbulanceId);
            }

            const phase = data.phase;
            if (phase === 1) setBtnState("phase1");
            else setBtnState("phase2");

            drawRouteOnReady(data.route, phase);
            drawSignals(data.signals);
        }

        // ── SIMULATION_UPDATE ─────────────────────────────────────────────────
        else if (data.type === "SIMULATION_UPDATE") {
            // Belt-and-suspenders: also hide by ID from backend in case
            // previewAmbulanceId was different (user clicked before preview returned)
            if (data.ambulance_id) hideIdleMarker(data.ambulance_id);

            if (data.point_index !== undefined) updateRouteProgress(data.point_index);
            updateAmbulance(data.ambulance_location);
            updateSignals(data.signals);
        }

        // ── PHASE_COMPLETE ────────────────────────────────────────────────────
        else if (data.type === "PHASE_COMPLETE") {
            if (data.message.includes("Mission Complete")) {
                setBtnState("complete");
                const bar = document.getElementById("status-bar");
                if (bar) bar.innerHTML = `<span class="status-phase" style="color:#00c853">✅ Mission Complete — Patient Delivered to ${previewHospitalName}</span>`;
                if (glowAnimId) { cancelAnimationFrame(glowAnimId); glowAnimId = null; }
            } else {
                setBtnState("treating");
                const bar = document.getElementById("status-bar");
                if (bar) bar.innerHTML = `<span class="status-phase" style="color:#ffaa00">⏳ Treating Patient at Scene...</span>`;
            }
        }

        else if (data.type === "ERROR") {
            alert("Error: " + data.message);
            setBtnState("ready");
        }
    };

    ws.onclose = () => console.log("WebSocket disconnected.");
    ws.onerror = (e) => console.error("WebSocket error:", e);
}

// ─── Traffic signal rendering ─────────────────────────────────────────────────

function buildSignalSVG(state, type) {
    const isGreen = state === 'green';
    const isActive = type === 'route' || type === 'cross';
    const size = isActive ? 32 : 20;
    const h = Math.round(size * 1.6);

    const redFill = !isGreen ? "#FF3333" : "#330000";
    const greenFill = isGreen ? "#00FF55" : "#003311";
    const redGlow = !isGreen ? `drop-shadow(0 0 4px #FF3333)` : "none";
    const greenGlow = isGreen ? `drop-shadow(0 0 4px #00FF55)` : "none";
    const bgFill = isActive ? "#111" : "#222";
    const borderCol = isActive ? (isGreen ? "#00cc44" : "#cc2200") : "#444";

    return `<svg xmlns="http://www.w3.org/2000/svg"
         width="${size}" height="${h}" viewBox="0 0 20 32">
  <rect x="1" y="1" width="18" height="30" rx="4"
        fill="${bgFill}" stroke="${borderCol}" stroke-width="1.5"/>
  <circle cx="10" cy="7.5"  r="5" fill="${redFill}"
          style="filter:${redGlow}"/>
  <circle cx="10" cy="16"   r="5" fill="#332200"/>
  <circle cx="10" cy="24.5" r="5" fill="${greenFill}"
          style="filter:${greenGlow}"/>
</svg>`;
}

async function drawSignals(signals) {
    Object.values(signalMarkers).forEach(e => { if (e?.marker) e.marker.map = null; });
    signalMarkers = {};

    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

    signals.forEach((sig, idx) => {
        const displayState = sig.type === "background"
            ? (idx % 2 === 0 ? "red" : "green")
            : sig.state;

        const wrapper = document.createElement("div");
        wrapper.style.cssText = "display:inline-block;";
        wrapper.innerHTML = buildSignalSVG(displayState, sig.type);

        const marker = new AdvancedMarkerElement({
            position: { lat: sig.lat, lng: sig.lng },
            map,
            content: wrapper,
            title: `${sig.type} — ${displayState.toUpperCase()}`,
            zIndex: sig.type === "route" ? 30 : sig.type === "cross" ? 20 : 5
        });

        signalMarkers[sig.id] = { marker, wrapper };
    });
}

function updateSignals(signals) {
    signals.forEach(sig => {
        const entry = signalMarkers[sig.id];
        if (!entry) return;
        entry.wrapper.innerHTML = buildSignalSVG(sig.state, sig.type);
    });
}

// ─── Ambulance marker — smooth glide + rotation ───────────────────────────────

let ambulanceMarker = null;
let ambulanceLerpId = null;
let prevAmbulanceLoc = null;

async function updateAmbulance(loc) {
    if (!ambulanceMarker) {
        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        const ambDiv = document.createElement("div");
        ambDiv.id = "active-ambulance-icon";
        ambDiv.innerHTML = `
            <div id="amb-inner" style="
                background:radial-gradient(circle at 40% 35%,#fff,#e0e0e0);
                border:3px solid #cc0000;border-radius:50%;
                width:38px;height:38px;display:flex;align-items:center;
                justify-content:center;box-shadow:0 0 14px 4px rgba(255,80,0,.7);
                font-size:20px;line-height:1;transform-origin:center;
                transition:transform .4s ease;
                animation:ambPulse 1s ease-in-out infinite alternate;">🚑</div>`;
        ambulanceMarker = new AdvancedMarkerElement({
            position: loc, map, content: ambDiv,
            title: "Active Ambulance", zIndex: 1000
        });
        prevAmbulanceLoc = { lat: loc.lat, lng: loc.lng };
        return;
    }

    const startLat = prevAmbulanceLoc.lat;
    const startLng = prevAmbulanceLoc.lng;

    // Rotate icon to face direction of travel
    const bearing = calcBearing(
        { lat: startLat, lng: startLng },
        { lat: loc.lat, lng: loc.lng }
    );
    const inner = document.getElementById("amb-inner");
    if (inner) inner.style.transform = `rotate(${bearing}deg)`;

    if (ambulanceLerpId) cancelAnimationFrame(ambulanceLerpId);
    const DURATION = 300, startTime = performance.now();

    function glide(now) {
        const t = Math.min((now - startTime) / DURATION, 1);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const lat = startLat + (loc.lat - startLat) * ease;
        const lng = startLng + (loc.lng - startLng) * ease;
        ambulanceMarker.position = { lat, lng };
        map.panTo({ lat, lng });
        if (t < 1) {
            ambulanceLerpId = requestAnimationFrame(glide);
        } else {
            prevAmbulanceLoc = { lat: loc.lat, lng: loc.lng };
            ambulanceLerpId = null;
        }
    }
    ambulanceLerpId = requestAnimationFrame(glide);
}

// ─── Dispatch button ──────────────────────────────────────────────────────────

document.getElementById("dispatch-btn").addEventListener("click", () => {
    if (!incidentMarker) return;

    const pos = incidentMarker.position;
    const incidentType = document.getElementById("incidentType").value;

    const payload = JSON.stringify({
        type: "DISPATCH_EMERGENCY",
        incident: { lat: pos.lat, lng: pos.lng },
        incident_type: incidentType
    });

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(payload);
            else alert("Could not connect to backend server.");
        }, 500);
    } else {
        ws.send(payload);
    }

    setBtnState("dispatching");
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.initMap = initMap;
connectWebSocket();
// Set initial button state — no incident placed yet
setBtnState("disabled");