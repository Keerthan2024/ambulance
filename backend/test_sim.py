import asyncio, sys, os, json
sys.path.append('c:/emergency/backend')
os.environ['GOOGLE_MAPS_API_KEY'] = 'AIzaSyBm52PmFkbHGAL2TrVJwbmeU_nx7J5OBYY'
from routing_engine import RoutingEngine
from signal_controller import SignalController
from simulation import Simulator

async def run_test():
    re = RoutingEngine()
    sc = SignalController()
    incident = {'lat': 12.9716, 'lng': 77.5946}
    
    # Phase 2 directly
    print('Starting Phase 2 Lookup...')
    hospital = re.get_nearest_hospital(incident)
    print(f'HOSPITAL FOUND: {hospital}')
    
    target_dest = {'lat': float(hospital['lat']), 'lng': float(hospital['lng'])}
    route2 = re.get_route(incident, target_dest)
    print(f'ROUTE 2 DISTANCE: {route2.get("distance", "ERROR")}')
    
    points2 = route2.get('decoded_points', [])
    steps2 = route2.get('steps', [])
    signals2 = sc.initialize_signals(points2, steps2)
    print(f'SIGNALS 2 COUNT: {len(signals2)}')
    
    sim = Simulator(points2)
    steps_count = 0
    async def step(p):
        nonlocal steps_count
        steps_count += 1
        if steps_count == 1: print('Sim 2 Started Movement')
    
    await sim.run(step)
    print(f'Sim 2 Finished. Total Steps: {steps_count}')

asyncio.run(run_test())
