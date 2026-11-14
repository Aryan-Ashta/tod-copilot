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
