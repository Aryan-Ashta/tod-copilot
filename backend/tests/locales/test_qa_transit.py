"""QA invariants for the transit network, infrastructure readiness and the transport/solar/flood targets on the
three demo locales (docs/11). Directions and relationships only; numbers come from the models.

Strict xfails mark behaviour judged wrong (QA-TRANSIT-<n>, see the QA report); a fix flips them to passing.
"""
import math
import statistics

import h3
import pytest
from pyproj import Transformer

from backend.agents import infrastructure as infra_agent
from backend.agents import transit_network
from backend.agents.context import RunContext
from backend.data.factors import resolve
from backend.data.geo import lonlat_dist_m
from backend.data.locales import get_locale
from backend.data.resolver import Capability, default_resolver
from backend.models import infrastructure as infra
from backend.models import transit
from backend.models.rescore import in_plan, rescore, score_plan, site_target
from backend.models.targets import households_near_frequent, rooftop_solar, transport_co2, walk_threshold_m
from backend.schemas import Edit

H, LA, B = "houston_downtown", "la_wilshire_koreatown", "brevard_cocoa"
LOCALES = (H, LA, B)
EXISTING_KINDS = ("rail_existing", "bus_existing")


def xf(lid: str, reason: str):
    return pytest.param(lid, marks=pytest.mark.xfail(strict=True, reason=reason))


# ---------------------------------------------------------------- helpers
_AGENT: dict = {}


def agent_inputs(lid: str):
    """What the infrastructure and transit agents compute from, for one locale: the RunContext after the
    infrastructure agent and the transit agent's demand + existing-GTFS steps (walk graph, demand grid, feed), and
    the readiness measurements the infrastructure agent passed to models/infrastructure.readiness."""
    if lid not in _AGENT:
        got = {}
        real = infra_agent.readiness_model

        def spy(measures, f):
            got["measures"] = measures
            return real(measures, f)
        ctx = RunContext(locale=get_locale(lid), prompt="", resolver=default_resolver(), f=resolve(lid),
                         emit=lambda e: None)
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr(infra_agent, "readiness_model", spy)
            infra_agent.run(ctx)
        get_demand, get_existing = transit_network.tools(ctx)[:2]
        get_demand()
        get_existing()
        _AGENT[lid] = (ctx, got["measures"])
    return _AGENT[lid]


def to_lonlat_for(ctx):
    back = Transformer.from_crs(ctx.locale.utm_epsg, 4326, always_xy=True)
    return lambda x, y: tuple(round(v, 6) for v in back.transform(x, y))


def candidates_for(ctx):
    stations = [{"name": s.name, "lonlat": s.lonlat} for s in ctx.locale.stations]
    to_ll = to_lonlat_for(ctx)
    return transit.candidates(ctx.cache["existing"], ctx.cache["grid"], ctx.graph, stations, ctx.f,
                              ctx.locale.utm_epsg, to_ll), to_ll


def feed(lid: str) -> dict:
    return default_resolver().get(get_locale(lid), Capability.TRANSIT_EXISTING).value


def homes_by_target(plan) -> dict[str, int]:
    out: dict[str, int] = {}
    for s in plan.sites:
        if in_plan(s) and s.homes:
            out[site_target(s)] = out.get(site_target(s), 0) + s.homes
    return out


def lookups(plan):
    return ({b.id: b.rentable_area_sqft.value for b in plan.buildings},
            {b.id: b.roof_area_sqft.value for b in plan.buildings},
            {p.id: p.area_acres.value for p in plan.parcels})


def score(plan, f, kwh="plan", roof_scale=1.0, homes_scale=1):
    rentable, roof, acres = lookups(plan)
    sites = [s.model_copy(update={"homes": s.homes * homes_scale}) for s in plan.sites]
    targets, _ = score_plan(sites, plan.stacks, {c.building_id: c for c in plan.conversions}, rentable,
                            {k: (v * roof_scale if v else v) for k, v in roof.items()},
                            {k: (v * roof_scale if v else v) for k, v in acres.items()}, plan.precomputed.walk_m,
                            plan.precomputed.in_flood,
                            plan.precomputed.solar_kwh_per_kw_year if kwh == "plan" else kwh, f)
    return {t.key: t.value for t in targets}


def proposed_only(plan, stop) -> bool:
    """A stop is proposed when every route it serves is a new route (models/rescore.existing_transit)."""
    new_ids = {r.id for r in plan.transit.routes if r.kind not in EXISTING_KINDS}
    return bool(stop.route_ids) and set(stop.route_ids) <= new_ids


def reached_demand(cells, stops_ll, radius) -> float:
    return sum(c["demand"] for c in cells if any(lonlat_dist_m(tuple(c["lonlat"]), s) <= radius for s in stops_ll))


def uncovered_stop_parcel(plan, f, lid):
    """Parcel whose stop catchment holds demand that no stop (feed or plan) reaches: (demand gained, parcel id)."""
    cat = f["stop_catchment_m"]
    stops = [tuple(s["geometry"]["coordinates"]) for s in feed(lid)["stops"]] + [s.lonlat for s in plan.transit.stops]
    far = [c for c in plan.precomputed.demand_cells
           if c["demand"] > 0 and min(lonlat_dist_m(tuple(c["lonlat"]), s) for s in stops) > 1.1 * cat]
    best = None
    for p in sorted(plan.parcels, key=lambda p: p.id):
        ll = plan.precomputed.centroid.get(p.id)
        if ll is None:
            continue
        gain = sum(c["demand"] for c in far if lonlat_dist_m(tuple(c["lonlat"]), ll) <= 0.9 * cat)
        if gain > 0 and (best is None or gain > best[0]):
            best = (gain, p.id)
    return best


def parcel_nearest_busy_stop(plan):
    """Parcel whose centroid is closest to a stop with riders: a stop there shares cells other stops already serve."""
    busy = [s.lonlat for s in plan.transit.stops if s.riders_per_day_high > 0]
    pids = {p.id for p in plan.parcels}
    return min((min(lonlat_dist_m(ll, s) for s in busy), pid) for pid, ll in sorted(plan.precomputed.centroid.items())
               if pid in pids)[1]


# ---------------------------------------------------------------- transit: ridership
@pytest.mark.parametrize("lid", LOCALES)
def test_ridership_ranges_ordered_finite_nonnegative(plans, lid):
    stops = plans(lid).transit.stops
    assert stops
    for s in stops:
        assert math.isfinite(s.riders_per_day_low) and math.isfinite(s.riders_per_day_high)
        assert 0 <= s.riders_per_day_low <= s.riders_per_day_high, s.id


@pytest.mark.parametrize("lid", LOCALES)
def test_ridership_never_exceeds_the_demand_its_stops_reach(plans, lid):
    """Each cell's demand is split among the stops covering it, so the network total is rate x reached demand."""
    p, f = plans(lid), resolve(lid)
    cells = p.precomputed.demand_cells
    reach = reached_demand(cells, [s.lonlat for s in p.transit.stops], 1.01 * f["stop_catchment_m"])
    for key, rate in (("riders_per_day_low", f["ridership_rate_low"]), ("riders_per_day_high", f["ridership_rate_high"])):
        total = sum(getattr(s, key) for s in p.transit.stops)
        assert 0 < total / rate <= reach * 1.01 + 1, key
    assert reach <= sum(c["demand"] for c in cells)


@pytest.mark.parametrize("lid", [
    xf(H, "QA-TRANSIT-3: stops get 0 riders/day when no H3 cell centroid lies within 400 m (110 of 274 stops)"),
    xf(LA, "QA-TRANSIT-3: Wilshire/Vermont Station and 47 other stops show 0 riders/day inside busy cells"),
    xf(B, "QA-TRANSIT-3: 9 stops in cells with demand show 0 riders/day")])
def test_stop_inside_a_cell_with_demand_has_riders(plans, lid):
    p = plans(lid)
    demand = {c["h3"]: c["demand"] for c in p.precomputed.demand_cells}
    zero = [s.name or s.id for s in p.transit.stops
            if s.riders_per_day_high == 0 and demand.get(h3.latlng_to_cell(s.lonlat[1], s.lonlat[0], transit.H3_RES), 0) > 0]
    assert not zero


@pytest.mark.parametrize("lid", [H, LA, xf(B, "QA-TRANSIT-4: a count is suggested at a stop of a proposed feeder "
                                                "that does not run yet")])
def test_measurements_count_at_stops_that_exist_today(plans, lid):
    p = plans(lid)
    stops = {s.id: s for s in p.transit.stops}
    assert p.transit.measurements
    for m in p.transit.measurements:
        s = stops[m.target_id]
        assert s.riders_per_day_high > s.riders_per_day_low
        assert not proposed_only(p, s), m.what


# ---------------------------------------------------------------- transit: coverage, cost, selection
@pytest.mark.parametrize("lid", LOCALES)
def test_coverage_bounded_and_never_below_baseline(plans, lid):
    t = plans(lid).transit
    assert 0 <= t.coverage_baseline_pct <= t.coverage_pct <= 100
    assert t.coverage_goal_pct == resolve(lid)["transit_coverage_goal_pct"]


def test_coverage_shortfall_is_reported_where_the_goal_is_missed(plans):
    p = plans(B)
    gr = {g.key: g for g in p.goals_report.goals}["transit_coverage"]
    assert p.transit.coverage_pct < p.transit.coverage_goal_pct
    assert gr.achieved == p.transit.coverage_pct and gr.met is False


@pytest.mark.parametrize("lid", LOCALES)
def test_operating_cost_adds_up_and_only_new_service_costs(plans, lid):
    p = plans(lid)
    t = p.transit
    for r in t.routes:
        assert math.isfinite(r.annual_operating_cost_usd)
        if r.kind in EXISTING_KINDS:
            assert r.annual_operating_cost_usd == 0 and r.phase == 0, r.id
        else:
            assert r.annual_operating_cost_usd > 0 and r.phase >= 1, r.id
    assert sum(r.annual_operating_cost_usd for r in t.routes) == pytest.approx(t.annual_operating_cost_usd, abs=0.05)
    assert p.goals_report.transit_operating_usd_per_year == pytest.approx(t.annual_operating_cost_usd, abs=0.05)
    assert (t.annual_operating_cost_usd > 0) == any(r.kind not in EXISTING_KINDS for r in t.routes)


@pytest.mark.parametrize("lid", (H, B))
def test_frequency_upgrade_shortens_headway_and_costs_more_the_more_frequent(plans, lid):
    p, f = plans(lid), resolve(lid)
    routes = {r["properties"]["route_id"]: r["properties"] for r in feed(lid)["routes"]}
    upg = [r for r in p.transit.routes if r.id.startswith("upg-")]
    assert upg
    for r in upg:
        old = routes[r.id.removeprefix("upg-")]
        old_hw, cyc = old["peak_headway_min"], old["cycle_time_h"]
        assert r.headway_min < old_hw
        assert r.annual_operating_cost_usd == pytest.approx(transit.upgrade_cost(cyc, old_hw, r.headway_min, f), abs=0.05)
        ladder = [transit.upgrade_cost(cyc, old_hw, hw, f) for hw in (old_hw, *(h for h in (20, 15, 10, 5) if h < old_hw))]
        assert len(ladder) >= 2 and ladder[0] == 0 and all(a < b for a, b in zip(ladder, ladder[1:]))


def test_brevard_upgrades_an_existing_route_and_phases_station_feeders_later(plans):
    p = plans(B)
    upg = [r for r in p.transit.routes if r.id.startswith("upg-")]
    feeders = [r for r in p.transit.routes if r.id.startswith("fdr-")]
    assert upg and feeders
    assert p.locale.stations[0].mode == "intercity_rail_planned"
    assert min(r.phase for r in feeders) > max(r.phase for r in upg)
    ids = [r.id for r in p.transit.routes]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("lid", [xf(H, "QA-TRANSIT-1: feeder ids use h3[-6:], nearly constant: ids collide"), LA,
                                 xf(B, "QA-TRANSIT-1: two Brevard feeders share id fdr-0-5fffff")])
def test_transit_candidate_ids_are_unique(lid):
    ctx, _ = agent_inputs(lid)
    ids = [c["id"] for c in candidates_for(ctx)[0]]
    assert len(ids) == len(set(ids))


@pytest.mark.parametrize("lid", [H, xf(B, "QA-TRANSIT-1: a colliding feeder id drops a feeder from the greedy pool "
                                          "(coverage 57.6% instead of 59.7%)")])
def test_network_selection_does_not_depend_on_candidate_ids(plans, lid):
    """Renaming candidates must not change what the greedy picks; the plan also says no remaining route adds
    coverage when it stops short of the goal."""
    ctx, _ = agent_inputs(lid)
    t, f, epsg = plans(lid).transit, ctx.f, ctx.locale.utm_epsg
    cands, to_ll = candidates_for(ctx)
    res = transit.optimize_network(ctx.cache["existing"], ctx.cache["grid"], cands, t.coverage_goal_pct, f, epsg,
                                   lid, to_ll)
    assert res["coverage_pct"] == t.coverage_pct   # same inputs as the agents' plan
    renamed, _ = candidates_for(ctx)
    for i, c in enumerate(renamed):
        if c["type"] != "upgrade":
            c["id"] = f"{c['id']}-{i}"
    res2 = transit.optimize_network(ctx.cache["existing"], ctx.cache["grid"], renamed, t.coverage_goal_pct, f, epsg,
                                    lid, to_ll)
    assert res2["coverage_pct"] == res["coverage_pct"]


# ---------------------------------------------------------------- meeting mode: stop tile
@pytest.mark.parametrize("lid", LOCALES)
def test_stop_tile_never_lowers_coverage_walk_or_transport_co2(plans, lid):
    p, f = plans(lid), resolve(lid)
    gain = uncovered_stop_parcel(p, f, lid)
    pid = gain[1] if gain else parcel_nearest_busy_stop(p)
    r = rescore(p, [Edit(kind="place_tile", tile="stop", target_id=pid)], f)
    assert r.rejected is None
    t = r.plan_patch["transit"]
    assert t["coverage_pct"] >= p.transit.coverage_pct
    assert t["annual_operating_cost_usd"] >= p.transit.annual_operating_cost_usd
    assert r.deltas["transport_co2_tonnes_per_year"] >= 0 and r.deltas["walk_access_pct"] >= 0
    assert r.deltas["homes"] == 0
    new = [s for s in t["stops"] if s["id"] == f"tile-stop-{pid}"]
    assert len(new) == 1 and 0 <= new[0]["riders_per_day_low"] <= new[0]["riders_per_day_high"]


@pytest.mark.parametrize("lid", [xf(H, "QA-TRANSIT-5: a stop tile never updates coverage_pct (docs/05 says it does)"),
                                 xf(B, "QA-TRANSIT-5: a stop tile never updates coverage_pct (docs/05 says it does)")])
def test_stop_tile_on_uncovered_demand_raises_coverage(plans, lid):
    p, f = plans(lid), resolve(lid)
    gain = uncovered_stop_parcel(p, f, lid)
    assert gain and p.transit.coverage_pct < 100
    r = rescore(p, [Edit(kind="place_tile", tile="stop", target_id=gain[1])], f)
    assert r.plan_patch["transit"]["coverage_pct"] > p.transit.coverage_pct


@pytest.mark.parametrize("lid", [xf(H, "QA-TRANSIT-6: a stop tile takes the full demand of cells other stops "
                                       "already share"),
                                 xf(LA, "QA-TRANSIT-6: a stop tile takes the full demand of cells other stops "
                                        "already share")])
def test_stop_tile_next_to_existing_stops_creates_no_riders_from_nothing(plans, lid):
    p, f = plans(lid), resolve(lid)
    pid = parcel_nearest_busy_stop(p)
    r = rescore(p, [Edit(kind="place_tile", tile="stop", target_id=pid)], f)
    stops = r.plan_patch["transit"]["stops"]
    reach = reached_demand(p.precomputed.demand_cells, [tuple(s["lonlat"]) for s in stops], 1.01 * f["stop_catchment_m"])
    total = sum(s["riders_per_day_low"] for s in stops) / f["ridership_rate_low"]
    assert total <= reach * 1.01 + 1


@pytest.mark.parametrize("lid", [xf(H, "QA-TRANSIT-7: placing the same stop twice adds a duplicate stop id"),
                                 xf(B, "QA-TRANSIT-7: placing the same stop twice adds a duplicate stop id")])
def test_stop_tile_is_idempotent(plans, lid):
    p, f = plans(lid), resolve(lid)
    pid = parcel_nearest_busy_stop(p)
    once = rescore(p, [Edit(kind="place_tile", tile="stop", target_id=pid)], f)
    twice = rescore(p, [Edit(kind="place_tile", tile="stop", target_id=pid)] * 2, f)
    assert twice.scoreboard == once.scoreboard
    assert twice.plan_patch["transit"]["stops"] == once.plan_patch["transit"]["stops"]


@pytest.mark.xfail(strict=True, reason="QA-TRANSIT-8: transport CO2 only counts walks to existing frequent stops, so "
                                       "homes beside the plan's own feeder get 0 t")
def test_brevard_homes_beside_a_planned_feeder_stop_avoid_transport_co2(plans):
    p, f = plans(B), resolve(B)
    pre, thr = p.precomputed, walk_threshold_m(f)
    feeder_stops = [s.lonlat for s in p.transit.stops if proposed_only(p, s)]
    assert feeder_stops
    best = None
    for pid, homes in sorted(pre.homes_by_parcel.items()):
        fs = pre.walk_m.get(pid, {}).get("frequent_stop")
        if not homes or pre.in_flood.get(pid) or pid not in pre.centroid or (fs is not None and fs <= thr):
            continue
        d = min(lonlat_dist_m(pre.centroid[pid], s) for s in feeder_stops) * f["walk_detour_factor"]
        if d <= thr / 2 and (best is None or d < best[0]):
            best = (d, pid)
    assert best
    r = rescore(p, [Edit(kind="place_tile", tile="homes", target_id=best[1])], f)
    assert r.rejected is None and r.deltas["homes"] > 0
    assert r.deltas["transport_co2_tonnes_per_year"] > 0


# ---------------------------------------------------------------- targets: transport CO2, solar, flood
@pytest.mark.parametrize("lid", LOCALES)
def test_transport_co2_is_households_within_the_walk_of_frequent_transit(plans, lid):
    p, f = plans(lid), resolve(lid)
    homes, walk = homes_by_target(p), p.precomputed.walk_m
    hh = households_near_frequent(homes, walk, f)
    assert 0 < hh <= sum(homes.values())
    t = {x.key: x.value for x in p.targets}
    assert t["transport_co2"] == round(transport_co2(hh, f), 2)
    assert rescore(p, [], f).scoreboard.transport_co2_tonnes_per_year == t["transport_co2"]
    # doubling the homes near frequent stops doubles it
    assert score(p, f, homes_scale=2)["transport_co2"] == pytest.approx(2 * t["transport_co2"], abs=0.02)
    # a target one step beyond the walk threshold drops out; exactly at it counts
    thr = walk_threshold_m(f)
    tid = max((k for k in homes if (walk.get(k) or {}).get("frequent_stop") is not None
               and walk[k]["frequent_stop"] <= thr), key=lambda k: (homes[k], k))
    for d, expect in ((thr, hh), (thr + 0.1, hh - homes[tid])):
        assert households_near_frequent(homes, {**walk, tid: {**walk[tid], "frequent_stop": d}}, f) == expect


@pytest.mark.parametrize("lid", LOCALES)
def test_rooftop_solar_scales_with_roof_area_and_yield_and_is_absent_without_yield(plans, lid):
    p, f = plans(lid), resolve(lid)
    kwh = p.precomputed.solar_kwh_per_kw_year
    assert kwh is not None and kwh > 0
    base = score(p, f)
    assert base == {x.key: x.value for x in p.targets}
    assert base["rooftop_solar"] > 0
    assert score(p, f, kwh=2 * kwh)["rooftop_solar"] == pytest.approx(2 * base["rooftop_solar"], abs=0.11)
    assert score(p, f, roof_scale=2)["rooftop_solar"] == pytest.approx(2 * base["rooftop_solar"], abs=0.11)
    assert rooftop_solar([], kwh, f) == 0
    missing = score(p, f, kwh=None)
    assert "rooftop_solar" not in missing   # missing yield is left out, never scored as 0
    assert missing == {k: v for k, v in base.items() if k != "rooftop_solar"}


@pytest.mark.parametrize("lid", LOCALES)
def test_percent_targets_in_range_and_flood_exposure_zero(plans, lid):
    p = plans(lid)
    t = {x.key: x for x in p.targets}
    for x in p.targets:
        assert math.isfinite(x.value) and x.value >= 0, x.key
        if x.unit.startswith("%"):
            assert x.value <= 100, x.key
    assert t["flood_exposure"].value == 0 and t["flood_exposure"].target == 0
    board = rescore(p, [], resolve(lid)).scoreboard
    assert all(0 <= v <= 100 for v in board.walk_by_amenity_pct.values())


@pytest.mark.parametrize("lid", LOCALES)
def test_homes_tile_inside_flood_zone_is_refused_and_changes_nothing(plans, lid):
    p, f = plans(lid), resolve(lid)
    pids = {x.id for x in p.parcels}
    flood = sorted(pid for pid, v in p.precomputed.in_flood.items() if v and pid in pids
                   and p.precomputed.homes_by_parcel.get(pid))
    if not flood:
        pytest.skip("no buildable parcel inside a FEMA high-risk zone here")
    r = rescore(p, [Edit(kind="place_tile", tile="homes", target_id=flood[0])], f)
    assert r.rejected is not None and "flood" in r.rejected.reason
    assert r.scoreboard == rescore(p, [], f).scoreboard


# ---------------------------------------------------------------- readiness
@pytest.mark.parametrize("lid", LOCALES)
def test_readiness_scores_bounded_and_flood_and_transit_flags_match_measurements(plans, lid):
    p, f = plans(lid), resolve(lid)
    thr = walk_threshold_m(f)
    assert p.readiness
    for r in p.readiness:
        assert math.isfinite(r.score) and 0 <= r.score <= 1, r.target_id
        flood_gap = any("flood zone" in g for g in r.gaps)
        assert flood_gap == bool(p.precomputed.in_flood.get(r.target_id)), r.target_id
        d = p.precomputed.walk_m.get(r.target_id, {}).get("frequent_stop")
        has = any(x.startswith(infra.LABEL["transit"] + " ") for x in r.present)
        assert has == (d is not None and d <= thr), r.target_id


def test_dense_grids_score_higher_readiness_than_brevard(plans):
    med = {lid: statistics.median(r.score for r in plans(lid).readiness) for lid in LOCALES}
    assert med[H] > med[B] and med[LA] > med[B]


@pytest.mark.parametrize("lid", [xf(lid, "QA-TRANSIT-9: present lists amenities within 640 m while gaps flag those "
                                         "beyond 320 m, so one amenity is both") for lid in LOCALES])
def test_no_amenity_is_both_present_and_a_gap(plans, lid):
    both = []
    for r in plans(lid).readiness:
        for k, label in infra.LABEL.items():
            if (any(x.startswith(label + " ") for x in r.present)
                    and any(g.startswith(f"no {label} within") for g in r.gaps)):
                both.append((r.target_id, k))
    assert not both


@pytest.mark.parametrize("lid", [xf(lid, "QA-TRANSIT-10: gap text 'sidewalk not mapped on 0 of 0 frontages' when no "
                                         "street lies within 25 m") for lid in LOCALES])
def test_sidewalk_gap_text_never_reads_0_of_0(plans, lid):
    bad = [r.target_id for r in plans(lid).readiness if any(" 0 of 0 frontages" in g for g in r.gaps)]
    assert not bad


@pytest.mark.parametrize("lid", [xf(lid, "QA-TRANSIT-11: frontages with no OSM sidewalk tag are reported as having "
                                         "no sidewalk") for lid in LOCALES])
def test_unmapped_frontages_are_not_reported_as_missing_sidewalks(lid):
    _, measures = agent_inputs(lid)
    f = resolve(lid)
    wrong = []
    for t in measures:
        sw = t["sidewalk"]
        if not 0 < sw["known"] < sw["frontages"]:
            continue
        _, _, gaps = infra.components(t, f)
        for g in gaps:
            if g.startswith("no sidewalk on "):
                n = int(g.removeprefix("no sidewalk on ").split(" ")[0])
                if n > sw["known"] - sw["with"]:
                    wrong.append((t["id"], g, sw))
    assert not wrong


@pytest.mark.xfail(strict=True, reason="QA-TRANSIT-12: broadband False lowers the score but lists no gap")
def test_brevard_unserved_broadband_is_listed_as_a_gap():
    _, measures = agent_inputs(B)
    f = resolve(B)
    unserved = [t for t in measures if t["broadband"] is False]
    assert unserved
    for t in unserved:
        s, _, gaps = infra.components(t, f)
        assert s["broadband"] == 0
        assert any("broadband" in g for g in gaps), t["id"]


@pytest.mark.parametrize("lid", LOCALES)
def test_missing_readiness_inputs_score_as_unknown_not_absent(lid):
    """docs/05: utilities present / not present / data missing; missing never counts as absent."""
    _, measures = agent_inputs(lid)
    f = resolve(lid)
    miss = f["reuse_missing_input_score"]
    for t in measures:
        s, _, gaps = infra.components(t, f)
        if t["utilities"] is None:
            assert s["utilities"] == miss and any("utility data not public" in g for g in gaps)
        if t["broadband"] is None:
            assert s["broadband"] == miss and any("broadband data not available" in g for g in gaps)
        if t["sidewalk"]["known"] == 0:
            assert s["sidewalk"] == miss
