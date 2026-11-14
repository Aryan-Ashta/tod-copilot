from datetime import datetime, timezone

from backend.models.transit import estimate_ridership, simulate_count, upgrade_cost
from backend.schemas import Provenance

F = {"service_span_hours_per_day": 18, "service_days_per_year": 360, "bus_operating_cost_usd_per_revenue_hour": 100,
     "stop_catchment_m": 400, "ridership_rate_low": 0.02, "ridership_rate_high": 0.08,
     "simulated_count_position_in_range": 0.4, "count_range_narrowing_pct": 60}
P = Provenance(source="t", confidence="medium", retrieved_at=datetime.now(timezone.utc))


def test_upgrade_cost_hand_checked():
    # 2 h cycle: 120/15 - 120/60 = 6 extra buses x 18 h x 360 d x $100
    assert upgrade_cost(2, 60, 15, F) == 6 * 18 * 360 * 100


def test_ridership_split_and_simulated_count():
    stops = [{"id": "a", "lonlat": (0, 0), "xy": (0, 0), "route_ids": []},
             {"id": "b", "lonlat": (0, 0), "xy": (300, 0), "route_ids": []}]
    grid = [{"h3": "x", "xy": (150, 0), "demand": 1000}, {"h3": "y", "xy": (-300, 0), "demand": 500}]
    a, b = estimate_ridership(stops, grid, F, P)
    assert (a.riders_per_day_low, a.riders_per_day_high) == (20.0, 80.0)  # 500 + 500 shared
    assert (b.riders_per_day_low, b.riders_per_day_high) == (10.0, 40.0)
    s = simulate_count(a, F)
    assert s.simulated is True and s.count_per_day == 44.0  # 20 + .4 x 60
    assert s.after == (32.0, 56.0)                          # half-width 30 x .4 = 12


def test_measurements_one_per_stop_name():
    from backend.models.transit import suggest_measurements
    from backend.schemas import Stop
    stops = [Stop(id=i, lonlat=(0, 0), route_ids=[], riders_per_day_low=lo, riders_per_day_high=hi, prov=P)
             for i, lo, hi in (("n", 10, 90), ("s", 10, 80), ("w", 5, 50), ("v", 1, 10))]
    names = {"n": "8th / Westmoreland", "s": "Westmoreland / 8th", "w": "Wilshire / Western", "v": "Vermont"}
    ms = suggest_measurements(stops, {i: 1.0 for i in names}, names, F)
    assert [m.target_id for m in ms] == ["n", "w", "v"]


def test_measurements_favour_stops_serving_planned_homes():
    from backend.models.transit import suggest_measurements
    from backend.schemas import Stop
    # "far" has the widest range but no planned homes nearby; "near" serves a 200-home site 100 m away
    stops = [Stop(id="far", lonlat=(0.0, 0.0), route_ids=[], riders_per_day_low=10, riders_per_day_high=500, prov=P),
             Stop(id="near", lonlat=(1.0, 0.0), route_ids=[], riders_per_day_low=10, riders_per_day_high=50, prov=P)]
    names = {"far": "Far", "near": "Near"}
    assert [m.target_id for m in suggest_measurements(stops, {"far": 1, "near": 1}, names, F)] == ["far", "near"]
    site = ((1.0009, 0.0), 200)
    assert [m.target_id for m in suggest_measurements(stops, {"far": 1, "near": 1}, names, F, (site,))] == ["near", "far"]
