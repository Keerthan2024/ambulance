import asyncio
from geopy.distance import geodesic

class Simulator:
    def __init__(self, route_points):
        self.route = route_points
        self.current_index = 0
        if self.route and len(self.route) > 0:
            self.current_position = self.route[0]
        else:
            self.current_position = None
        
        self.is_running = False

    def get_position(self):
        return self.current_position

    async def run(self, update_callback):
        self.is_running = True
        
        while self.is_running and self.current_index < len(self.route) - 1:
            # Move from current point to next
            p1 = self.route[self.current_index]
            p2 = self.route[self.current_index + 1]
            
            # Distance in meters
            dist = geodesic((p1['lat'], p1['lng']), (p2['lat'], p2['lng'])).meters
            
            # Ambulance simulated speed (assume 30 m/s for fast simulation = 108 km/h)
            speed = 30.0 
            
            # Calculate time to reach next point
            travel_time = dist / speed if speed > 0 else 0
            
            # Sleep a scaled down amount for visualization
            await asyncio.sleep(min(1.0, max(0.1, travel_time / 4))) 
            
            self.current_index += 1
            self.current_position = p2
            
            # Notify watcher
            await update_callback(self.current_position)
            
        self.is_running = False
