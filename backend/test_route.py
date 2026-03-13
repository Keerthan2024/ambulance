
import sys
sys.path.append('c:/emergency/backend')
import os
os.environ['GOOGLE_MAPS_API_KEY'] = 'AIzaSyBm52PmFkbHGAL2TrVJwbmeU_nx7J5OBYY'
from routing_engine import RoutingEngine
re = RoutingEngine()
hosp = re.get_nearest_hospital({'lat': 12.9716, 'lng': 77.5946})
print('FIND HOSP:', hosp)
if 'lat' in hosp:
    route = re.get_route({'lat': 12.9716, 'lng': 77.5946}, {'lat': hosp['lat'], 'lng': hosp['lng']})
    if isinstance(route, dict) and 'error' in route:
        print('ROUTE ERROR:', route['error'])
        if 'details' in route: print('DETAILS:', route['details'])
    else:
        print('ROUTE SUCCESS')

