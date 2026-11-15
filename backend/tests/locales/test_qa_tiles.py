"""QA (tiles): sanity invariants of meeting-mode tiles on the three demo locales.

Covers place_tile homes / stop / convert_residential / convert_hotel, remove_tile and apply_suggestions, mostly from
existing conditions (what the meeting-mode UI sends: `from_existing=True`). Tests assert directions and relationships
between numbers, never pinned values. xfail(strict) tests encode the correct behavior of a known bug; findings are in
the QA report (QA-TILES-<n>).
"""
import math

import pytest

from backend.data.factors import resolve
from backend.data.geo import lonlat_dist_m
from backend.models.rescore import conversion_homes, rescore
from backend.models.targets import embodied_co2_saved, transport_co2, walk_threshold_m
from backend.schemas import Edit

LOCALES = ["houston_downtown", "la_wilshire_koreatown", "brevard_cocoa"]
IN_PLAN = ("pursue", "watch")
APPLY = Edit(kind="apply_suggestions")


def homes(pid):
    return Edit(kind="place_tile", tile="homes", target_id=pid)


def stop(pid):
    return Edit(kind="place_tile", tile="stop", target_id=pid)


def residential(bid):
    return Edit(kind="place_tile", tile="convert_residential", target_id=bid)


def hotel(bid):
    return Edit(kind="place_tile", tile="convert_hotel", target_id=bid)


def remove(target):
    return Edit(kind="remove_tile", target_id=target)


class Ctx:
    """One locale's plan, factors and deterministic tile targets (sorted ids, first match)."""

    def __init__(self, plan):
        self.plan, self.f = plan, resolve(plan.locale.id)
        pre, self.pre = plan.precomputed, plan.precomputed
        self.thr = walk_threshold_m(self.f)
        self.buildings = {b.id: b for b in plan.buildings}
        self.cands = {c.building_id: c for c in plan.conversions}
        site_parcels = {q for s in plan.sites for q in s.parcel_ids}
        self.planned_buildings = {s.building_id for s in plan.sites if s.building_id}
        with_building = {b.parcel_id for b in plan.buildings}
        parcels = sorted(p.id for p in plan.parcels)
        cap = [p for p in parcels if pre.homes_by_parcel.get(p) and not pre.in_flood.get(p)]
        empty = [p for p in cap if p not in site_parcels and p not in with_building]
        self.near = [p for p in empty if self._fs(p) <= self.thr]       # empty lots within a walk of frequent transit
        self.far = [p for p in empty if self._fs(p) > self.thr]
        self.flood = [p for p in parcels if pre.in_flood.get(p) and pre.homes_by_parcel.get(p)]
        self.no_capacity = [p for p in parcels if not pre.homes_by_parcel.get(p) and not pre.in_flood.get(p)]
        self.nb_parcels = [s.parcel_ids[0] for s in plan.sites if s.kind == "new_build"]
        ids = sorted(self.cands)
        self.res = [b for b in ids if self._convertible(b, "residential")]
        self.hot = [b for b in ids if self._convertible(b, "hotel")]
        self.both = [b for b in self.res if b in set(self.hot)]
        self.res_on_capacity_lot = [b for b in self.res if self.buildings[b].parcel_id in set(cap)]
        self.res_hotel_illegal = [b for b in self.res if self.cands[b].scores_by_use["hotel"].legal == 0]
        self.same_use_hotel = [b for b in ids if self.buildings[b].property_type.value == "hotel"
                               and self.cands[b].scores_by_use["hotel"].legal > 0
                               and self.buildings[b].rentable_area_sqft.value and b not in self.planned_buildings]

    def _fs(self, tid) -> float:
        d = self.pre.walk_m.get(tid, {}).get("frequent_stop")
        return math.inf if d is None else d

    def _convertible(self, bid, use) -> bool:
        b, c = self.buildings[bid], self.cands[bid]
        return (c.scores_by_use[use].legal > 0 and bool(c.est_units) and bool(b.rentable_area_sqft.value)
                and bid not in self.planned_buildings and b.property_type.value != use
                and not self.pre.in_flood.get(bid) and not self.pre.in_flood.get(b.parcel_id))

    def run(self, edits, from_existing=True):
        return rescore(self.plan, edits, self.f, from_existing=from_existing)

    def board(self, edits, from_existing=True):
        return self.run(edits, from_existing).scoreboard


_CTX: dict[str, Ctx] = {}


@pytest.fixture(params=LOCALES)
def ctx(request, plans):
    lid = request.param
    if lid not in _CTX:
        _CTX[lid] = Ctx(plans(lid))
    return _CTX[lid]


def _first(xs, why):
    if not xs:
        pytest.skip(why)
    return xs[0]


def _assert_sane(r):
    """Bounds and scoreboard <-> plan_patch consistency of one rescore response."""
    b = r.scoreboard
    nums = [b.homes, b.walk_access_pct, b.transport_co2_tonnes_per_year, b.embodied_co2_saved_tonnes,
            b.affordable_homes, b.funding_required_usd, *b.walk_by_amenity_pct.values()]
    assert all(math.isfinite(x) and x >= 0 for x in nums), b
    assert 0 <= b.walk_access_pct <= 100 and all(0 <= v <= 100 for v in b.walk_by_amenity_pct.values())
    assert b.walk_access_pct <= min(b.walk_by_amenity_pct.values())   # access needs every amenity
    assert b.affordable_homes <= b.homes
    sites = r.plan_patch["sites"]
    assert len({s["id"] for s in sites}) == len(sites)
    assert len({x["site_id"] for x in r.plan_patch["stacks"]}) == len(r.plan_patch["stacks"])
    assert b.homes == sum(s["homes"] for s in sites if s["status"] in IN_PLAN)
    funded = {s["id"] for s in sites if s["status"] == "pursue"}
    stacks = [x for x in r.plan_patch["stacks"] if x["site_id"] in funded]
    assert b.affordable_homes == sum(x["affordable_units"] for x in stacks)
    assert b.funding_required_usd == pytest.approx(sum(max(x["funding_required_usd"], 0.0) for x in stacks), abs=1.0)
    for k, v in r.deltas.items():
        assert v == pytest.approx(getattr(b, k) - getattr(r.suggested.scoreboard, k), abs=1e-6)


def _assert_steps_are_prefix_replays(c, edits, from_existing=True):
    r = c.run(edits, from_existing)
    assert len(r.steps) == len(edits)
    for i in range(len(edits)):
        assert r.steps[i].scoreboard == c.board(edits[:i + 1], from_existing), (i, edits[i])


# ---------------------------------------------------------------- homes tile
@pytest.mark.parametrize("from_existing", [True, False])
def test_homes_tile_adds_its_capacity_and_remove_restores_exactly(ctx, from_existing):
    pid = _first(ctx.near, "no empty lot with capacity")
    base = ctx.board([], from_existing)
    r = ctx.run([homes(pid)], from_existing)
    b = r.scoreboard
    assert b.homes - base.homes == ctx.pre.homes_by_parcel[pid]
    assert b.embodied_co2_saved_tonnes == base.embodied_co2_saved_tonnes   # new build saves no embodied carbon
    assert b.transport_co2_tonnes_per_year >= base.transport_co2_tonnes_per_year   # lot is near frequent transit
    assert b.funding_required_usd >= base.funding_required_usd and b.affordable_homes >= base.affordable_homes
    _assert_sane(r)
    assert ctx.board([homes(pid), remove(pid)], from_existing) == base
    assert ctx.board([homes(pid), homes(pid)], from_existing) == b                 # placing it twice is one tile


def test_homes_tile_on_a_planned_new_build_never_lowers_homes(ctx):
    base = ctx.board([], from_existing=False)
    for pid in ctx.nb_parcels:
        b = ctx.board([homes(pid)], from_existing=False)
        assert b.homes >= base.homes, pid
        assert b.embodied_co2_saved_tonnes == base.embodied_co2_saved_tonnes, pid


def test_homes_tile_in_flood_zone_is_rejected_and_changes_nothing(ctx):
    pid = _first(ctx.flood, "no flood-zone lot with capacity")
    base = ctx.run([homes(ctx.near[0])])
    r = ctx.run([homes(ctx.near[0]), homes(pid)])
    assert r.rejected is not None and r.rejected.edit_index == 1 and "flood" in r.rejected.reason
    assert r.scoreboard == base.scoreboard and r.steps[1] == r.steps[0]
    assert r.plan_patch["sites"] == base.plan_patch["sites"]


def test_homes_tile_without_capacity_is_rejected_with_reason(ctx):
    base = ctx.board([])
    for pid in ctx.no_capacity[:25]:
        r = ctx.run([homes(pid)])
        assert r.rejected is not None and r.rejected.reason, pid
        assert r.scoreboard == base, pid


def test_legal_rejection_matches_the_envelope(ctx):
    envs = {e.parcel_id: e for e in ctx.plan.envelopes}
    bad = []
    for pid in ctx.no_capacity:
        rej = ctx.run([homes(pid)]).rejected
        env = envs.get(pid)
        covered = env is not None and any(p.eligible is not None for p in env.paths)
        some_eligible = env is not None and any(p.eligible for p in env.paths)
        claims_no_path = "no eligible legal path" in rej.reason
        if claims_no_path:
            cited = next((p for p in env.paths if rej.citation in p.citations), None) if env and rej.citation else None
            if not covered or some_eligible or cited is None or cited.eligible is not False:
                bad.append(pid)
        elif not covered and "not covered" not in rej.reason:
            bad.append(pid)
    assert bad == []


# ---------------------------------------------------------------- stop tile
def test_stop_tile_never_lowers_transport_co2_and_moves_nothing_else(ctx):
    base = ctx.board([APPLY])
    parcels = sorted(ctx.pre.centroid.keys() & {p.id for p in ctx.plan.parcels})
    for pid in parcels[::max(1, len(parcels) // 40)]:
        b = ctx.board([APPLY, stop(pid)])
        assert b.transport_co2_tonnes_per_year >= base.transport_co2_tonnes_per_year, pid
        assert (b.homes, b.walk_access_pct, b.walk_by_amenity_pct, b.embodied_co2_saved_tonnes, b.affordable_homes,
                b.funding_required_usd) == (base.homes, base.walk_access_pct, base.walk_by_amenity_pct,
                                            base.embodied_co2_saved_tonnes, base.affordable_homes,
                                            base.funding_required_usd), pid


def test_stop_without_new_homes_adds_no_transport_co2(ctx):
    pid = ctx.near[0] if ctx.near else ctx.nb_parcels[0]
    assert ctx.board([stop(pid)]) == ctx.board([])


def test_stop_at_homes_lacking_frequent_transit_counts_them(ctx):
    pid = _first(ctx.far, "every lot with capacity is already within a walk of frequent transit")
    alone = ctx.board([homes(pid)])
    assert alone.transport_co2_tonnes_per_year == 0.0
    b = ctx.board([homes(pid), stop(pid)])
    assert b.transport_co2_tonnes_per_year == round(transport_co2(ctx.pre.homes_by_parcel[pid], ctx.f), 2) > 0
    assert b.homes == alone.homes and b.walk_access_pct == alone.walk_access_pct


def test_stop_beyond_walking_distance_of_the_homes_counts_nothing(ctx):
    pid = _first(ctx.far, "every lot with capacity is already within a walk of frequent transit")
    at = ctx.pre.centroid[pid]
    reach = ctx.thr / ctx.f["walk_detour_factor"]
    far_lots = [q for q in sorted(ctx.pre.centroid) if q in ctx.pre.homes_by_parcel
                and lonlat_dist_m(ctx.pre.centroid[q], at) > 2 * reach]
    assert far_lots
    assert ctx.board([homes(pid), stop(far_lots[0])]) == ctx.board([homes(pid)])


def test_stop_on_a_lot_with_homes_keeps_the_homes(ctx):
    pid = ctx.near[0]
    with_homes = ctx.board([homes(pid)])
    b = ctx.board([homes(pid), stop(pid)])
    assert b.homes == with_homes.homes and b.funding_required_usd == with_homes.funding_required_usd
    assert b.transport_co2_tonnes_per_year >= with_homes.transport_co2_tonnes_per_year


def test_repeated_stop_on_one_lot_is_idempotent(ctx):
    pid = ctx.nb_parcels[0]
    once, twice = ctx.run([stop(pid)]), ctx.run([stop(pid), stop(pid)])
    assert twice.scoreboard == once.scoreboard
    ids = [s["id"] for s in twice.plan_patch["transit"]["stops"]]
    assert len(ids) == len(set(ids))
    assert twice.plan_patch["transit"] == once.plan_patch["transit"]


def test_stop_before_apply_suggestions_keeps_the_agents_site(ctx):
    for pid in ctx.nb_parcels:
        assert ctx.board([stop(pid), APPLY]) == ctx.board([APPLY, stop(pid)]), pid


# ---------------------------------------------------------------- conversions
def test_residential_conversion_adds_est_units_and_embodied_carbon(ctx):
    bid = _first(ctx.res, "no convertible building")
    base = ctx.board([])
    r = ctx.run([residential(bid)])
    b, cand, rentable = r.scoreboard, ctx.cands[bid], ctx.buildings[bid].rentable_area_sqft.value
    assert b.homes - base.homes == cand.est_units
    conv = next(c for c in r.plan_patch["conversions"] if c["building_id"] == bid)
    assert conv["best_use"] == "residential"
    saved = b.embodied_co2_saved_tonnes - base.embodied_co2_saved_tonnes
    assert saved > 0
    assert saved == pytest.approx(conv["embodied_co2_saved_tonnes"]) == pytest.approx(
        round(embodied_co2_saved(rentable, ctx.f), 1))
    _assert_sane(r)


def test_hotel_conversion_adds_no_homes_but_saves_embodied_carbon(ctx):
    bid = _first(ctx.both, "no building legal for both residential and hotel")
    base = ctx.board([])
    h, res = ctx.run([hotel(bid)]), ctx.board([residential(bid)])
    b = h.scoreboard
    assert b.homes == base.homes and b.affordable_homes == base.affordable_homes
    assert b.transport_co2_tonnes_per_year == base.transport_co2_tonnes_per_year
    assert b.walk_access_pct == base.walk_access_pct
    assert b.embodied_co2_saved_tonnes > base.embodied_co2_saved_tonnes
    assert b.embodied_co2_saved_tonnes == res.embodied_co2_saved_tonnes   # embodied carbon depends on area, not use
    _assert_sane(h)


def test_converting_twice_or_switching_uses_does_not_double_count(ctx):
    bid = _first(ctx.both, "no building legal for both residential and hotel")
    once = ctx.run([residential(bid)])
    for edits in ([residential(bid), residential(bid)], [hotel(bid), residential(bid)],
                  [residential(bid), hotel(bid), residential(bid)]):
        r = ctx.run(edits)
        assert r.scoreboard == once.scoreboard, edits
        assert [s for s in r.plan_patch["sites"] if s["building_id"] == bid] == \
               [s for s in once.plan_patch["sites"] if s["building_id"] == bid]
    assert ctx.board([residential(bid), hotel(bid)]) == ctx.board([hotel(bid)])


def test_converting_a_planned_building_does_not_double_count(ctx):
    sugg = ctx.board([], from_existing=False)
    planned = [s for s in ctx.plan.sites if s.kind == "conversion" and s.status in IN_PLAN]
    if not planned:
        pytest.skip("the agents' plan converts no building here")
    for s in planned:
        cand = ctx.cands[s.building_id]
        r = ctx.run([residential(s.building_id)], from_existing=False)
        assert r.scoreboard.embodied_co2_saved_tonnes == sugg.embodied_co2_saved_tonnes, s.building_id
        assert r.scoreboard.homes == sugg.homes - s.homes + conversion_homes("residential", cand.est_units, ctx.f)
        assert sum(1 for x in r.plan_patch["sites"] if x["building_id"] == s.building_id) == 1


def test_illegal_conversion_is_rejected_with_citation(ctx):
    bid = _first(ctx.res_hotel_illegal, "every residential-legal building also allows hotel")
    base = ctx.run([residential(ctx.res[0])])
    r = ctx.run([residential(ctx.res[0]), hotel(bid)])
    assert r.rejected is not None and r.rejected.edit_index == 1 and r.rejected.reason
    assert r.rejected.citation is not None and r.rejected.citation.quote
    assert r.scoreboard == base.scoreboard


def test_converting_to_the_current_use_changes_nothing(ctx):
    bid = _first(ctx.same_use_hotel, "no existing hotel the corpus allows as hotel")
    assert ctx.board([hotel(bid)]) == ctx.board([])


def test_new_build_and_conversion_never_share_a_lot(ctx):
    bid = _first(ctx.res_on_capacity_lot, "no convertible building on a lot with capacity")
    pid = ctx.buildings[bid].parcel_id
    for edits in ([homes(pid), residential(bid)], [residential(bid), homes(pid)]):
        sites = [s for s in ctx.run(edits).plan_patch["sites"] if s["status"] in IN_PLAN]
        nb = {q for s in sites if s["kind"] == "new_build" for q in s["parcel_ids"]}
        cv = {q for s in sites if s["kind"] == "conversion" for q in s["parcel_ids"]}
        assert not nb & cv, edits


# ---------------------------------------------------------------- remove_tile, apply_suggestions
@pytest.mark.parametrize("from_existing", [True, False])
def test_remove_tile_restores_the_scoreboard_exactly(ctx, from_existing):
    start = [APPLY] if from_existing else []
    base = ctx.board(start, from_existing)
    bid = _first(ctx.both, "no building legal for both residential and hotel")
    tiles = [homes(ctx.near[0]), stop(ctx.nb_parcels[0]), residential(bid), hotel(bid),
             homes(ctx.nb_parcels[0])]
    for t in tiles:
        assert ctx.board([*start, t, remove(t.target_id)], from_existing) == base, t
    stacked = [*start, *tiles]
    for t in reversed(tiles):
        stacked.append(remove(t.target_id))
    assert ctx.board(stacked, from_existing) == base


def test_remove_tile_after_a_rejected_tile_removes_the_placed_one(ctx):
    pid = _first(ctx.flood, "no flood-zone lot with capacity")
    r = ctx.run([stop(pid), homes(pid), remove(pid)])      # homes(pid) is rejected (flood zone)
    assert r.plan_patch["transit"]["stops"] == ctx.run([]).plan_patch["transit"]["stops"]


def test_apply_suggestions_reproduces_the_agents_plan(ctx):
    r = ctx.run([APPLY])
    assert r.scoreboard == r.suggested.scoreboard == ctx.board([], from_existing=False)
    assert all(v == 0 for v in r.deltas.values())
    assert ctx.board([APPLY, APPLY]) == r.scoreboard
    assert ctx.board([APPLY], from_existing=False) == r.scoreboard            # a no-op on the agents' plan
    e = r.existing.scoreboard
    assert (e.homes, e.transport_co2_tonnes_per_year, e.embodied_co2_saved_tonnes, e.funding_required_usd) == (0, 0, 0, 0)


def test_tile_before_or_after_apply_suggestions_gives_the_same_plan(ctx):
    for s in ctx.plan.sites:
        t = residential(s.building_id) if s.kind == "conversion" else homes(s.parcel_ids[0])
        assert ctx.board([t, APPLY]) == ctx.board([APPLY, t]), s.id


# ---------------------------------------------------------------- whole sequences
def _sequences(c):
    bid, bid2 = c.both[0], c.res[-1]
    near, nb = c.near[0], c.nb_parcels[0]
    far = c.far[0] if c.far else c.near[-1]
    flood = c.flood[0]
    return [
        [homes(near), stop(far), residential(bid), hotel(bid2), remove(near), APPLY, homes(flood)],
        [APPLY, homes(nb), stop(nb), hotel(bid), homes(flood), residential(bid), remove(bid), homes(far)],
        [residential(bid2), APPLY, homes(far), stop(far), remove(far), remove(far), residential(bid2)],
    ]


@pytest.mark.parametrize("from_existing", [True, False])
def test_edit_sequences_stay_sane_and_steps_replay(ctx, from_existing):
    if not ctx.both or not ctx.flood:
        pytest.skip("locale lacks a target kind")
    for edits in _sequences(ctx):
        r = ctx.run(edits, from_existing)
        _assert_sane(r)
        for i in range(len(edits)):
            _assert_sane(ctx.run(edits[:i + 1], from_existing))
        _assert_steps_are_prefix_replays(ctx, edits, from_existing)


def test_refused_tile_is_reported_when_the_slider_comes_last(ctx):
    pid = _first(ctx.flood, "no flood-zone lot with capacity")
    r = ctx.run([homes(pid), Edit(kind="slider", value=0.5)])
    assert r.rejected is not None and r.rejected.edit_index == 0
