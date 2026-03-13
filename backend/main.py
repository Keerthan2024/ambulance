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
    if not _hospitals_cache:  # re-run if None OR empty list from a failed previous run
        print("Running hospital scan for emergency-capable hospitals...")
        _hospitals_cache = routing_engine.get_all_hospitals()
        print(f"Cached {len(_hospitals_cache)} hospitals.")
    return {"hospitals": _hospitals_cache}

import random
from geopy.distance import geodesic

# 100 ambulances scattered randomly across Bangalore including outskirts
fleet = []

print("Scattering 100 ambulances across Bangalore and outskirts...")
for i in range(100):
    fleet.append({
        "id": f"amb_{i}",
        # Expanded bounding box covers outskirts: Devanahalli, Electronic City, Magadi, Tumkur, Hosur road areas
        "lat": 12.75 + random.random() * (13.20 - 12.75),
        "lng": 77.35 + random.random() * (77.85 - 77.35),
        "status": "idle"
    })
print("Successfully scattered 50 ambulances.")

@app.websocket("/ws/simulation")
async def simulation_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # Send initial fleet layout
    await websocket.send_text(json.dumps({
        "type": "FLEET_STATUS",
        "ambulances": fleet
    }))
    
    simulator = None
    signal_controller = SignalController()
    
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message.get("type") == "DISPATCH_EMERGENCY":
                incident = message.get("incident")
                incident_type = message.get("incident_type")
                
                # --- PHASE 1: Find Nearest Ambulance and Route to Incident ---
                closest_amb = None
                min_dist = float('inf')
                
                for amb in fleet:
                    dist = geodesic((incident['lat'], incident['lng']), (amb['lat'], amb['lng'])).meters
                    if dist < min_dist:
                        min_dist = dist
                        closest_amb = amb
                        
                origin = {"lat": closest_amb['lat'], "lng": closest_amb['lng']}
                destination = incident

                route1_data = routing_engine.get_route(origin, destination)
                if "error" in route1_data:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": route1_data["error"]}))
                    continue
                    
                points1 = route1_data.get("decoded_points", [])
                steps1 = route1_data.get("steps", [])
                signals1 = signal_controller.initialize_signals(points1, steps1)
                
                await websocket.send_text(json.dumps({
                    "type": "ROUTE_READY",
                    "phase": 1,
                    "target_name": "Emergency Incident Scene",
                    "route": route1_data,
                    "signals": signals1
                }))
                
                simulator = Simulator(points1)
                
                async def on_simulation_step(current_pos):
                    updated_signals = signal_controller.update_signals(current_pos, ambulance_speed_mps=30)
                    try:
                        await websocket.send_text(json.dumps({
                            "type": "SIMULATION_UPDATE",
                            "ambulance_location": current_pos,
                            "signals": updated_signals
                        }))
                    except Exception:
                        pass
                
                await simulator.run(on_simulation_step)
                
                # --- PAUSE AT INCIDENT ---
                await websocket.send_text(json.dumps({"type": "PHASE_COMPLETE", "message": "Ambulance arrived at incident. Treating patient..."}))
                await asyncio.sleep(4) # Simulate 4 seconds real-time loading/treating
                
                # --- PHASE 2: Find truly nearest hospital by geodesic distance from cache ---
                hospital = None
                if _hospitals_cache:
                    min_dist = float('inf')
                    for h in _hospitals_cache:
                        d = geodesic((incident['lat'], incident['lng']), (h['lat'], h['lng'])).meters
                        if d < min_dist:
                            min_dist = d
                            hospital = h
                    print(f"Nearest hospital: {hospital['name']} ({min_dist:.0f}m away)")
                
                if not hospital:
                    # Fallback to Places API if cache not loaded yet
                    hospital = routing_engine.get_nearest_hospital(incident)
                    if "error" in hospital:
                        await websocket.send_text(json.dumps({"type": "ERROR", "message": hospital["error"]}))
                        continue
                    
                target_dest = {"lat": hospital['lat'], "lng": hospital['lng']}    
                print(f"Phase 2 Target Destination Payload: {target_dest}")
                route2_data = routing_engine.get_route(incident, target_dest)
                print(f"Phase 2 Route Calculation Result: {route2_data.get('error', 'Success')}")
                
                if "error" in route2_data:
                    await websocket.send_text(json.dumps({"type": "ERROR", "message": route2_data["error"]}))
                    continue
                    
                points2 = route2_data.get("decoded_points", [])
                steps2 = route2_data.get("steps", [])
                signals2 = signal_controller.initialize_signals(points2, steps2)
                
                await websocket.send_text(json.dumps({
                    "type": "ROUTE_READY",
                    "phase": 2,
                    "target_name": hospital['name'],
                    "route": route2_data,
                    "signals": signals2
                }))
                
                simulator = Simulator(points2)
                await simulator.run(on_simulation_step)
                
                await websocket.send_text(json.dumps({"type": "PHASE_COMPLETE", "message": f"Arrived at {hospital['name']}. Mission Complete."}))
                
            elif message.get("type") == "STOP_SIMULATION":
                if simulator:
                    simulator.is_running = False
                    
    except WebSocketDisconnect:
        if simulator:
            simulator.is_running = False
        print("Client disconnected.")
    except Exception as e:
        print(f"WebSocket Error: {e}")
