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
let previewAmbulanceId = null;

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
let totalRouteDuration = 0;

let remainingPolyline = null;
let travelledPolyline = null;
let glowPolyline = null;

let glowAnimId = null;
let glowOpacity = 0.3;
let glowDir = 1;

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
function calcTotalDistance(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += haversineMeters(pts[i - 1], pts[i]);
    return d;
}
function calcDistanceCovered(pts, idx) {
    let d = 0;
    for (let i = 1; i <= Math.min(idx, pts.length - 1); i++) d += haversineMeters(pts[i - 1], pts[i]);
    return d;
}
function formatDist(m) {
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
function parseDurationSeconds(s) {
    const m = String(s || "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}
function formatEtaSecs(sec) {
    if (sec <= 0) return "0s";
    if (sec < 60) return `${Math.round(sec)}s`;
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
}
function formatEtaFromDist(m, spd = 30) { return formatEtaSecs(m / spd); }
function calcBearing(p1, p2) {
    const la1 = p1.lat * Math.PI / 180, la2 = p2.lat * Math.PI / 180;
    const dl = (p2.lng - p1.lng) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ─── Status bar ───────────────────────────────────────────────────────────────

function updateStatusBar(pointIndex) {
    const bar = document.getElementById("status-bar");
    if (!bar || currentRoutePoints.length === 0) return;
    const covered = calcDistanceCovered(currentRoutePoints, pointIndex);
    const remaining = Math.max(0, totalRouteDistance - covered);
    const phaseName = currentPhase === 1
        ? "Phase 1 — Ambulance → Incident" : "Phase 2 — Incident → Hospital";
    const color = currentPhase === 1 ? "#FF5500" : "#2979FF";
    let etaStr;
    if (totalRouteDuration > 0 && totalRouteDistance > 0) {
        etaStr = formatEtaSecs(totalRouteDuration * (remaining / totalRouteDistance));
    } else {
        etaStr = formatEtaSecs(remaining / 30);
    }
    bar.style.display = "flex";
    bar.innerHTML = `
        <span class="status-phase" style="color:${color}">● ${phaseName}</span>
        <span class="status-item">Covered: <strong>${formatDist(covered)}</strong></span>
        <span class="status-item">Remaining: <strong>${formatDist(remaining)}</strong></span>
        <span class="status-item">ETA (traffic): <strong>${etaStr}</strong></span>`;
}

// ─── Button state ─────────────────────────────────────────────────────────────

function setBtnState(state) {
    const btn = document.getElementById("dispatch-btn");
    if (!btn) return;
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

// ─── Idle ambulance management ────────────────────────────────────────────────

function hideIdleMarker(ambulanceId) {
    if (!ambulanceId) return;
    const marker = fleetMarkers.find(m => m.ambulanceId === ambulanceId);
    if (marker && !marker._hidden) {
        marker.map = null;
        marker._hidden = true;
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

    if (data.error) { console.error("Preview error:", data.error); setBtnState("ready"); return; }

    previewAmbulanceId = data.ambulance.id || null;
    const pts1 = data.route1.decoded_points || [];
    const pts2 = data.route2.decoded_points || [];
    const dist1 = calcTotalDistance(pts1);
    const dist2 = calcTotalDistance(pts2);
    const dur1 = parseDurationSeconds(data.route1.duration);
    const dur2 = parseDurationSeconds(data.route2.duration);
    previewHospitalName = data.hospital.name || "Hospital";

    const dot1 = { path: google.maps.SymbolPath.CIRCLE, fillOpacity: 1, fillColor: "#FF5500", strokeOpacity: 0, scale: 3 };
    previewPolyline1 = new google.maps.Polyline({
        path: pts1, geodesic: true, strokeColor: "#FF5500", strokeOpacity: 0, strokeWeight: 4,
        icons: [{ icon: dot1, offset: "0", repeat: "14px" }], zIndex: 5
    });
    previewPolyline1.setMap(map);

    const dot2 = { path: google.maps.SymbolPath.CIRCLE, fillOpacity: 1, fillColor: "#2979FF", strokeOpacity: 0, scale: 3 };
    previewPolyline2 = new google.maps.Polyline({
        path: pts2, geodesic: true, strokeColor: "#2979FF", strokeOpacity: 0, strokeWeight: 4,
        icons: [{ icon: dot2, offset: "0", repeat: "14px" }], zIndex: 5
    });
    previewPolyline2.setMap(map);

    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const ambDiv = document.createElement("div");
    ambDiv.innerHTML = `<div style="background:#1565C0;border:3px solid #fff;border-radius:50%;
        width:34px;height:34px;display:flex;align-items:center;justify-content:center;
        font-size:18px;line-height:1;box-shadow:0 0 12px 4px rgba(21,101,192,.7);">🚑</div>`;
    previewAmbMarker = new AdvancedMarkerElement({ position: { lat: data.ambulance.lat, lng: data.ambulance.lng }, map, content: ambDiv, title: "Nearest Ambulance", zIndex: 50 });

    const hospDiv = document.createElement("div");
    hospDiv.innerHTML = `<div style="background:#1565C0;border:3px solid #82B1FF;border-radius:8px;
        width:34px;height:34px;display:flex;align-items:center;justify-content:center;
        font-size:18px;line-height:1;box-shadow:0 0 12px 4px rgba(41,121,255,.7);">🏥</div>`;
    previewHospMarker = new AdvancedMarkerElement({ position: { lat: data.hospital.lat, lng: data.hospital.lng }, map, content: hospDiv, title: previewHospitalName, zIndex: 50 });

    const bounds = new google.maps.LatLngBounds();
    [...pts1, ...pts2].forEach(p => bounds.extend(p));
    map.fitBounds(bounds, { top: 80, bottom: 110, left: 60, right: 60 });

    const eta1 = dur1 > 0 ? formatEtaSecs(dur1) : formatEtaFromDist(dist1);
    const eta2 = dur2 > 0 ? formatEtaSecs(dur2) : formatEtaFromDist(dist2);
    const etaTot = (dur1 + dur2) > 0 ? formatEtaSecs(dur1 + dur2) : formatEtaFromDist(dist1 + dist2);

    const mc = document.getElementById("map-container");
    if (previewInfoCard) previewInfoCard.remove();
    previewInfoCard = document.createElement("div");
    previewInfoCard.innerHTML = `
        <div style="position:absolute;bottom:36px;left:50%;transform:translateX(-50%);
            background:rgba(12,16,30,.93);border:1px solid rgba(255,255,255,.12);
            border-radius:14px;padding:12px 20px;display:flex;gap:20px;align-items:center;
            backdrop-filter:blur(10px);box-shadow:0 4px 24px rgba(0,0,0,.55);
            z-index:10;white-space:nowrap;font-family:'Inter','Segoe UI',sans-serif;
            font-size:.8rem;color:#ddd;">
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
            <span style="color:#aaa;font-size:.72rem">🚦 ${etaTot}</span>
          </div>
          <div style="width:1px;height:40px;background:rgba(255,255,255,.15)"></div>
          <div style="display:flex;flex-direction:column;align-items:flex-start;gap:2px;max-width:160px">
            <span style="color:#aaa;font-size:.7rem">TARGET HOSPITAL</span>
            <span style="color:#82B1FF;font-weight:600;font-size:.8rem;
                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px">
                ${previewHospitalName}</span>
          </div>
        </div>`;
    mc.style.position = "relative";
    mc.appendChild(previewInfoCard);

    if (data.signals) {
        drawSignals(data.signals);
    }

    setBtnState("ready");
}

// ─── Route drawing ────────────────────────────────────────────────────────────

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
    totalRouteDuration = parseDurationSeconds(routeData.duration);
    routeStartTime = Date.now();

    if (currentRoutePoints.length === 0) { console.warn("decoded_points empty"); return; }

    const colors = PHASE_COLORS[phase] || PHASE_COLORS[1];

    remainingPolyline = new google.maps.Polyline({
        path: [...currentRoutePoints], geodesic: true,
        strokeColor: colors.remaining, strokeOpacity: 0.7, strokeWeight: 6, zIndex: 1
    });
    remainingPolyline.setMap(map);

    const arrow = {
        path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 3,
        strokeColor: '#fff', strokeWeight: 2, fillColor: colors.travelled, fillOpacity: 1
    };
    travelledPolyline = new google.maps.Polyline({
        path: [currentRoutePoints[0]], geodesic: true,
        strokeColor: colors.travelled, strokeOpacity: 1.0, strokeWeight: 10,
        icons: [{ icon: arrow, offset: '100%', repeat: '100px' }], zIndex: 3
    });
    travelledPolyline.setMap(map);

    glowPolyline = new google.maps.Polyline({
        path: [currentRoutePoints[0]], geodesic: true,
        strokeColor: colors.glow, strokeOpacity: 0.5, strokeWeight: 26, zIndex: 2
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
    travelledPolyline.setPath(currentRoutePoints.slice(0, idx));
    glowPolyline.setPath(currentRoutePoints.slice(0, idx));
    remainingPolyline.setPath(currentRoutePoints.slice(Math.max(0, idx - 1)));
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
        center: { lat: 12.9716, lng: 77.5946 }, zoom: 13, mapId: "DEMO_MAP_ID",
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
    map.addListener("click", e => placeIncidentMarker(e.latLng));

    // Pre-cache AdvancedMarkerElement NOW so drawSignals() can use it
    // synchronously when ROUTE_READY arrives — no race condition possible.
    const lib = await google.maps.importLibrary("marker");
    _AdvancedMarkerElement = lib.AdvancedMarkerElement;
    console.log("[initMap] AdvancedMarkerElement cached.");

    _mapReadyResolve();
    findHospitals();
}

// ─── Incident marker ──────────────────────────────────────────────────────────

async function placeIncidentMarker(latLng) {
    await mapReady;
    if (incidentMarker) {
        incidentMarker.position = latLng;
    } else {
        const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
        const pin = new PinElement({ background: "#ff0000", borderColor: "#ffffff", glyphColor: "#ffffff", scale: 1.8 });
        incidentMarker = new AdvancedMarkerElement({ position: latLng, map, content: pin.element, title: "Emergency Incident!" });
    }
    document.getElementById("incidentLocation").value =
        `${latLng.lat().toFixed(4)}, ${latLng.lng().toFixed(4)}`;
    fetchAndDrawPreview(latLng);
}

// ─── Hospitals ────────────────────────────────────────────────────────────────

async function findHospitals() {
    hospitalMarkers.forEach(m => m.map = null); hospitalMarkers = [];
    try {
        const data = await (await fetch('http://localhost:8000/api/hospitals')).json();
        for (const h of (data.hospitals || [])) createHospitalMarker(h);
    } catch (e) { console.error("Hospital fetch failed:", e); }
}

async function createHospitalMarker(h) {
    if (!h || h.lat == null || h.lng == null) return;
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const icon = document.createElement("div");
    icon.innerHTML = `<div style="background:#cc0000;border:2px solid #fff;border-radius:6px;
        width:26px;height:26px;display:flex;align-items:center;justify-content:center;
        box-shadow:0 2px 6px rgba(0,0,0,.5);">
        <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='18' height='18'>
            <rect x='10' y='2' width='4' height='20' fill='white'/>
            <rect x='2' y='10' width='20' height='4' fill='white'/>
        </svg></div>`;
    const m = new AdvancedMarkerElement({ map, position: { lat: h.lat, lng: h.lng }, title: h.name, content: icon });
    const iw = new google.maps.InfoWindow({ content: `<div style="font-family:sans-serif;padding:6px;color:#111;background:#fff;border-radius:4px;min-width:140px"><strong>🏥 ${h.name}</strong></div>` });
    m.addListener("click", () => iw.open(map, m));
    hospitalMarkers.push(m);
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

let _AdvancedMarkerElement = null;   // cached after first load

async function ensureMarkerLib() {
    if (!_AdvancedMarkerElement) {
        const lib = await google.maps.importLibrary("marker");
        _AdvancedMarkerElement = lib.AdvancedMarkerElement;
    }
    return _AdvancedMarkerElement;
}

function connectWebSocket() {
    ws = new WebSocket("ws://localhost:8000/ws/simulation");

    ws.onmessage = async function (event) {
        const data = JSON.parse(event.data);

        if (data.type === "FLEET_STATUS") {
            await mapReady;
            const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
            data.ambulances.forEach(amb => {
                const icon = document.createElement("div");
                icon.innerHTML = `<div style="background:#1565C0;border:2px solid #fff;
                    border-radius:6px;width:22px;height:22px;display:flex;align-items:center;
                    justify-content:center;box-shadow:0 2px 5px rgba(0,0,0,.5);
                    font-size:13px;line-height:1;">🚑</div>`;
                const m = new AdvancedMarkerElement({ position: { lat: amb.lat, lng: amb.lng }, map, content: icon, title: `Idle: ${amb.id}` });
                m.ambulanceId = amb.id; m._hidden = false;
                fleetMarkers.push(m);
            });
        }

        else if (data.type === "ROUTE_READY") {
            await mapReady;
            if (data.phase === 1 && previewAmbulanceId) hideIdleMarker(previewAmbulanceId);
            setBtnState(data.phase === 1 ? "phase1" : "phase2");
            drawRouteOnReady(data.route, data.phase);
            drawSignals(data.signals);   // synchronous — no await needed
        }

        else if (data.type === "SIMULATION_UPDATE") {
            if (data.ambulance_id) hideIdleMarker(data.ambulance_id);
            if (data.point_index !== undefined) updateRouteProgress(data.point_index);
            updateAmbulance(data.ambulance_location);
            updateSignals(data.signals);
        }

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

        else if (data.type === "ERROR") { alert("Error: " + data.message); setBtnState("ready"); }
    };

    ws.onclose = () => console.log("WebSocket disconnected.");
    ws.onerror = e => console.error("WebSocket error:", e);
}

// ─── Traffic Signal Markers ───────────────────────────────────────────────────
//
// Uses AdvancedMarkerElement with DOM content (cached at initMap startup).
// _AdvancedMarkerElement is pre-populated in initMap() via importLibrary so
// drawSignals() can run synchronously — no race condition with SIMULATION_UPDATE.
//
// Signal states:
//   red    → route signal: STOP      | cross: GO
//   amber  → route signal: SLOW/WARN | cross: SLOW
//   green  → route signal: GO        | cross: STOP

function _makeSigElement(state, isRoute) {
    const colors = { red: '#FF3333', amber: '#FFCC00', green: '#00FF66' };
    const color = colors[state] || '#FF3333';
    const size = isRoute ? 24 : 16;
    
    // Create a container that looks like a signal head
    const div = document.createElement('div');
    div.style.cssText = `
        width:${size}px;height:${size}px;
        background:#1a1a1a;
        border:2px solid #444;
        border-radius:4px;
        display:flex;
        align-items:center;
        justify-content:center;
        box-shadow: 0 2px 4px rgba(0,0,0,0.5);
        cursor:pointer;
    `;
    
    // Create the actual light
    const light = document.createElement('div');
    light.id = 'sig-light';
    light.style.cssText = `
        width:${size-8}px;height:${size-8}px;
        background:${color};
        border-radius:50%;
        box-shadow: 0 0 ${isRoute ? 12 : 6}px 2px ${color};
        transition: background 0.3s ease, box-shadow 0.3s ease;
    `;
    div.appendChild(light);
    return div;
}

function drawSignals(signals) {
    // Remove old markers
    Object.values(signalMarkers).forEach(e => { if (e?.marker) e.marker.map = null; });
    signalMarkers = {};

    if (!signals || signals.length === 0) {
        console.warn('[drawSignals] No signals from backend.');
        return;
    }

    if (!_AdvancedMarkerElement) {
        console.error('[drawSignals] AdvancedMarkerElement not yet cached — retrying in 500ms');
        setTimeout(() => drawSignals(signals), 500);
        return;
    }

    console.log(`[drawSignals] Placing ${signals.length} signal markers (${signals.filter(s=>s.type!=='background').length} visible)...`);

    for (const sig of signals) {
        if (sig.type === 'background') continue;

        const isRoute = sig.type === 'route';
        const el = _makeSigElement(sig.state || 'red', isRoute);

        const marker = new _AdvancedMarkerElement({
            position: { lat: sig.lat, lng: sig.lng },
            map,
            content: el,
            title: `${sig.name || sig.type} [${(sig.state || 'red').toUpperCase()}]`,
            zIndex: isRoute ? 40 : 30,
        });

        signalMarkers[sig.id] = { marker, el, light: el.firstChild, state: sig.state, type: sig.type, name: sig.name, isRoute };
    }
    console.log(`[drawSignals] Done — ${Object.keys(signalMarkers).length} markers placed on map.`);
}

function updateSignals(signals) {
    if (!signals) return;
    const colors = { red: '#FF3333', amber: '#FFCC00', green: '#00FF66' };
    for (const sig of signals) {
        if (sig.type === 'background') continue;
        const entry = signalMarkers[sig.id];
        if (!entry) continue;
        if (entry.state !== sig.state) {
            const newColor = colors[sig.state] || '#FF3333';
            if (entry.light) {
                entry.light.style.background = newColor;
                entry.light.style.boxShadow = `0 0 ${entry.isRoute ? 12 : 6}px 2px ${newColor}`;
            }
            entry.marker.title = `${entry.name || sig.type} [${sig.state.toUpperCase()}]`;
            entry.state = sig.state;
        }
    }
}


// ─── Ambulance marker ─────────────────────────────────────────────────────────

let ambulanceMarker = null;
let ambulanceLerpId = null;
let prevAmbulanceLoc = null;

async function updateAmbulance(loc) {
    if (!ambulanceMarker) {
        const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
        const div = document.createElement("div");
        div.id = "active-ambulance-icon";
        div.innerHTML = `<div id="amb-inner" style="
            background:radial-gradient(circle at 40% 35%,#fff,#e0e0e0);
            border:3px solid #cc0000;border-radius:50%;width:38px;height:38px;
            display:flex;align-items:center;justify-content:center;
            box-shadow:0 0 14px 4px rgba(255,80,0,.7);font-size:20px;line-height:1;
            transform-origin:center;transition:transform .4s ease;
            animation:ambPulse 1s ease-in-out infinite alternate;">🚑</div>`;
        ambulanceMarker = new AdvancedMarkerElement({ position: loc, map, content: div, title: "Active Ambulance", zIndex: 1000 });
        prevAmbulanceLoc = { lat: loc.lat, lng: loc.lng };
        return;
    }

    const sLat = prevAmbulanceLoc.lat, sLng = prevAmbulanceLoc.lng;
    const bearing = calcBearing({ lat: sLat, lng: sLng }, { lat: loc.lat, lng: loc.lng });
    const inner = document.getElementById("amb-inner");
    if (inner) inner.style.transform = `rotate(${bearing}deg)`;

    if (ambulanceLerpId) cancelAnimationFrame(ambulanceLerpId);
    const DUR = 300, t0 = performance.now();

    function glide(now) {
        const t = Math.min((now - t0) / DUR, 1);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const lat = sLat + (loc.lat - sLat) * ease;
        const lng = sLng + (loc.lng - sLng) * ease;
        ambulanceMarker.position = { lat, lng };
        map.panTo({ lat, lng });
        if (t < 1) { ambulanceLerpId = requestAnimationFrame(glide); }
        else { prevAmbulanceLoc = { lat: loc.lat, lng: loc.lng }; ambulanceLerpId = null; }
    }
    ambulanceLerpId = requestAnimationFrame(glide);
}

// ─── Dispatch button ──────────────────────────────────────────────────────────

document.getElementById("dispatch-btn").addEventListener("click", () => {
    if (!incidentMarker) return;
    const pos = incidentMarker.position;
    const payload = JSON.stringify({
        type: "DISPATCH_EMERGENCY",
        incident: { lat: pos.lat, lng: pos.lng },
        incident_type: document.getElementById("incidentType").value
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

// ─── Dynamic Config & Google Maps Loader ──────────────────────────────────────
async function loadGoogleMaps() {
    try {
        const response = await fetch('http://localhost:8000/api/config');
        const config = await response.json();
        const apiKey = config.google_maps_api_key;

        if (!apiKey || apiKey === "YOUR_API_KEY_HERE") {
            console.error("Invalid Google Maps API Key. Please check your .env file.");
            alert("API Key missing! Please configure backend/.env");
            return;
        }

        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&v=weekly&libraries=geometry&callback=initMap`;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
        console.log("Google Maps script injected dynamically.");
    } catch (error) {
        console.error("Failed to fetch config or load Google Maps:", error);
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.initMap = initMap;
loadGoogleMaps(); // Start the dynamic loading process
connectWebSocket();
setBtnState("disabled");