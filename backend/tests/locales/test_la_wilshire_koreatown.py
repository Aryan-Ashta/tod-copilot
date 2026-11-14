"""LA: overlapping laws, SB 79 new construction vs the Citywide Adaptive Reuse Ordinance (docs/11)."""
import math

import pytest

from backend.agents.common import miles
from backend.agents.zoning_legislation import conversion_paths
from backend.models.finance import acquisition_basis
from backend.tests.locales.conftest import BACKTESTS, backtest_candidate, use_overall

L = "la_wilshire_koreatown"
PATHS = {"SB 79 new construction", "LA Citywide Adaptive Reuse"}


def _near_station(p, pid):
    c = p.precomputed.centroid[pid]
    lat = math.radians(c[1])
    return any(miles(math.hypot((c[0] - s.lonlat[0]) * 111_320 * math.cos(lat), (c[1] - s.lonlat[1]) * 110_540)) <= 0.5
               for s in p.locale.stations)


def test_every_parcel_near_a_station_shows_both_paths_cited_or_not_covered(plans):
    p = plans(L)
    near = [e for e in p.envelopes if _near_station(p, e.parcel_id)]
    assert near
    for e in near:
        assert {x.name for x in e.paths} == PATHS
        for x in e.paths:
            assert x.citations or x.eligible is None, (e.parcel_id, x.name)


def test_both_paths_win_somewhere(plans):
    assert PATHS <= {e.recommended_path for e in plans(L).envelopes}


def test_jamison_backtest_feasible_and_units_within_25pct(plans):
    bt = BACKTESTS["la_jamison_wilshire"]
    if not bt.get("address_found"):
        pytest.skip("TODO(kickoff): Jamison address not identified")
    p = plans(L)
    b = next(x for x in p.buildings if (x.name.value or "").startswith("3325 Wilshire"))
    env = next(e for e in p.envelopes if e.parcel_id == b.parcel_id)
    parcel = next(x for x in p.parcels if x.id == b.parcel_id)
    acq = acquisition_basis(parcel.last_sale_usd.value, parcel.assessed_value_usd.value)
    c, f = backtest_candidate("la_jamison_wilshire", p, conversion_paths(env.paths), acq,
                              same_building=b)
    assert use_overall(c, "residential", f) >= f["reuse_feasible_threshold"]
    assert abs(c.est_units - bt["actual_units"]) / bt["actual_units"] <= 0.25
