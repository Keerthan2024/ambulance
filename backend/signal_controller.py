from geopy.distance import geodesic

# ── Major Bangalore junctions (lat, lng, name) ────────────────────────────────
# 80+ well-known signalised intersections spread across the city and outskirts.
BANGALORE_JUNCTIONS = [
    # Central / CBD
    (12.9762, 77.5929, "Majestic"),
    (12.9716, 77.5946, "City Market"),
    (12.9791, 77.5913, "Gubbi Thotadappa Rd Junction"),
    (12.9714, 77.6035, "Richmond Circle"),
    (12.9698, 77.6088, "Lalbagh West Gate"),
    (12.9658, 77.5958, "Jayanagar 4th Block"),
    (12.9634, 77.6015, "Jayanagar Shopping Complex"),
    (12.9756, 77.6102, "Trinity Circle"),
    (12.9800, 77.6084, "Ulsoor"),
    (12.9784, 77.6025, "MG Road"),
    (12.9750, 77.6074, "Brigade Road"),
    (12.9833, 77.6101, "Halasuru"),
    (12.9890, 77.6095, "Indiranagar 100ft Road"),
    (12.9856, 77.6408, "Domlur"),
    (12.9822, 77.6472, "Marathahalli Bridge"),
    (12.9591, 77.6974, "Whitefield"),
    (12.9698, 77.7472, "ITPL Main Road"),
    (12.9352, 77.6245, "BTM Layout"),
    (12.9153, 77.6101, "Electronic City Phase 1"),
    (12.8958, 77.6012, "Electronic City Phase 2"),
    (12.9276, 77.5835, "JP Nagar"),
    (12.9121, 77.5988, "Bannerghatta Road"),
    (12.9517, 77.5755, "Basavanagudi"),
    (12.9630, 77.5767, "NR Colony"),
    # North
    (13.0358, 77.5970, "Hebbal Flyover"),
    (13.0452, 77.6104, "Nagawara"),
    (13.0215, 77.5850, "Mathikere"),
    (13.0137, 77.5564, "Yeshwanthpur"),
    (13.0271, 77.5649, "Rajajinagar"),
    (12.9993, 77.5550, "Chord Road Junction"),
    (13.0081, 77.5720, "Vijayanagar"),
    (13.0350, 77.5750, "Peenya"),
    (13.0600, 77.5950, "Yelahanka"),
    (13.0670, 77.6200, "Yelahanka New Town"),
    (13.1000, 77.6100, "Devanahalli Road"),
    # South
    (12.9268, 77.5951, "Silk Board Junction"),
    (12.9190, 77.6221, "HSR Layout"),
    (12.9022, 77.6346, "Harlur"),
    (12.9456, 77.6170, "Ejipura"),
    (12.9382, 77.6124, "Koramangala"),
    (12.9500, 77.6270, "Koramangala 6th Block"),
    (12.9271, 77.5651, "Banashankari"),
    (12.9195, 77.5485, "Uttarahalli"),
    (12.8900, 77.5800, "Kengeri"),
    (12.9410, 77.5420, "Rajarajeshwari Nagar"),
    # East
    (13.0050, 77.6470, "KR Puram Bridge"),
    (12.9921, 77.6613, "Tin Factory"),
    (12.9768, 77.7101, "Hoodi"),
    (12.9632, 77.7245, "AECS Layout"),
    (13.0200, 77.6900, "Banaswadi"),
    (13.0090, 77.6600, "Ramamurthy Nagar"),
    # West
    (12.9756, 77.5450, "Rajajinagar West"),
    (12.9849, 77.5348, "Nagarbhavi"),
    (12.9968, 77.5100, "Kengeri Satellite Town"),
    (12.9612, 77.5219, "Mysore Road"),
    (12.9500, 77.5120, "Rajarajeshwari"),
    # Ring Road / Outer Ring Road
    (12.9550, 77.6950, "Marathahalli ORR"),
    (12.9270, 77.6850, "Sarjapur ORR"),
    (13.0190, 77.6940, "Varthur"),
    (12.9820, 77.7050, "Kadugodi"),
    (13.0420, 77.6620, "Banaswadi ORR"),
    (13.0650, 77.6000, "Bellary Road"),
    (13.0180, 77.5240, "Tumkur Road"),
    # Additional major points
    (12.9950, 77.6280, "Indiranagar CMH Road"),
    (12.9715, 77.6398, "Old Airport Road"),
    (12.9912, 77.5782, "Sadashivanagar"),
    (12.9857, 77.5691, "Mehkri Circle"),
    (12.9923, 77.5883, "Palace Grounds"),
    (13.0013, 77.5967, "Vidyaranyapura"),
    (12.9580, 77.6430, "Koramangala ORR"),
    (12.9430, 77.5730, "Girinagar"),
    (12.9723, 77.6564, "Domlur ORR"),
    (12.9631, 77.6542, "Intermediate Ring Road"),
    (12.9500, 77.6640, "HSR ORR"),
    (13.0310, 77.5450, "Peenya Industrial"),
    (12.9880, 77.7210, "Whitefield Main Road"),
]


class SignalController:
    def __init__(self):
        self.signals = []

    def initialize_signals(self, route_points, steps):
        self.signals = []

        # ── 1. City-wide Bangalore junction signals ───────────────────────────
        for idx, (lat, lng, name) in enumerate(BANGALORE_JUNCTIONS):
            self.signals.append({
                "id":              f"blr_{idx}",
                "lat":             lat,
                "lng":             lng,
                "name":            name,
                "state":           "red" if idx % 2 == 0 else "green",
                "type":            "background",
                "distance_to_amb": float('inf'),
                "eta":             float('inf'),
                "on_route":        False,
            })

        # ── 2. Signals at every route step intersection ───────────────────────
        if steps:
            for i, step in enumerate(steps[:-1]):
                slat = step['end_location'].get('latitude',  step['end_location'].get('lat'))
                slng = step['end_location'].get('longitude', step['end_location'].get('lng'))
                if slat is None or slng is None:
                    continue

                # Route-direction signal (will turn green for ambulance)
                self.signals.append({
                    "id":              f"route_{i}",
                    "lat":             slat,
                    "lng":             slng,
                    "name":            f"Route junction {i}",
                    "state":           "red",
                    "type":            "route",
                    "distance_to_amb": float('inf'),
                    "eta":             float('inf'),
                    "on_route":        True,
                })
                # Cross-traffic signal at the same junction (offset slightly)
                self.signals.append({
                    "id":              f"cross_{i}",
                    "lat":             slat + 0.0003,
                    "lng":             slng + 0.0003,
                    "name":            f"Cross junction {i}",
                    "state":           "green",
                    "type":            "cross",
                    "distance_to_amb": float('inf'),
                    "eta":             float('inf'),
                    "on_route":        True,
                })

        # ── 3. Mark background junctions that are close to the route ─────────
        if route_points:
            for sig in self.signals:
                if sig["type"] != "background":
                    continue
                for rp in route_points:
                    d = geodesic((sig["lat"], sig["lng"]), (rp["lat"], rp["lng"])).meters
                    if d < 120:          # within 120 m of any route point
                        sig["on_route"] = True
                        sig["type"]     = "route"   # promote to route signal
                        break

        return self.signals

    def update_signals(self, ambulance_location, ambulance_speed_mps=30):
        """
        Green Corridor logic
        ────────────────────
        AHEAD zone  (0 – 600 m, ETA ≤ 20 s):
            route signal  → GREEN  (clear the path)
            cross signal  → RED    (stop cross-traffic)
            background on-route → GREEN

        PASSED zone (> 300 m behind ambulance):
            all signals → reset to normal city state (alternating red/green)

        Outside both zones: no change (keeps last corridor state while
        ambulance is between 0-300 m past the signal to avoid flicker)
        """
        amb = ambulance_location
        updated = []

        for sig in self.signals:
            dist = geodesic(
                (amb["lat"], amb["lng"]),
                (sig["lat"], sig["lng"])
            ).meters

            eta = dist / max(1, ambulance_speed_mps)
            sig["distance_to_amb"] = dist
            sig["eta"]             = eta

            if sig["type"] in ("route", "cross"):
                # Determine whether ambulance has passed this signal.
                # We use ETA < 0 proxy: if dist is large AND ambulance has
                # been progressing, the signal is behind. We approximate
                # "passed" by checking if the signal was already green and
                # the ambulance is now > 350 m away with increasing distance.
                # Simpler robust approach: use a 20 s ETA corridor window.

                if eta <= 20 and dist <= 600:
                    # Ambulance is approaching — open corridor
                    if sig["type"] == "route":
                        sig["state"] = "green"
                    else:  # cross
                        sig["state"] = "red"
                elif dist > 350:
                    # Ambulance has passed — reset to normal
                    if sig["type"] == "route":
                        sig["state"] = "red"
                    else:
                        sig["state"] = "green"
                # Between 0–350 m after passing: hold state to avoid flicker

            elif sig["type"] == "background":
                if sig.get("on_route"):
                    # Promoted background junction on the route path
                    if eta <= 20 and dist <= 600:
                        sig["state"] = "green"
                    elif dist > 350:
                        sig["state"] = "red"
                # Off-route background signals stay in their static city state

            updated.append(sig)

        self.signals = updated
        return self.signals