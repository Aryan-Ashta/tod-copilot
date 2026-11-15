"""QA: green/open space in meeting mode (the homes <-> green-space slider and the park tile) on the demo locales.

Invariants on directions, conservation, bounds and idempotence; xfails mark known bugs (see QA-GREENSPACE-n in the
QA report), each asserting the correct behavior.
"""
import math

import pytest

from backend.data.factors import resolve
from backend.models.rescore import in_plan, rescore
from backend.models.targets import embodied_co2_new_build_avoided, walk_threshold_m
from backend.schemas import Edit

LOCALES = ["houston_downtown", "la_wilshire_koreatown", "brevard_cocoa"]
SWEEP = [0.0, 0.05, 0.25, 0.5, 0.75, 1.0]   # the UI slider steps by 0.05


def S(v):
    return Edit(kind="slider", value=v)


def P(target, tile="park"):
    return Edit(kind="place_tile", tile=tile, target_id=target)


def R(target):
    return Edit(kind="remove_tile", target_id=target)


APPLY = Edit(kind="apply_suggestions")


def _board(plan, edits, from_existing=False):
    return rescore(plan, edits, resolve(plan.locale.id), from_existing).scoreboard


def _targets(r) -> dict:
    return {t.key: t.value for t in (r.steps[-1] if r.steps else r.suggested).targets}


def _new_builds(plan):
    return [s for s in plan.sites if s.kind == "new_build" and in_plan(s)]


def _sites_on(plan, pid):
    return [s for s in plan.sites if in_plan(s) and pid in s.parcel_ids]


def _empty_parcel(plan) -> str:
    """Nearest parcel to the first new build that holds no site, is outside the flood zone and has a centroid."""
    pre = plan.precomputed
    taken = {p for s in plan.sites for p in s.parcel_ids}
    at = pre.centroid[_new_builds(plan)[0].parcel_ids[0]]
    cands = [p.id for p in plan.parcels if p.id not in taken and p.id in pre.centroid and not pre.in_flood.get(p.id)]
    return min(cands, key=lambda p: ((pre.centroid[p][0] - at[0]) ** 2 + (pre.centroid[p][1] - at[1]) ** 2, p))


def _homes_lacking_park(b) -> float:
    return b.homes * (100 - b.walk_by_amenity_pct["park"]) / 100


# ---------------------------------------------------------------- slider


@pytest.mark.parametrize("lid", LOCALES)
def test_slider_zero_none_and_negative_leave_the_plan_unchanged(plans, lid):
    p = plans(lid)
    base = _board(p, [])
    for e in (S(0.0), S(-1.0), Edit(kind="slider")):
        assert _board(p, [e]) == base


@pytest.mark.parametrize("lid", LOCALES)
def test_slider_above_one_clamps_to_one(plans, lid):
    p = plans(lid)
    assert _board(p, [S(2.0)]) == _board(p, [S(1.0)])


@pytest.mark.parametrize("lid", LOCALES)
def test_slider_scoreboard_bounds(plans, lid):
    p = plans(lid)
    for v in [-1.0, *SWEEP, 2.0]:
        r = rescore(p, [S(v)], resolve(lid))
        b = r.scoreboard
        nums = [b.homes, b.affordable_homes, b.funding_required_usd, b.transport_co2_tonnes_per_year,
                b.embodied_co2_saved_tonnes, b.walk_access_pct, *b.walk_by_amenity_pct.values(), *_targets(r).values()]
        assert all(x is not None and math.isfinite(x) and x >= 0 for x in nums)
        assert 0 <= b.walk_access_pct <= 100 and all(0 <= x <= 100 for x in b.walk_by_amenity_pct.values())
        assert 0 <= _targets(r)["flood_exposure"] <= 100
        assert b.affordable_homes <= b.homes


@pytest.mark.parametrize("lid", LOCALES)
def test_more_green_space_never_adds_homes_affordable_homes_or_transit_co2_avoided(plans, lid):
    p = plans(lid)
    boards = [_board(p, [S(v)]) for v in SWEEP]
    for a, b in zip(boards, boards[1:]):
        assert b.homes <= a.homes
        assert b.affordable_homes <= a.affordable_homes
        assert b.transport_co2_tonnes_per_year <= a.transport_co2_tonnes_per_year
    # every demo locale has in-plan new builds, so a full slider must give some of their homes up to open space
    assert _new_builds(p)
    assert boards[-1].homes < boards[0].homes
    assert boards[-1].transport_co2_tonnes_per_year < boards[0].transport_co2_tonnes_per_year
    assert boards[-1].funding_required_usd != boards[0].funding_required_usd


@pytest.mark.parametrize("lid", LOCALES)
def test_more_green_space_never_adds_homes_without_a_park(plans, lid):
    p = plans(lid)
    lacking = [_homes_lacking_park(_board(p, [S(v)])) for v in SWEEP]
    tol = 0.0005 * _board(p, []).homes + 1e-9   # walk_by_amenity_pct is rounded to 0.1 %
    assert all(b <= a + tol for a, b in zip(lacking, lacking[1:]))


@pytest.mark.parametrize("lid", LOCALES)
@pytest.mark.parametrize("v", [0.05, 0.5, 1.0])
def test_slider_takes_its_share_from_new_builds_only(plans, lid, v):
    p = plans(lid)
    f = resolve(lid)
    after = {s["id"]: s for s in rescore(p, [S(v)], f).plan_patch["sites"]}
    share = v * f["slider_max_open_space_share"]
    for s in p.sites:
        h = after[s.id]["homes"]
        if s.kind == "new_build" and in_plan(s):
            # the open-space share of the site's homes, within one home of rounding
            assert s.homes * (1 - share) - 1 <= h <= s.homes * (1 - share)
        else:
            assert h == s.homes


@pytest.mark.parametrize("lid", LOCALES)
@pytest.mark.parametrize("v", [0.05, 0.5, 1.0])
def test_slider_keeps_scoreboard_and_stacks_consistent(plans, lid, v):
    """homes / affordable homes / funding on the scoreboard are the sums of the edited sites and their stacks."""
    p = plans(lid)
    r = rescore(p, [S(v)], resolve(lid))
    sites, stacks = r.plan_patch["sites"], {x["site_id"]: x for x in r.plan_patch["stacks"]}
    b = r.scoreboard
    assert b.homes == sum(s["homes"] or 0 for s in sites if s["status"] in ("pursue", "watch"))
    funded = [stacks[s["id"]] for s in sites if s["status"] == "pursue" and s["id"] in stacks]
    for s in sites:
        if s["id"] in stacks and s["status"] in ("pursue", "watch"):
            assert stacks[s["id"]]["units"] == s["homes"]
            assert 0 <= stacks[s["id"]]["affordable_units"] <= stacks[s["id"]]["units"]
    assert b.affordable_homes == sum(x["affordable_units"] for x in funded)
    assert b.funding_required_usd == pytest.approx(sum(max(x["funding_required_usd"], 0.0) for x in funded), abs=0.05)


def _slider_forgone_homes(p, r) -> int:
    """In-plan new-build homes the edits took away (the agents' plan minus the rescored plan)."""
    after = {s["id"]: s["homes"] or 0 for s in r.plan_patch["sites"]
             if s["kind"] == "new_build" and s["status"] in ("pursue", "watch")}
    return sum((s.homes or 0) - after.get(s.id, 0) for s in _new_builds(p))


@pytest.mark.parametrize("lid", LOCALES)
@pytest.mark.parametrize("v", [0.0, 0.5, 1.0])
def test_embodied_carbon_saved_is_reuse_savings_plus_new_construction_given_up(plans, lid, v):
    """Scoreboard embodied CO2 saved == the reuse model's per-building savings over the plan's conversion sites
    + the embodied carbon of the new-build homes the slider gave up to green space (design decision D1)."""
    p = plans(lid)
    f = resolve(lid)
    cand = {c.building_id: c for c in p.conversions}
    conv = [cand[s.building_id] for s in p.sites
            if s.kind == "conversion" and in_plan(s) and s.building_id in cand
            and cand[s.building_id].best_use != "keep_current" and cand[s.building_id].embodied_co2_saved_tonnes]
    r = rescore(p, [S(v)], f)
    expected = sum(c.embodied_co2_saved_tonnes for c in conv) + embodied_co2_new_build_avoided(_slider_forgone_homes(p, r), f)
    assert r.scoreboard.embodied_co2_saved_tonnes == pytest.approx(expected, abs=0.05 * len(conv) + 0.1)


@pytest.mark.parametrize("lid", LOCALES)
def test_more_green_space_raises_embodied_carbon_saved(plans, lid):
    """D1: new construction given up to green space counts as embodied CO2 saved, so it rises strictly with the slider."""
    p = plans(lid)
    assert sum(s.homes or 0 for s in _new_builds(p))
    saved = [_board(p, [S(v)]).embodied_co2_saved_tonnes for v in SWEEP]
    assert all(b > a for a, b in zip(saved, saved[1:])), saved


@pytest.mark.parametrize("lid", LOCALES)
@pytest.mark.parametrize("v", [0.05, 1.0])
def test_slider_after_apply_suggestions_from_existing_matches_slider_on_the_agents_plan(plans, lid, v):
    p = plans(lid)
    assert _board(p, [APPLY, S(v)], from_existing=True) == _board(p, [S(v)])


@pytest.mark.parametrize("lid", LOCALES)
def test_slider_on_existing_conditions_has_nothing_to_shrink(plans, lid):
    p = plans(lid)
    assert _board(p, [S(1.0)], from_existing=True) == _board(p, [], from_existing=True)


@pytest.mark.parametrize("lid", LOCALES)
def test_removing_a_tile_keeps_the_slider(plans, lid):
    p = plans(lid)
    e = _empty_parcel(p)
    assert _board(p, [P(e), S(0.5), R(e)]) == _board(p, [S(0.5)])
    assert _board(p, [S(0.5), P(e), R(e)]) == _board(p, [S(0.5)])


@pytest.mark.parametrize("lid", LOCALES)
def test_last_slider_value_wins(plans, lid):
    p = plans(lid)
    assert _board(p, [S(0.5), S(0.5)]) == _board(p, [S(0.5)])
    assert _board(p, [S(1.0), S(0.0)]) == _board(p, [])


@pytest.mark.parametrize("lid", LOCALES)
def test_slider_applies_to_suggestions_brought_in_later(plans, lid):
    p = plans(lid)
    assert _board(p, [S(0.5), APPLY], from_existing=True) == _board(p, [APPLY, S(0.5)], from_existing=True)


@pytest.mark.parametrize("lid", LOCALES)
def test_slider_applies_to_homes_tiles_placed_later(plans, lid):
    p = plans(lid)
    pre = p.precomputed
    taken = {x for s in p.sites for x in s.parcel_ids}
    q = min(x for x, h in pre.homes_by_parcel.items() if h and x not in taken and not pre.in_flood.get(x))
    assert _board(p, [S(0.5), P(q, "homes")]) == _board(p, [P(q, "homes"), S(0.5)])


@pytest.mark.parametrize("lid", LOCALES)
def test_more_green_space_shrinks_new_build_rooftop_solar(plans, lid):
    p = plans(lid)
    f = resolve(lid)
    assert _new_builds(p)
    assert _targets(rescore(p, [S(1.0)], f))["rooftop_solar"] < _targets(rescore(p, [S(0.0)], f))["rooftop_solar"]


@pytest.mark.parametrize("lid", LOCALES)
def test_smallest_slider_step_does_not_create_park_access(plans, lid):
    """At 0.05 the open space is 1.5 % of each lot (<= 1,764 sqft on the demo sites): not a park."""
    p = plans(lid)
    f = resolve(lid)
    thr = walk_threshold_m(f)
    far = [s for s in _new_builds(p) if (p.precomputed.walk_m.get(s.parcel_ids[0], {}).get("park") or math.inf) > thr]
    if not far:
        pytest.skip("every new build already has a park within the walk threshold")
    # The slider also removes homes, so compare the far sites' (shrunk) homes, not the base count: all still lack a park.
    r = rescore(p, [S(0.05)], f)
    far_ids = {s.id for s in far}
    far_homes = sum(s["homes"] or 0 for s in r.plan_patch["sites"] if s["id"] in far_ids)
    assert far_homes > 0
    assert _homes_lacking_park(r.scoreboard) >= far_homes - 0.5


@pytest.mark.parametrize("lid", LOCALES)
def test_nan_slider_changes_nothing(plans, lid):
    p = plans(lid)
    assert _board(p, [S(float("nan"))]) == _board(p, [])


# ---------------------------------------------------------------- park tile


@pytest.mark.parametrize("lid", LOCALES)
def test_park_on_an_empty_parcel_only_improves_walks(plans, lid):
    p = plans(lid)
    f = resolve(lid)
    e = _empty_parcel(p)
    r0, r1 = rescore(p, [], f), rescore(p, [P(e)], f)
    a, b = r0.scoreboard, r1.scoreboard
    assert r1.rejected is None
    for k in ("homes", "affordable_homes", "funding_required_usd", "transport_co2_tonnes_per_year",
              "embodied_co2_saved_tonnes"):
        assert getattr(b, k) == getattr(a, k)
    assert _targets(r1)["rooftop_solar"] == _targets(r0)["rooftop_solar"]
    assert b.walk_by_amenity_pct["park"] >= a.walk_by_amenity_pct["park"]
    assert b.walk_access_pct >= a.walk_access_pct
    assert {k: b.walk_by_amenity_pct[k] for k in ("clinic", "grocery")} == \
           {k: a.walk_by_amenity_pct[k] for k in ("clinic", "grocery")}


@pytest.mark.parametrize("lid", LOCALES)
def test_repeated_park_on_one_parcel_scores_once(plans, lid):
    p = plans(lid)
    e = _empty_parcel(p)
    assert _board(p, [P(e), P(e)]) == _board(p, [P(e)])


@pytest.mark.parametrize("lid", LOCALES)
def test_repeated_park_on_one_parcel_proposes_one_park(plans, lid):
    p = plans(lid)
    e = _empty_parcel(p)
    added = rescore(p, [P(e), P(e)], resolve(lid)).plan_patch["infrastructure_added"]
    assert sum(1 for x in added if x["attrs"].get("parcel_id") == e) == 1


@pytest.mark.parametrize("lid", LOCALES)
def test_removing_a_park_restores_the_plan(plans, lid):
    p = plans(lid)
    e = _empty_parcel(p)
    assert _board(p, [P(e), R(e)]) == _board(p, [])


@pytest.mark.parametrize("lid", LOCALES)
def test_park_on_a_new_build_parcel_removes_exactly_that_site(plans, lid):
    p = plans(lid)
    f = resolve(lid)
    site = _new_builds(p)[0]
    pid = site.parcel_ids[0]
    gone = _sites_on(p, pid)
    stacks = {x.site_id: x for x in p.stacks}
    funded = [stacks[s.id] for s in gone if s.status == "pursue" and s.id in stacks]
    r0, r1 = rescore(p, [], f), rescore(p, [P(pid)], f)
    a, b = r0.scoreboard, r1.scoreboard
    assert a.homes - b.homes == sum(s.homes or 0 for s in gone)
    assert a.affordable_homes - b.affordable_homes == sum(x.affordable_units for x in funded)
    assert a.funding_required_usd - b.funding_required_usd == pytest.approx(
        sum(max(x.funding_required_usd, 0.0) for x in funded), abs=0.05)
    assert b.transport_co2_tonnes_per_year <= a.transport_co2_tonnes_per_year
    assert _targets(r1)["rooftop_solar"] < _targets(r0)["rooftop_solar"]
    assert b.embodied_co2_saved_tonnes == pytest.approx(
        a.embodied_co2_saved_tonnes + embodied_co2_new_build_avoided(sum(s.homes or 0 for s in gone if s.kind == "new_build"), f),
        abs=0.1)


@pytest.mark.parametrize("lid", LOCALES)
def test_park_on_a_conversion_parcel_drops_its_homes_and_reuse_savings(plans, lid):
    p = plans(lid)
    conv = [s for s in p.sites if s.kind == "conversion" and s.status == "pursue" and s.parcel_ids]
    if not conv:
        pytest.skip("no pursued conversion in this locale's plan")
    pid = conv[0].parcel_ids[0]
    gone = _sites_on(p, pid)
    cand = {c.building_id: c for c in p.conversions}
    saved = sum(cand[s.building_id].embodied_co2_saved_tonnes or 0 for s in gone
                if s.kind == "conversion" and s.building_id in cand and cand[s.building_id].best_use != "keep_current")
    a, b = _board(p, []), _board(p, [P(pid)])
    assert a.homes - b.homes == sum(s.homes or 0 for s in gone)
    assert a.embodied_co2_saved_tonnes - b.embodied_co2_saved_tonnes == pytest.approx(saved, abs=0.05 * len(gone) + 0.1)
    assert b.embodied_co2_saved_tonnes < a.embodied_co2_saved_tonnes


@pytest.mark.parametrize("lid", LOCALES)
def test_park_on_a_flood_parcel_is_allowed_and_adds_no_homes(plans, lid):
    p = plans(lid)
    pre = p.precomputed
    taken = {x for s in p.sites for x in s.parcel_ids}
    fl = sorted(x.id for x in p.parcels if pre.in_flood.get(x.id) and x.id in pre.centroid and x.id not in taken)
    assert fl
    r = rescore(p, [P(fl[0])], resolve(lid))
    assert r.rejected is None
    assert r.scoreboard.homes == _board(p, []).homes
    assert r.scoreboard.walk_by_amenity_pct["park"] >= _board(p, []).walk_by_amenity_pct["park"]


@pytest.mark.parametrize("lid", LOCALES)
def test_park_on_a_new_build_parcel_and_slider_commute(plans, lid):
    p = plans(lid)
    pid = _new_builds(p)[0].parcel_ids[0]
    assert _board(p, [P(pid), S(0.5)]) == _board(p, [S(0.5), P(pid)])
