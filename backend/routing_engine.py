import os
import polyline
import requests

class RoutingEngine:
    def __init__(self):
        self.api_key = os.getenv("GOOGLE_MAPS_API_KEY", "AIzaSyBm52PmFkbHGAL2TrVJwbmeU_nx7J5OBYY")

    def _build_waypoint(self, wp):
        if isinstance(wp, dict):
            return {"location": {"latLng": {"latitude": float(wp['lat']), "longitude": float(wp['lng'])}}}
        elif isinstance(wp, str):
            if ',' in wp and wp.replace(',', '').replace('.', '').replace('-', '').isdigit():
                lat, lng = wp.split(',')
                return {"location": {"latLng": {"latitude": float(lat), "longitude": float(lng)}}}
            else:
                return {"address": wp}
        return None

    def get_route(self, origin, destination):
        if not self.api_key or self.api_key == "YOUR_API_KEY":
            return self._get_mock_route(origin, destination)
            
        try:
            url = "https://routes.googleapis.com/directions/v2:computeRoutes"
            headers = {
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps",
                "Content-Type": "application/json"
            }
            payload = {
                "origin": self._build_waypoint(origin),
                "destination": self._build_waypoint(destination),
                "travelMode": "DRIVE",
                "routingPreference": "TRAFFIC_AWARE"
            }
            
            response = requests.post(url, headers=headers, json=payload)
            data = response.json()
            
            if 'routes' not in data or not data['routes']:
                return {"error": "No route found.", "details": str(data)}
                
            route = data['routes'][0]
            leg = route.get('legs', [{}])[0]
            
            # Extract polyline points
            encoded_polyline = route.get('polyline', {}).get('encodedPolyline', '')
            points = polyline.decode(encoded_polyline) if encoded_polyline else []
            
            # Extract steps
            steps = []
            for step in leg.get('steps', []):
                steps.append({
                    'start_location': step.get('startLocation', {}).get('latLng', {}),
                    'end_location': step.get('endLocation', {}).get('latLng', {}),
                    'distance': step.get('distanceMeters', 0),
                    'duration': int(step.get('staticDuration', '0s').replace('s', '')),
                    'predicted_congestion_level': self._predict_traffic_state(step)
                })
                
            return {
                "distance": f"{route.get('distanceMeters', 0)} m",
                "duration": route.get('duration', '0s'),
                "polyline": encoded_polyline,
                "decoded_points": [{"lat": p[0], "lng": p[1]} for p in points],
                "steps": steps
            }
            
        except Exception as e:
            print(f"Routing Error: {e}")
            return {"error": str(e)}

    def get_snapped_fleet_locations(self, num_ambulances=88):
        if not self.api_key:
            return []
            
        spanning_routes = [
            ("Yelahanka, Bangalore", "Electronic City, Bangalore"),
            ("Whitefield, Bangalore", "Kengeri, Bangalore"),
            ("Yeswanthpur, Bangalore", "Koramangala, Bangalore"),
            ("Banashankari, Bangalore", "KR Puram, Bangalore")
        ]
        
        all_road_points = []
        for origin, dest in spanning_routes:
            try:
                res = self.get_route(origin, dest)
                if 'decoded_points' in res and res['decoded_points']:
                    points = [(p['lat'], p['lng']) for p in res['decoded_points']]
                    all_road_points.extend(points)
            except Exception as e:
                print(f"Failed to fetch spanning route: {e}")
                
        if not all_road_points:
            return []
            
        step = max(1, len(all_road_points) // num_ambulances)
        fleet_points = all_road_points[::step][:num_ambulances]
        
        return [{"lat": p[0], "lng": p[1]} for p in fleet_points]

    def get_nearest_hospital(self, location):
        if not self.api_key:
            return {"lat": 12.9333, "lng": 77.6200, "name": "St. John's Medical College Hospital"}
            
        try:
            url = "https://places.googleapis.com/v1/places:searchNearby"
            headers = {
                "X-Goog-Api-Key": self.api_key,
                "X-Goog-FieldMask": "places.displayName,places.location",
                "Content-Type": "application/json"
            }
            
            lat = float(location['lat']) if isinstance(location, dict) else float(location.split(',')[0])
            lng = float(location['lng']) if isinstance(location, dict) else float(location.split(',')[1])

            payload = {
                "includedTypes": ["hospital"],
                "maxResultCount": 1,
                "locationRestriction": {
                    "circle": {
                        "center": {"latitude": lat, "longitude": lng},
                        "radius": 10000.0
                    }
                }
            }
            
            response = requests.post(url, headers=headers, json=payload)
            data = response.json()
            
            if 'places' in data and data['places']:
                best_match = data['places'][0]
                return {
                    "lat": float(best_match['location']['latitude']),
                    "lng": float(best_match['location']['longitude']),
                    "name": best_match.get('displayName', {}).get('text', 'Unknown Hospital')
                }
            return {"error": "REQUEST_DENIED", "details": str(data)}
        except Exception as e:
            return {"error": "REQUEST_DENIED", "details": str(e)}

    def get_all_hospitals(self):
        """Scan Bangalore for major hospitals that accept all emergency cases."""
        import time
        
        # Use Places API (New) Text Search endpoint
        url = "https://places.googleapis.com/v1/places:searchText"
        headers = {
            "X-Goog-Api-Key": self.api_key,
            "X-Goog-FieldMask": "places.displayName,places.location",
            "Content-Type": "application/json"
        }

        # Keywords targeting only large, full-service emergency hospitals
        queries = [
            "multi speciality hospital Bangalore emergency",
            "government hospital Bangalore emergency",
            "super speciality hospital Bangalore",
            "trauma center Bangalore",
            "medical college hospital Bangalore",
            "NIMHANS Bangalore",
            "Apollo hospital Bangalore",
            "Fortis hospital Bangalore",
            "Manipal hospital Bangalore",
            "Narayana hospital Bangalore",
            "Columbia Asia hospital Bangalore",
            "Baptist hospital Bangalore",
            "Victoria hospital Bangalore",
            "Bowring hospital Bangalore",
            "St John's hospital Bangalore",
            "Sakra hospital Bangalore",
            "Sparsh hospital Bangalore",
            "BGS Gleneagles hospital Bangalore",
            "Aster CMI hospital Bangalore",
            "HCG hospital Bangalore",
            "Mazumdar Shaw hospital Bangalore",
            "MS Ramaiah hospital Bangalore",
        ]

        # Keywords that indicate small or specialty-only facilities to exclude
        EXCLUDE_KEYWORDS = [
            'clinic', 'nursing home', 'diagnostic', 'lab ', 'laboratory',
            'pharmacy', 'dental', 'eye', 'skin', 'ayurved', 'homeo',
            'maternity', 'fertility', 'ivf', 'physiotherapy', 'rehab',
            'blood bank', 'x-ray', 'scan centre', 'dialysis', 'polyclinic',
            'dispensary', 'health centre', 'wellness', 'naturo', 'siddha',
            'unani', 'veterinary', 'vet ', 'animal', 'child care', 'creche',
            'old age', 'de-addiction', 'psychiatric only'
        ]

        seen = set()
        all_hospitals = []

        for query in queries:
            try:
                payload = {
                    "textQuery": query,
                    "maxResultCount": 20,
                    "locationBias": {
                        "circle": {
                            "center": {"latitude": 12.9716, "longitude": 77.5946},
                            "radius": 50000.0  # max 50km allowed by Places API
                        }
                    }
                }
                response = requests.post(url, headers=headers, json=payload, timeout=8)
                data = response.json()
                
                for place in data.get('places', []):
                    name = place.get('displayName', {}).get('text', '')
                    name_lower = name.lower()
                    
                    # Skip if name contains any exclusion keyword
                    if any(ex in name_lower for ex in EXCLUDE_KEYWORDS):
                        continue
                    
                    plat = round(float(place['location']['latitude']), 4)
                    plng = round(float(place['location']['longitude']), 4)
                    key = f"{plat},{plng}"
                    if key in seen:
                        continue
                    seen.add(key)
                    all_hospitals.append({
                        "lat": plat,
                        "lng": plng,
                        "name": name
                    })
            except Exception as e:
                print(f"Hospital query error '{query}': {e}")
            time.sleep(0.1)

        print(f"Total emergency-capable hospitals found: {len(all_hospitals)}")
        return all_hospitals

    def _predict_traffic_state(self, step):
        dist = step.get('distanceMeters', 0)
        dur_str = step.get('staticDuration', '1s').replace('s', '')
        dur = max(1, float(dur_str))
        base_speed = dist / dur
        if base_speed < 4:
            return 'heavy'
        elif base_speed < 8:
            return 'moderate'
        return 'light'

    def _get_mock_route(self, origin, destination):
        # omitted for brevity, same as existing
        try:
            if isinstance(origin, str):
                olat, olng = map(float, origin.split(','))
            else:
                olat, olng = float(origin['lat']), float(origin['lng'])
                
            if isinstance(destination, str):
                dlat, dlng = map(float, destination.split(','))
            else:
                dlat, dlng = float(destination['lat']), float(destination['lng'])
        except:
            olat, olng = 12.9250, 77.5938
            dlat, dlng = 12.9738, 77.6119

        points = []
        num_steps = 40
        for i in range(num_steps + 1):
            points.append({
                "lat": olat + (dlat - olat) * (i / num_steps),
                "lng": olng + (dlng - olng) * (i / num_steps)
            })
            
        return {
            "distance": "5.0 km",
            "duration": "10 mins",
            "polyline": "",
            "decoded_points": points,
            "steps": []
        }
