from geopy.distance import geodesic
import math

# ── Major Bangalore signalised junctions ─────────────────────────────────────
BANGALORE_JUNCTIONS = [
    # Central / CBD
    (12.9762, 77.5929, "Majestic"),
    (12.9716, 77.5946, "City Market"),
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
    (12.9591, 77.6974, "Whitefield Main Junction"),
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
    # Outer Ring Road
    (12.9550, 77.6950, "Marathahalli ORR"),
    (12.9270, 77.6850, "Sarjapur ORR"),
    (13.0190, 77.6940, "Varthur"),
    (12.9820, 77.7050, "Kadugodi"),
    (13.0420, 77.6620, "Banaswadi ORR"),
    (13.0650, 77.6000, "Bellary Road"),
    (13.0180, 77.5240, "Tumkur Road"),
    # Additional
    (12.9950, 77.6280, "Indiranagar CMH Road"),
    (12.9715, 77.6398, "Old Airport Road"),
    (12.9912, 77.5782, "Sadashivanagar"),
    (12.9857, 77.5691, "Mehkri Circle"),
    (12.9923, 77.5883, "Palace Grounds"),
    (12.9580, 77.6430, "Koramangala ORR"),
    (12.9430, 77.5730, "Girinagar"),
    (12.9723, 77.6564, "Domlur ORR"),
    (12.9500, 77.6640, "HSR ORR"),
    (13.0310, 77.5450, "Peenya Industrial"),
    (12.9880, 77.7210, "Whitefield Road"),
    (12.9791, 77.5913, "Gubbi Thotadappa Rd"),
    (12.9800, 77.6200, "Halasuru Lake Rd"),
    (12.9600, 77.6300, "HSR 27th Main"),
]

# Junction snap radius — increased to 400m to reliably catch nearby junctions
SNAP_RADIUS_M = 400

# Minimum number of signals to guarantee on any route
# (evenly spaced along the decoded polyline when junction matching is sparse)
MIN_SIGNALS = 5


def _bearing_degrees(p1, p2):
    """Compass bearing (0=N, 90=E) from p1→p2."""
    lat1 = math.radians(p1[0]); lat2 = math.radians(p2[0])
    dLng = math.radians(p2[1] - p1[1])
    y = math.sin(dLng) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dLng)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _offset_point(lat, lng, bearing_deg, distance_m):
    """Return a point offset `distance_m` metres in `bearing_deg` direction."""
    R = 6371000.0
    b = math.radians(bearing_deg)
    d = distance_m / R
    lat1 = math.radians(lat)
    lng1 = math.radians(lng)
    lat2 = math.asin(math.sin(lat1) * math.cos(d) +
                     math.cos(lat1) * math.sin(d) * math.cos(b))
    lng2 = lng1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(lat1),
                              math.cos(d) - math.sin(lat1) * math.sin(lat2))
    return math.degrees(lat2), math.degrees(lng2)


def _make_signal_group(base_id, jlat, jlng, jname, travel_bearing):
    """Create the 3-signal group (route + 2 cross) for a junction."""
    perp_a = (travel_bearing + 90) % 360
    perp_b = (travel_bearing + 270) % 360
    ca_lat, ca_lng = _offset_point(jlat, jlng, perp_a, 15)
    cb_lat, cb_lng = _offset_point(jlat, jlng, perp_b, 15)
    return [
        {
            "id": f"{base_id}_route",
            "lat": jlat, "lng": jlng,
            "name": jname,
            "state": "red", "phase": "normal",
            "type": "route",
            "distance_to_amb": float('inf'), "eta": float('inf'),
        },
        {
            "id": f"{base_id}_cross_a",
            "lat": ca_lat, "lng": ca_lng,
            "name": f"{jname} cross",
            "state": "green", "phase": "normal",
            "type": "cross",
            "distance_to_amb": float('inf'), "eta": float('inf'),
        },
        {
            "id": f"{base_id}_cross_b",
            "lat": cb_lat, "lng": cb_lng,
            "name": f"{jname} cross",
            "state": "green", "phase": "normal",
            "type": "cross",
            "distance_to_amb": float('inf'), "eta": float('inf'),
        },
    ]


class SignalController:
    def __init__(self):
        self.signals = []
        self.counter = 0

    # ── public ──────────────────────────────────────────────────────────────────

    def initialize_signals(self, route_points, steps):
        """
        Build signal groups for the ambulance's route.

        Priority 1: Route step end-points from Google Directions (guaranteed on route).
        Priority 2: Bangalore junction list snapped at SNAP_RADIUS_M = 400 m.
        Fallback:   Evenly-spaced route points when fewer than MIN_SIGNALS found.
        """
        self.signals = []

        if not route_points:
            return self.signals

        # Helper: get local travel bearing at a route point index
        def bearing_at(route_pts, idx):
            n = len(route_pts)
            i = max(0, min(idx, n - 1))
            if i == 0:
                p1, p2 = route_pts[0], route_pts[1] if n > 1 else route_pts[0]
            elif i >= n - 1:
                p1, p2 = route_pts[-2], route_pts[-1]
            else:
                p1, p2 = route_pts[i - 1], route_pts[i + 1]
            return _bearing_degrees((p1['lat'], p1['lng']), (p2['lat'], p2['lng']))

        # Helper: nearest route-point index to a lat/lng
        def nearest_idx(lat, lng):
            best_i, best_d = 0, float('inf')
            for i, rp in enumerate(route_points):
                d = geodesic((lat, lng), (rp['lat'], rp['lng'])).meters
                if d < best_d:
                    best_d, best_i = d, i
            return best_i

        seen_coords = set()   # de-dup by rounded coordinate
        def add_group(jlat, jlng, jname):
            key = f"{round(jlat, 3)},{round(jlng, 3)}"
            if key in seen_coords:
                return
            seen_coords.add(key)
            idx = nearest_idx(jlat, jlng)
            bearing = bearing_at(route_points, idx)
            base = f"sig{self.counter}"
            self.counter += 1
            self.signals.extend(_make_signal_group(base, jlat, jlng, jname, bearing))

        # ── Priority 1: Route step endpoints (actual intersections on the path) ──
        if steps:
            for i, step in enumerate(steps[:-1]):  # skip last (destination)
                eloc = step.get('end_location', {})
                slat = eloc.get('latitude') or eloc.get('lat')
                slng = eloc.get('longitude') or eloc.get('lng')
                if slat is None or slng is None:
                    continue
                add_group(float(slat), float(slng), f"Intersection {i + 1}")

        # ── Priority 2: Bangalore junction list ──────────────────────────────────
        for jlat, jlng, jname in BANGALORE_JUNCTIONS:
            on_route = any(
                geodesic((jlat, jlng), (rp['lat'], rp['lng'])).meters <= SNAP_RADIUS_M
                for rp in route_points
            )
            if on_route:
                add_group(jlat, jlng, jname)

        # ── Fallback: evenly-spaced route points if still too few ────────────────
        if len(seen_coords) < MIN_SIGNALS and len(route_points) >= 2:
            n = len(route_points)
            # Place MIN_SIGNALS evenly, skip first and last 5% (start/end of route)
            margin = max(1, n // 20)
            usable = route_points[margin:-margin] if n > 2 * margin + 2 else route_points[1:-1]
            if usable:
                step = max(1, len(usable) // MIN_SIGNALS)
                for k, rp in enumerate(usable[::step][:MIN_SIGNALS]):
                    add_group(rp['lat'], rp['lng'], f"Junction {k + 1}")

        print(f"[SignalController] {len(seen_coords)} junctions → {len(self.signals)} signals")
        return self.signals

    # ── Green Corridor state machine ─────────────────────────────────────────────
    #
    # PREPARE  600–1200 m ahead  → route = amber,  cross = green (warning)
    # ACTIVE   0–600 m ahead    → route = GREEN,   cross = RED   (clear path)
    # HOLD     0–400 m behind   → keep active state (no flicker after passing)
    # RESET    > 400 m behind   → return to normal

    ACTIVE_DIST  = 600
    ACTIVE_ETA   = 25
    PREPARE_FAR  = 1200
    HOLD_BEHIND  = 400

    def update_signals(self, ambulance_location, ambulance_speed_mps=30):
        amb = ambulance_location

        for sig in self.signals:
            dist = geodesic(
                (amb["lat"], amb["lng"]),
                (sig["lat"], sig["lng"])
            ).meters
            eta = dist / max(1, ambulance_speed_mps)

            sig["distance_to_amb"] = round(dist, 1)
            sig["eta"] = round(eta, 1)

            if sig["type"] == "route":
                self._update_route_signal(sig, dist, eta)
            elif sig["type"] == "cross":
                base = sig["id"].rsplit("_cross", 1)[0]
                route_sig = next((s for s in self.signals if s["id"] == f"{base}_route"), None)
                if route_sig:
                    self._update_cross_signal(sig, route_sig["phase"])

        return self.signals

    # ── internal ─────────────────────────────────────────────────────────────────

    def _update_route_signal(self, sig, dist, eta):
        phase = sig["phase"]

        if dist <= self.ACTIVE_DIST and eta <= self.ACTIVE_ETA:
            sig["phase"] = "active"
            sig["state"] = "green"

        elif dist <= self.PREPARE_FAR and phase == "normal":
            sig["phase"] = "prepare"
            sig["state"] = "amber"

        elif phase in ("active", "prepare") and dist > self.HOLD_BEHIND:
            # Ambulance has passed and is far enough — reset
            sig["phase"] = "reset"
            sig["state"] = "red"

        elif phase == "reset" and dist > 800:
            sig["phase"] = "normal"
            sig["state"] = "red"

    def _update_cross_signal(self, sig, route_phase):
        if route_phase == "active":
            sig["phase"] = "active"
            sig["state"] = "red"
        elif route_phase == "prepare":
            sig["phase"] = "prepare"
            sig["state"] = "amber"
        else:
            sig["phase"] = route_phase
            sig["state"] = "green"