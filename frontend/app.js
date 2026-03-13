let map;
let ambulanceMarker;
let routePolyline;
let signalMarkers = {};
let hospitalMarkers = [];
let fleetMarkers = [];
let incidentMarker = null;
let ws;

async function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: 12.9716, lng: 77.5946 }, // Bangalore Center
        zoom: 13,
        mapId: "DEMO_MAP_ID", // Required for AdvancedMarkerElement
        styles: [
            { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
            {
                featureType: "road",
                elementType: "geometry",
                stylers: [{ color: "#38414e" }],
            },
            {
                featureType: "road",
                elementType: "geometry.stroke",
                stylers: [{ color: "#212a37" }],
            },
            {
                featureType: "water",
                elementType: "geometry",
                stylers: [{ color: "#17263c" }],
            },
            {
                featureType: "poi",
                elementType: "labels.icon",
                stylers: [{ visibility: "off" }] // Hides generic POI icons
            },
            {
                featureType: "poi.medical",
                elementType: "labels.icon",
                stylers: [{ visibility: "on" }] // Force hospitals and pharmacies to show
            },
            {
                featureType: "transit",
                elementType: "labels.icon",
                stylers: [{ visibility: "off" }] // Hides transit icons
            }
        ]
    });

    const trafficLayer = new google.maps.TrafficLayer();
    trafficLayer.setMap(map);

    // Map click listener for Incident Reporting
    map.addListener("click", (e) => {
        placeIncidentMarker(e.latLng);
    });

    findHospitals();
}

async function placeIncidentMarker(latLng) {
    if (incidentMarker) {
        incidentMarker.position = latLng;
    } else {
        const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
        
        const pin = new PinElement({
            background: "#ff0000",
            borderColor: "#ffffff",
            glyphColor: "#ffffff"
        });

        incidentMarker = new AdvancedMarkerElement({
            position: latLng,
            map: map,
            content: pin.element,
            title: "Emergency Incident!"
        });
    }

    // Update UI
    const locInput = document.getElementById("incidentLocation");
    locInput.value = `${latLng.lat().toFixed(4)}, ${latLng.lng().toFixed(4)}`;
    
    // Enable dispatch
    const btn = document.getElementById("dispatch-btn");
    btn.disabled = false;
    btn.style.opacity = 1;
    btn.style.cursor = "pointer";
}

async function findHospitals() {
    // Clear existing hospital markers
    hospitalMarkers.forEach(m => m.map = null);
    hospitalMarkers = [];

    try {
        // Fetch comprehensive hospital list from backend grid scan
        const response = await fetch('http://localhost:8000/api/hospitals');
        const data = await response.json();
        const hospitals = data.hospitals || [];
        console.log(`Rendering ${hospitals.length} hospitals from backend scan.`);
        for (const h of hospitals) {
            createHospitalMarker(h);
        }
    } catch (err) {
        console.error('Hospital fetch from backend failed:', err);
    }
}

async function createHospitalMarker(h) {
    if (!h || h.lat == null || h.lng == null) return;

    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

    // SVG red-cross hospital icon built inline — no external image needed
    const hospitalIcon = document.createElement("div");
    hospitalIcon.innerHTML = `
        <div style="
            background: #cc0000;
            border: 2px solid #ffffff;
            border-radius: 6px;
            width: 26px;
            height: 26px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 6px rgba(0,0,0,0.5);
        ">
            <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' width='18' height='18'>
                <rect x='10' y='2' width='4' height='20' fill='white'/>
                <rect x='2' y='10' width='20' height='4' fill='white'/>
            </svg>
        </div>`;

    const marker = new AdvancedMarkerElement({
        map,
        position: { lat: h.lat, lng: h.lng },
        title: h.name,
        content: hospitalIcon
    });

    // Info window on click
    const infowindow = new google.maps.InfoWindow({
        content: `<div style="font-family:sans-serif;padding:6px;color:#111;background:#fff;border-radius:4px;min-width:140px"><strong>🏥 ${h.name}</strong></div>`
    });

    marker.addListener("click", () => {
        infowindow.open(map, marker);
    });

    hospitalMarkers.push(marker);
}

function connectWebSocket() {
    ws = new WebSocket("ws://localhost:8000/ws/simulation");
    
    ws.onmessage = async function(event) {
        const data = JSON.parse(event.data);
        
        if (data.type === "FLEET_STATUS") {
            const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
            
            data.ambulances.forEach(amb => {
                // Ambulance icon: blue box with 🚑 symbol
                const ambIcon = document.createElement("div");
                ambIcon.innerHTML = `
                    <div style="
                        background: #1565C0;
                        border: 2px solid #ffffff;
                        border-radius: 6px;
                        width: 24px;
                        height: 24px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        box-shadow: 0 2px 5px rgba(0,0,0,0.5);
                        font-size: 14px;
                        line-height: 1;
                    ">🚑</div>`;
                
                const marker = new AdvancedMarkerElement({
                    position: {lat: amb.lat, lng: amb.lng},
                    map: map,
                    content: ambIcon,
                    title: `Idle Ambulance: ${amb.id}`
                });
                
                // Attach custom property
                marker.ambulanceId = amb.id;
                fleetMarkers.push(marker);
            });
        }
        else if (data.type === "ROUTE_READY") {
            // Update Dashboard UI with phase status
            const btn = document.getElementById("dispatch-btn");
            btn.innerHTML = `Phase ${data.phase}: En Route to <strong>${data.target_name}</strong>`;
            btn.style.backgroundColor = "#ffaa00";
            
            drawRoute(data.route);
            drawSignals(data.signals);
            
            // Focus map on first point
            if (data.route.decoded_points.length > 0) {
                map.panTo(data.route.decoded_points[0]);
                map.setZoom(15);
            }
        } 
        else if (data.type === "SIMULATION_UPDATE") {
            // Hide the original idle marker if we haven't already
            if (data.ambulance_id) {
                const idleMarker = fleetMarkers.find(m => m.ambulanceId === data.ambulance_id);
                if (idleMarker && idleMarker.map) {
                    idleMarker.map = null; // Remove idle marker from map correctly for AdvancedMarkerElement
                }
            }
            updateAmbulance(data.ambulance_location);
            updateSignals(data.signals);
        }
        else if (data.type === "PHASE_COMPLETE") {
            const btn = document.getElementById("dispatch-btn");
            btn.innerHTML = data.message;
            if (data.message.includes("Mission Complete")) {
                btn.style.backgroundColor = "#00ff88"; // Success green
            } else {
                btn.style.backgroundColor = "#ff4444"; // Stopped/Paused red
            }
        }
        else if (data.type === "ERROR") {
            alert("Error: " + data.message);
        }
    };
    
    ws.onclose = () => console.log("WebSocket disconnected. Check if backend is running.");
    ws.onerror = (e) => console.error("WebSocket error:", e);
}

function drawRoute(routeData) {
    if (routePolyline) routePolyline.setMap(null);
    
    const path = routeData.decoded_points;
    
    routePolyline = new google.maps.Polyline({
        path: path,
        geodesic: true,
        strokeColor: "#00aaff",
        strokeOpacity: 0.8,
        strokeWeight: 6,
    });
    routePolyline.setMap(map);
}

async function drawSignals(signals) {
    // Clear old signals
    Object.values(signalMarkers).forEach(m => m.map = null);
    signalMarkers = {};
    
    const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
    
    signals.forEach(sig => {
        const color = sig.state === 'green' ? '#00ff00' : '#ff4444';
        const sc = sig.type === 'background' ? 0.6 : 1.0; 

        const pin = new PinElement({
            background: color,
            borderColor: "#ffffff",
            glyphColor: "#ffffff",
            scale: sc
        });

        const marker = new AdvancedMarkerElement({
            position: {lat: sig.lat, lng: sig.lng},
            map: map,
            content: pin.element,
            title: `Signal: ${sig.id} (${sig.type})`
        });
        signalMarkers[sig.id] = marker;
    });
}

async function updateSignals(signals) {
    const { PinElement } = await google.maps.importLibrary("marker");
    
    signals.forEach(sig => {
        const marker = signalMarkers[sig.id];
        if (marker) {
            const color = sig.state === 'green' ? '#00ff00' : '#ff4444';
            
            // Pulse effect for active route signals turning green, or active cross signals turning red
            let sc = sig.type === 'background' ? 0.6 : 1.0;
            if (sig.type === 'route' && sig.state === 'green') sc = 1.3;
            if (sig.type === 'cross' && sig.state === 'red') sc = 1.3;

            const pin = new PinElement({
                background: color,
                borderColor: "#ffffff",
                glyphColor: "#ffffff",
                scale: sc
            });
            
            marker.content = pin.element;
        }
    });
}

async function updateAmbulance(loc) {
    if (!ambulanceMarker) {
        const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
        
        const pin = new PinElement({
            background: "#ffffff",
            borderColor: "#cc0000",
            glyphColor: "#cc0000",
            scale: 1.5
        });
        
        ambulanceMarker = new AdvancedMarkerElement({
            position: loc,
            map: map,
            content: pin.element,
            title: "Active Ambulance",
            zIndex: 1000
        });
    } else {
        const prev = ambulanceMarker.position;
        let heading = 0;
        
        // Manual Haversine bearing calculation instead of legacy geometry API
        if (prev && prev.lat && prev.lng) {
            const lat1 = prev.lat * Math.PI / 180;
            const lng1 = prev.lng * Math.PI / 180;
            const lat2 = loc.lat * Math.PI / 180;
            const lng2 = loc.lng * Math.PI / 180;

            const dLon = (lng2 - lng1);
            const y = Math.sin(dLon) * Math.cos(lat2);
            const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
            let brng = Math.atan2(y, x);
            brng = brng * 180 / Math.PI;
            heading = (brng + 360) % 360;
        }
        
        ambulanceMarker.position = loc;
        // AdvancedMarkerElement does not support direct CSS rotation via setIcon. We slide the pin natively.
        
        // Keep camera centered on ambulance relative to route
        map.panTo(loc);
    }
}

document.getElementById("dispatch-btn").addEventListener("click", () => {
    if (!incidentMarker) return;
    
    // AdvancedMarkerElement stores location in `.position` with raw lat/lng values, no longer uses `.getPosition()` or `.lat()` functions
    const pos = incidentMarker.position; 
    const incidentType = document.getElementById("incidentType").value;
    
    const payload = JSON.stringify({
        type: "DISPATCH_EMERGENCY",
        incident: {lat: pos.lat, lng: pos.lng},
        incident_type: incidentType
    });
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
        setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            } else {
                alert("Could not connect to backend server.");
            }
        }, 500);
    } else {
        ws.send(payload);
    }
    
    // Disable button after dispatch to prevent spam
    const btn = document.getElementById("dispatch-btn");
    btn.disabled = true;
    btn.style.opacity = 0.5;
    btn.innerHTML = "Dispatching...";
});

// Init sequence
if (typeof google !== 'undefined' && google.maps) {
    initMap();
    connectWebSocket();
} else {
    window.onload = function() {
        if(typeof google !== 'undefined' && google.maps) {
            initMap();
            connectWebSocket();
        } else {
            console.warn("Google Maps API is not loaded yet.");
        }
    };
}
