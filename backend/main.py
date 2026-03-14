import os
import json
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from routing_engine import RoutingEngine
from signal_controller import SignalController
from simulation import Simulator

load_dotenv()

app = FastAPI(title="Dynamic Green Corridor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

routing_engine = RoutingEngine()

@app.get("/")
def read_root():
    return {"status": "Dynamic Green Corridor System Backend is running"}

_hospitals_cache = None

@app.get("/api/hospitals")
def get_all_hospitals():
    global _hospitals_cache
    if not _hospitals_cache:
        print("Running hospital scan for emergency-capable hospitals...")
        _hospitals_cache = routing_engine.get_all_hospitals()
        print(f"Cached {len(_hospitals_cache)} hospitals.")
    return {"hospitals": _hospitals_cache}

@app.get("/api/preview-route")
def get_preview_route(incident_lat: float, incident_lng: float):
    """
    Called by the frontend after the user clicks a map location.
    Returns:
      - nearest ambulance position
      - route1: ambulance → incident
      - nearest hospital
      - route2: incident → hospital
    """
    incident = {"lat": incident_lat, "lng": incident_lng}

    # Find nearest idle ambulance
    closest_amb = min(fleet, key=lambda a: geodesic(
        (incident_lat, incident_lng), (a["lat"], a["lng"])
    ).meters)

    origin = {"lat": closest_amb["lat"], "lng": closest_amb["lng"]}
    route1 = routing_engine.get_route(origin, incident)
    if "error" in route1:
        return {"error": route1["error"]}

    # Find nearest hospital
    hospital = None
    if _hospitals_cache:
        hospital = min(_hospitals_cache, key=lambda h: geodesic(
            (incident_lat, incident_lng), (h["lat"], h["lng"])
        ).meters)
    if not hospital:
        hospital = routing_engine.get_nearest_hospital(incident)
        if "error" in hospital:
            return {"error": hospital["error"]}

    target = {"lat": hospital["lat"], "lng": hospital["lng"]}
    route2 = routing_engine.get_route(incident, target)
    if "error" in route2:
        return {"error": route2["error"]}

    return {
        "ambulance": closest_amb,
        "route1": route1,
        "hospital": hospital,
        "route2": route2,
    }

import random
from geopy.distance import geodesic

fleet = []
print("Scattering 100 ambulances across Bangalore and outskirts...")
for i in range(100):
    fleet.append({
        "id": f"amb_{i}",
        "lat": 12.75 + random.random() * (13.20 - 12.75),
        "lng": 77.35 + random.random() * (77.85 - 77.35),
        "status": "idle"
    })
print("Successfully scattered 100 ambulances.")


def _find_nearest_ambulance(incident: dict):
    """Return the fleet ambulance closest to incident."""
    closest, min_dist = None, float('inf')
    for amb in fleet:
        d = geodesic((incident['lat'], incident['lng']),
                     (amb['lat'], amb['lng'])).meters
        if d < min_dist:
            min_dist = d
            closest  = amb
    return closest


def _find_nearest_hospital(incident: dict):
    """Return nearest hospital from cache, or fall back to Places API."""
    global _hospitals_cache
    if _hospitals_cache:
        best, min_dist = None, float('inf')
        for h in _hospitals_cache:
            d = geodesic((incident['lat'], incident['lng']),
                         (h['lat'], h['lng'])).meters
            if d < min_dist:
                min_dist = d
                best     = h
        if best:
            print(f"Nearest hospital: {best['name']} ({min_dist:.0f} m away)")
            return best
    # Fallback
    return routing_engine.get_nearest_hospital(incident)


# ── NEW: Route preview endpoint ───────────────────────────────────────────────
@app.get("/api/preview-route")
def preview_route(incident_lat: float, incident_lng: float):
    """
    Called as soon as the user clicks the map to log an incident.
    Returns both route legs so the frontend can draw a full dashed preview
    BEFORE the ambulance starts moving.
    """
    incident = {"lat": incident_lat, "lng": incident_lng}

    # ── Leg 1: nearest ambulance → incident ──────────────────────────────────
    amb = _find_nearest_ambulance(incident)
    if not amb:
        return {"error": "No ambulances available."}

    origin = {"lat": amb['lat'], "lng": amb['lng']}
    route1 = routing_engine.get_route(origin, incident)
    if "error" in route1:
        return {"error": f"Route 1 failed: {route1['error']}"}

    # ── Leg 2: incident → nearest hospital ───────────────────────────────────
    hospital = _find_nearest_hospital(incident)
    if not hospital or "error" in hospital:
        return {"error": "Could not find a nearby hospital."}

    target = {"lat": hospital['lat'], "lng": hospital['lng']}
    route2 = routing_engine.get_route(incident, target)
    if "error" in route2:
        return {"error": f"Route 2 failed: {route2['error']}"}

    # ── Traffic Signals for both legs ────────────────────────────────────────
    sc = SignalController()
    sigs1 = sc.initialize_signals(route1.get("decoded_points", []), route1.get("steps", []))
    sigs2 = sc.initialize_signals(route2.get("decoded_points", []), route2.get("steps", []))
    
    # De-duplicate signals that might be at the same junction (incident location)
    all_sigs = sigs1 + sigs2
    unique_sigs = {}
    for s in all_sigs:
        unique_sigs[s["id"]] = s

    return {
        "ambulance": {
            "lat": amb['lat'],
            "lng": amb['lng'],
            "id":  amb['id']
        },
        "hospital": hospital,
        "route1":   route1,   # ambulance → incident
        "route2":   route2,   # incident  → hospital
        "signals":  list(unique_sigs.values())
    }
# ─────────────────────────────────────────────────────────────────────────────


@app.websocket("/ws/simulation")
async def simulation_endpoint(websocket: WebSocket):
    await websocket.accept()

    await websocket.send_text(json.dumps({
        "type":       "FLEET_STATUS",
        "ambulances": fleet
    }))

    simulator         = None
    signal_controller = SignalController()

    try:
        while True:
            data    = await websocket.receive_text()
            message = json.loads(data)

            if message.get("type") == "DISPATCH_EMERGENCY":
                incident      = message.get("incident")
                incident_type = message.get("incident_type")

                # ── Phase 1: nearest ambulance → incident ─────────────────────
                closest_amb = _find_nearest_ambulance(incident)
                origin      = {"lat": closest_amb['lat'], "lng": closest_amb['lng']}

                route1_data = routing_engine.get_route(origin, incident)
                if "error" in route1_data:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": route1_data["error"]}))
                    continue

                points1  = route1_data.get("decoded_points", [])
                steps1   = route1_data.get("steps", [])
                signals1 = signal_controller.initialize_signals(points1, steps1)

                await websocket.send_text(json.dumps({
                    "type":        "ROUTE_READY",
                    "phase":       1,
                    "target_name": "Emergency Incident Scene",
                    "route":       route1_data,
                    "signals":     signals1
                }))

                simulator        = Simulator(points1)
                dispatched_amb_id = closest_amb['id']

                async def on_simulation_step(current_pos, point_index):
                    updated_signals = signal_controller.update_signals(
                        current_pos, ambulance_speed_mps=30)
                    try:
                        await websocket.send_text(json.dumps({
                            "type":               "SIMULATION_UPDATE",
                            "ambulance_id":       dispatched_amb_id,
                            "ambulance_location": current_pos,
                            "point_index":        point_index,
                            "signals":            updated_signals
                        }))
                    except Exception:
                        pass

                await simulator.run(on_simulation_step)

                # ── Pause at incident ─────────────────────────────────────────
                await websocket.send_text(json.dumps({
                    "type":    "PHASE_COMPLETE",
                    "message": "Ambulance arrived at incident. Picking up patient..."
                }))
                await asyncio.sleep(4)

                # ── Phase 2: incident → nearest hospital ──────────────────────
                hospital = _find_nearest_hospital(incident)
                if not hospital:
                    hospital = routing_engine.get_nearest_hospital(incident)
                    if "error" in hospital:
                        await websocket.send_text(json.dumps({"type": "ERROR", "message": hospital["error"]}))
                        continue

                target_dest = {"lat": hospital['lat'], "lng": hospital['lng']}
                print(f"Phase 2 target: {target_dest}")

                route2_data = routing_engine.get_route(incident, target_dest)
                if "error" in route2_data:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": route2_data["error"]}))
                    continue

                points2  = route2_data.get("decoded_points", [])
                steps2   = route2_data.get("steps", [])
                signals2 = signal_controller.initialize_signals(points2, steps2)

                await websocket.send_text(json.dumps({
                    "type":        "ROUTE_READY",
                    "phase":       2,
                    "target_name": hospital['name'],
                    "route":       route2_data,
                    "signals":     signals2
                }))

                simulator = Simulator(points2)
                await simulator.run(on_simulation_step)

                await websocket.send_text(json.dumps({
                    "type":    "PHASE_COMPLETE",
                    "message": f"Arrived at {hospital['name']}. Mission Complete."
                }))

            elif message.get("type") == "STOP_SIMULATION":
                if simulator:
                    simulator.is_running = False

    except WebSocketDisconnect:
        if simulator:
            simulator.is_running = False
        print("Client disconnected.")
    except Exception as e:
        print(f"WebSocket Error: {e}")