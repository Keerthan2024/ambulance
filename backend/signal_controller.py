from geopy.distance import geodesic

class SignalController:
    def __init__(self):
        self.signals = []

    def initialize_signals(self, route_points, steps):
        self.signals = []
        
        # 1. Generate a city-wide grid of background signals for Bangalore
        # Bangalore Bounding Box Approx: Lat (12.85 to 13.10), Lng (77.45 to 77.75)
        grid_lats = [12.85 + (i * 0.05) for i in range(6)]
        grid_lngs = [77.45 + (i * 0.05) for i in range(7)]
        
        count = 0
        for glat in grid_lats:
            for glng in grid_lngs:
                self.signals.append({
                    "id": f"city_grid_{count}",
                    "lat": glat,
                    "lng": glng,
                    "state": "red", # Default city state could be alternating, we set red for simplicity
                    "type": "background",
                    "distance_to_amb": float('inf'),
                    "eta": float('inf')
                })
                count += 1
                
        # 2. Add specific intersections along the generated route
        if steps:
            for i, step in enumerate(steps):
                if i < len(steps) - 1:
                    # Main route signal (turns green)
                    self.signals.append({
                        "id": f"route_signal_{i}",
                        "lat": step['end_location'].get('latitude', step['end_location'].get('lat')),
                        "lng": step['end_location'].get('longitude', step['end_location'].get('lng')),
                        "state": "red",
                        "type": "route",
                        "distance_to_amb": float('inf'),
                        "eta": float('inf')
                    })
                    # Cross-traffic signal (turns red to stop opposing traffic)
                    # We slightly offset it visually to represent the intersecting road
                    self.signals.append({
                        "id": f"cross_signal_{i}",
                        "lat": step['end_location'].get('latitude', step['end_location'].get('lat')) + 0.0002,
                        "lng": step['end_location'].get('longitude', step['end_location'].get('lng')) + 0.0002,
                        "state": "green", # Opposite flow is green initially
                        "type": "cross",
                        "distance_to_amb": float('inf'),
                        "eta": float('inf')
                    })

        return self.signals

    def update_signals(self, ambulance_location, ambulance_speed_mps=15, eta_threshold=30):
        updated = []
        for sig in self.signals:
            dist = geodesic((ambulance_location['lat'], ambulance_location['lng']), 
                            (sig['lat'], sig['lng'])).meters
            
            eta = dist / max(1, ambulance_speed_mps)
            
            sig['distance_to_amb'] = dist
            sig['eta'] = eta
            
            # Green Corridor logic 
            if sig['type'] == 'route':
                if eta <= eta_threshold and dist < 1200:
                    sig['state'] = 'green' # Allow ambulance
            elif sig['type'] == 'cross':
                if eta <= eta_threshold and dist < 1200:
                    sig['state'] = 'red' # STOP cross-traffic
                else:
                    sig['state'] = 'green' # Normal cross-traffic flow

            updated.append(sig)
            
        self.signals = updated
        return self.signals
