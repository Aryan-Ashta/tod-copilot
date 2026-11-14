"""Houston: building reuse on a high-vacancy office market; the no-zoning legal path (docs/11)."""
import json
import math

from backend.tests.locales.conftest import BACKTESTS, backtest_candidate, use_overall

L = "houston_downtown"


def test_one_city_centre_in_top_decile_of_office_candidates(plans):
    p = plans(L)
    bmap = {b.id: b for b in p.buildings}
    offices = [c for c in p.conversions if bmap[c.building_id].property_type.value == "office"]
    ranked = sorted(offices, key=lambda c: (c.best_use == "keep_current", -c.overall))
    occ = next(c for c in ranked if bmap[c.building_id].name.value == "One City Centre")
    top = math.ceil(len(ranked) * 0.1)
    assert ranked.index(occ) < top, f"One City Centre ranks {ranked.index(occ) + 1} of {len(ranked)}"


def test_1801_smith_backtest_feasible_and_units_within_25pct(plans):
    p = plans(L)
    paths = p.envelopes[0].paths
    c, f = backtest_candidate("houston_1801_smith", p, paths, BACKTESTS["houston_1801_smith"]["acquisition_usd_estimate"])
    assert use_overall(c, "residential", f) >= f["reuse_feasible_threshold"]
    actual = BACKTESTS["houston_1801_smith"]["actual_units"]
    assert abs(c.est_units - actual) / actual <= 0.25


def test_no_zoning_district_wording(plans):
    assert "zoning district" not in json.dumps(plans(L).model_dump(mode="json")).lower()
