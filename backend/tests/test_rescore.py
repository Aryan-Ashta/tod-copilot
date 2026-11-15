import time

from backend.data.factors import resolve
from backend.models.rescore import new_build_stack, rescore
from backend.schemas import Edit, Route, Stop
from backend.tests.test_rescore_perf import EDITS, P, synthetic_plan

LINE = {"type": "LineString", "coordinates": [[-95.39, 29.71], [-95.38, 29.72]]}


def plan_with_network(n_parcels=200, n_buildings=20):
    """synthetic_plan with priced sites and a transit network: rail + bus kept, one bus upgraded, one feeder."""
    plan, f = synthetic_plan(n_parcels, n_buildings), resolve("houston_downtown")
    parcels = {p.id: p for p in plan.parcels}
    stacks = [res[0] for s in plan.sites if (res := new_build_stack(s, parcels, f, plan.locale.id))]
    routes = [Route(id="rail-R", kind="rail_existing", geometry=LINE, headway_min=10, phase=0, annual_operating_cost_usd=0),
              Route(id="bus-B", kind="bus_existing", geometry=LINE, headway_min=30, phase=0, annual_operating_cost_usd=0),
              Route(id="upg-U", kind="frequent_bus", geometry=LINE, headway_min=12, phase=1,
                    annual_operating_cost_usd=2e5),
              Route(id="fdr-0-abc", kind="frequent_bus", geometry=LINE, headway_min=12, phase=2,
                    annual_operating_cost_usd=8e5)]
    stops = [Stop(id="gtfs-1", lonlat=(-95.39, 29.71), route_ids=["R", "U"], riders_per_day_low=10,
                  riders_per_day_high=20, prov=P),
             Stop(id="fdr-0-abc-s0", lonlat=(-95.38, 29.72), route_ids=["fdr-0-abc"], riders_per_day_low=5,
                  riders_per_day_high=9, prov=P)]
    transit = plan.transit.model_copy(update={"routes": routes, "stops": stops})
    return plan.model_copy(update={"stacks": stacks, "transit": transit}), f


def test_from_existing_starts_empty():
    plan, f = plan_with_network()
    r = rescore(plan, [], f, from_existing=True)
    assert r.scoreboard.homes == 0 and r.plan_patch["sites"] == [] and r.steps == []
    assert r.scoreboard == r.existing.scoreboard
    t = r.plan_patch["transit"]
    assert {x["kind"] for x in t["routes"]} <= {"rail_existing", "bus_existing"}
    assert {x["id"] for x in t["routes"]} == {"rail-R", "bus-B", "bus-U"}   # upgraded route back as existing bus
    assert [s["id"] for s in t["stops"]] == ["gtfs-1"]                       # feeder stop dropped, feed stop kept
    assert t["coverage_pct"] == plan.transit.coverage_baseline_pct


def test_apply_suggestions_reaches_the_agents_plan():
    plan, f = plan_with_network()
    base = rescore(plan, [], f)
    r = rescore(plan, [Edit(kind="apply_suggestions")], f, from_existing=True)
    assert r.scoreboard == r.suggested.scoreboard == base.scoreboard
    assert all(v == 0 for v in r.deltas.values())
    assert [s["id"] for s in r.plan_patch["sites"]] == [s.id for s in plan.sites]
    assert r.plan_patch["transit"] == plan.transit.model_dump(mode="json")
    twice = rescore(plan, [Edit(kind="apply_suggestions")] * 2, f, from_existing=True)
    assert twice.steps[1] == twice.steps[0] and twice.plan_patch["sites"] == r.plan_patch["sites"]
    noop = rescore(plan, [Edit(kind="apply_suggestions")], f)
    assert noop.scoreboard == base.scoreboard and noop.plan_patch["sites"] == base.plan_patch["sites"]


def test_tile_before_suggestions_is_not_duplicated():
    plan, f = plan_with_network()
    edits = [Edit(kind="place_tile", tile="homes", target_id="p1"),   # site s0 of the agents sits on p1
             Edit(kind="place_tile", tile="stop", target_id="p30"),
             Edit(kind="apply_suggestions")]
    r = rescore(plan, edits, f, from_existing=True)
    on_p1 = [s["id"] for s in r.plan_patch["sites"] if "p1" in s["parcel_ids"]]
    assert on_p1 == ["tile-p1"]
    assert len(r.plan_patch["sites"]) == len(plan.sites)
    assert [s["id"] for s in r.plan_patch["transit"]["stops"]] == ["gtfs-1", "fdr-0-abc-s0", "tile-stop-p30"]


def test_slider_counts_unbuilt_new_build_carbon_as_saved():
    plan, f = plan_with_network()   # five new builds of 120 homes; the slider at 1.0 leaves floor(120 x 0.7) = 84
    apply = [Edit(kind="apply_suggestions")]
    per_home = f["avg_unit_sqft_residential"] * f["embodied_co2_kg_per_sqft_new"] / 1000
    base = rescore(plan, apply, f, from_existing=True).scoreboard
    full = rescore(plan, [*apply, Edit(kind="slider", value=1.0)], f, from_existing=True).scoreboard
    assert base.homes - full.homes == 5 * 36
    assert abs(full.embodied_co2_saved_tonnes - base.embodied_co2_saved_tonnes - 5 * 36 * per_home) < 0.06
    assert rescore(plan, [*apply, Edit(kind="slider", value=0.0)], f, from_existing=True).scoreboard == base
    # a park on p1 removes site s0: its unbuilt homes stop counting
    parked = rescore(plan, [*apply, Edit(kind="slider", value=1.0), Edit(kind="place_tile", tile="park", target_id="p1")],
                     f, from_existing=True).scoreboard
    assert abs(parked.embodied_co2_saved_tonnes - base.embodied_co2_saved_tonnes - 4 * 36 * per_home) < 0.06


def test_steps_match_prefix_replays():
    plan, f = plan_with_network()
    edits = [Edit(kind="apply_suggestions"), *EDITS[:4],
             Edit(kind="place_tile", tile="homes", target_id="p10"),   # flood: invalid, repeats the previous step
             Edit(kind="remove_tile", target_id="p2"), Edit(kind="slider", value=0.3)]
    for fe in (False, True):
        r = rescore(plan, edits, f, from_existing=fe)
        assert len(r.steps) == len(edits) and r.steps[-1].scoreboard == r.scoreboard
        assert r.steps[5] == r.steps[4]
        for i in range(len(edits)):
            assert r.steps[i].scoreboard == rescore(plan, edits[:i + 1], f, from_existing=fe).scoreboard
    last = rescore(plan, edits[:6], f, from_existing=True)
    assert last.rejected and last.rejected.edit_index == 5 and last.scoreboard == last.steps[4].scoreboard


def test_thirty_edits_under_300ms():
    plan, f = synthetic_plan(), resolve("houston_downtown")
    edits = [Edit(kind="apply_suggestions")] + [Edit(kind="place_tile", tile=("homes", "park", "stop")[i % 3],
                                                     target_id=f"p{200 + i}") for i in range(29)]
    r = rescore(plan, edits, f, from_existing=True)  # warm lookups, as the API does on plan load
    assert len(r.steps) == 30
    best = float("inf")
    for _ in range(3):
        t = time.perf_counter()
        rescore(plan, edits, f, from_existing=True)
        best = min(best, time.perf_counter() - t)
    assert best < 0.3
