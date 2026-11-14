import pytest

from backend.data.factors import resolve
from backend.models import finance, goals
from backend.schemas import PlanGoals, Site

F = resolve("houston_downtown")
GEOM = {"type": "Point", "coordinates": [0, 0]}


def _cands(land_costs: dict[str, float], homes: int = 100) -> list[tuple[Site, dict]]:
    out = []
    for sid, land in land_costs.items():
        s = Site(id=sid, kind="new_build", parcel_ids=[sid], building_id=None, geometry=GEOM, homes=homes,
                 height_ft=60, status="pursue")
        out.append((s, finance.capital_stack(sid, finance.new_build_pro_forma(homes, land, F), F)[1]))
    return out


def _final_stacks(cands, sel):
    return [sel.restacked[s.id][0] if s.id in sel.restacked else finance.capital_stack(s.id, m, F)[0]
            for s, m in cands if s.id in sel.selected]


def test_cheapest_funding_required_per_affordable_home_first_and_stops_at_goal():
    cands = _cands({"a": 20e6, "b": 10e6, "c": 1e6})    # "c" requires the least funding
    assert all(m["funding_required_usd"] > 0 for _, m in cands)
    a0 = cands[0][1]["affordable_units"]
    sel = goals.select_sites(cands, PlanGoals(affordable_homes=a0 + 1), F)
    assert sel.selected == ["c", "b"] and not sel.raised


def test_share_raised_to_reach_goal_exactly():
    cands = _cands({"a": 20e6, "b": 10e6, "c": 1e6})
    goal = sum(m["affordable_units"] for _, m in cands) + 50
    sel = goals.select_sites(cands, PlanGoals(affordable_homes=goal), F)
    assert sorted(sel.selected) == ["a", "b", "c"] and sel.raised
    assert sum(x.affordable_units for x in _final_stacks(cands, sel)) == goal
    assert all(new <= 100 for _, new in sel.raised.values())


def test_unreachable_goal_reported_short():
    cands = _cands({"a": 20e6, "b": 10e6})
    sel = goals.select_sites(cands, PlanGoals(affordable_homes=1000), F)
    stacks = _final_stacks(cands, sel)
    assert sum(x.affordable_units for x in stacks) == 200
    rep = goals.report([s for s, _ in cands], stacks, PlanGoals(affordable_homes=1000), None, None)
    row = next(r for r in rep.goals if r.key == "affordable_homes")
    assert row.met is False and row.achieved == 200 and len(rep.notes) == 1
    assert rep.housing_funding_required_usd == pytest.approx(sum(max(x.funding_required_usd, 0) for x in stacks),
                                                             abs=0.05)


def test_with_affordable_value_is_linear_in_count():
    pf = finance.new_build_pro_forma(100, 5e6, F)
    k0, k = pf["affordable_units"], 60
    d = (k - k0) * (F["rent_usd_per_unit_month"] - F["affordable_rent_usd_per_unit_month"]) * 12 \
        * (1 - F["vacancy_rate"] - F["opex_ratio"]) / F["cap_rate"]
    assert finance.with_affordable(pf, k, F)["value_usd"] == pytest.approx(pf["value_usd"] - d)
    assert finance.with_affordable(pf, 500, F)["affordable_units"] == 100
