"""Re-score (docs/05): apply meeting-mode edits to a built plan using only pure functions and Precomputed.

Stateless: the full edit list is applied to the base plan on every call, so undo = edits[:-1] and reset = [].
Only the last edit is validated; an invalid last edit is rejected and the scoreboard for edits[:-1] returned.
The helpers here (site stacks, plan scoring) are also what the agents use, so rescore(plan, []) reproduces
the plan's own numbers exactly.
"""
import math
from datetime import date, datetime, timezone
from typing import Optional

from backend.data.geo import M2_PER_ACRE, SQFT_PER_M2, lonlat_dist_m
from backend.models import deal as deal_model
from backend.models import finance, goals
from backend.models.targets import build_targets, embodied_co2_saved, walk_gaps
from backend.schemas import (CapitalStack, Citation, ConversionCandidate, DealStrategy, Edit, InfraFeature, Parcel,
                             Plan, Provenance, Rejection, RescoreResponse, Scoreboard, Site, Stop, TargetScore)

SQFT_PER_ACRE = M2_PER_ACRE * SQFT_PER_M2
_PROV = Provenance(source="meeting_mode", confidence="low", retrieved_at=datetime(2026, 11, 13, tzinfo=timezone.utc),
                   note="proposed in meeting mode")


class Invalid(Exception):
    def __init__(self, reason: str, citation: Optional[Citation] = None, factor_key: Optional[str] = None):
        super().__init__(reason)
        self.reason, self.citation, self.factor_key = reason, citation, factor_key


# ---------------------------------------------------------------- shared helpers (agents use these too)
def site_target(site: Site) -> str:
    return site.building_id if site.kind == "conversion" and site.building_id else site.parcel_ids[0]


def parcel_basis(parcels: list[Parcel]) -> Optional[float]:
    vals = [finance.acquisition_basis(p.last_sale_usd.value, p.assessed_value_usd.value) for p in parcels]
    return None if not vals or any(v is None for v in vals) else sum(vals)


def new_build_stack(site: Site, parcels_by_id: dict[str, Parcel], f: dict, locale_id: str,
                    affordable_units: Optional[int] = None) -> Optional[tuple[CapitalStack, dict]]:
    """affordable_units: keep this many affordable homes (capped at the site's homes); None: the default share."""
    basis = parcel_basis([parcels_by_id[p] for p in site.parcel_ids if p in parcels_by_id])
    inc = finance.incentive_per_unit(locale_id, f)
    pf = finance.new_build_pro_forma(site.homes, basis, f, inc)
    if pf is None:
        return None
    if affordable_units is not None:
        pf = finance.with_affordable(pf, affordable_units, f)
    return finance.capital_stack(site.id, pf, f, inc)


def conversion_pro_forma_for(use: str, units: Optional[int], rentable: Optional[float], typical_floor: Optional[float],
                             basis: Optional[float], f: dict, locale_id: str) -> Optional[dict]:
    if rentable is None or basis is None or units is None:
        return None
    inc = finance.incentive_per_unit(locale_id, f)
    if use == "hotel":
        keys = rentable * f["reuse_efficiency_factor"] / f["hotel_key_sqft"]
        return finance.conversion_pro_forma(0, basis, rentable, f, 0.0, "hotel_conversion_cost_usd_per_sqft",
                                            extra_value_usd=keys * f["hotel_value_usd_per_key"])
    if use == "mixed_use":
        retail = (typical_floor or 0) * f["retail_rent_usd_sqft_yr"] * (1 - f["vacancy_rate"] - f["opex_ratio"])
        return finance.conversion_pro_forma(math.floor(units * f["mixed_use_residential_share"]), basis, rentable, f,
                                            inc, extra_noi_usd=retail)
    return finance.conversion_pro_forma(units, basis, rentable, f, inc)


def conversion_homes(use: str, units: Optional[int], f: dict) -> int:
    if not units or use == "hotel":
        return 0
    return math.floor(units * f["mixed_use_residential_share"]) if use == "mixed_use" else units


def in_plan(site: Site) -> bool:
    """Funded (priced) and watch sites; pass and reserve are out."""
    return site.status in ("pursue", "watch")


def score_plan(sites: list[Site], stacks: list[CapitalStack], conversions: dict[str, ConversionCandidate],
               rentable_by_building: dict[str, Optional[float]], roof_by_building: dict[str, Optional[float]],
               parcel_acres: dict[str, Optional[float]], walk_m: dict[str, dict], in_flood: dict[str, bool],
               kwh_per_kw_year: Optional[float], f: dict) -> tuple[list[TargetScore], Scoreboard]:
    pursued = [s for s in sites if in_plan(s)]
    homes_by_target: dict[str, int] = {}
    for s in pursued:
        if s.homes:
            homes_by_target[site_target(s)] = homes_by_target.get(site_target(s), 0) + s.homes
    conv_area, roofs = [], []
    for s in pursued:
        if s.kind == "conversion" and s.building_id:
            c = conversions.get(s.building_id)
            if c is not None and c.best_use != "keep_current" and rentable_by_building.get(s.building_id):
                conv_area.append(rentable_by_building[s.building_id])
            if roof_by_building.get(s.building_id):
                roofs.append(roof_by_building[s.building_id])
        else:
            acres = sum(parcel_acres.get(p) or 0 for p in s.parcel_ids)
            roofs.append(acres * SQFT_PER_ACRE * f["site_lot_coverage_ratio"])
    targets = build_targets(homes_by_target, walk_m, in_flood, conv_area, roofs, kwh_per_kw_year, f)
    tv = {t.key: t.value for t in targets}
    funded = {s.id for s in sites if s.status == "pursue"}
    fs = [x for x in stacks if x.site_id in funded]   # matches the goals report's funded sites
    total = sum(homes_by_target.values())
    gaps = walk_gaps(homes_by_target, walk_m, f)
    board = Scoreboard(homes=total, walk_access_pct=tv["walk_access"],
                       transport_co2_tonnes_per_year=tv["transport_co2"],
                       embodied_co2_saved_tonnes=tv["embodied_co2_saved"],
                       affordable_homes=sum(x.affordable_units for x in fs),
                       funding_required_usd=round(sum(max(x.funding_required_usd, 0.0) for x in fs), 2),
                       walk_by_amenity_pct={k: round(100 * (total - n) / total, 1) if total else 0.0
                                            for k, n in gaps.items()})
    return targets, board


# ---------------------------------------------------------------- rescore
class _State:
    def __init__(self, base: Plan, f: dict):
        self.base, self.f = base, f
        self.sites = list(base.sites)
        self.stacks = list(base.stacks)
        self.deals = list(base.deals)
        self.conversions = dict((c.building_id, c) for c in base.conversions)
        self.stops = list(base.transit.stops)
        self.walk_m = dict(base.precomputed.walk_m)  # inner dicts replaced, never mutated
        self.infra_added: list[InfraFeature] = []
        self.changed_conversions: set[str] = set()
        self.transit_changed = False


_LOOKUPS: dict[int, tuple[Plan, dict]] = {}


def _lookups(base: Plan) -> dict:
    """Id lookups per base plan (bounded cache; the plan object is held so its id stays unique)."""
    hit = _LOOKUPS.get(id(base))
    if hit is not None and hit[0] is base:
        return hit[1]
    cache = {"parcels": {p.id: p for p in base.parcels}, "buildings": {b.id: b for b in base.buildings},
             "envelopes": {e.parcel_id: e for e in base.envelopes},
             "rentable": {b.id: b.rentable_area_sqft.value for b in base.buildings},
             "roof": {b.id: b.roof_area_sqft.value for b in base.buildings},
             "acres": {p.id: p.area_acres.value for p in base.parcels}}
    if len(_LOOKUPS) > 16:
        _LOOKUPS.clear()
    _LOOKUPS[id(base)] = (base, cache)
    return cache


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return lonlat_dist_m(a, b)


def _improve(st: _State, kind: str, at: tuple[float, float]) -> None:
    pre = st.base.precomputed
    detour = st.f["walk_detour_factor"]
    for tid, w in list(st.walk_m.items()):
        c = pre.centroid.get(tid)
        if c is None:
            continue
        d = _dist(c, at) * detour
        if w.get(kind) is None or d < w[kind]:
            st.walk_m[tid] = {**w, kind: round(d, 1)}


def _remove_sites_on(st: _State, pid: str) -> None:
    gone = {s.id for s in st.sites if pid in s.parcel_ids}
    st.sites = [s for s in st.sites if s.id not in gone]
    st.stacks = [x for x in st.stacks if x.site_id not in gone]
    st.deals = [d for d in st.deals if d.site_id not in gone]


def _deal_for(site: Site, parcel: Optional[Parcel], f: dict, vacancy: Optional[float] = None) -> DealStrategy:
    p = parcel
    return deal_model.deal_strategy(site.id, site.kind, p.owner.value if p else None,
                                    p.lease_expiry_year.value if p else None, vacancy,
                                    p.last_sale_year.value if p else None, date.today().year, f,
                                    p.address.value if p else None, site.homes)


def _apply(st: _State, e: Edit) -> None:
    f, base, L = st.f, st.base, _lookups(st.base)
    pre = base.precomputed
    lid = base.locale.id
    if e.kind == "slider":
        v = max(0.0, min(1.0, e.value or 0.0))
        new_sites = []
        for s in st.sites:
            if s.kind == "new_build" and in_plan(s):
                s = s.model_copy(update={"homes": math.floor(s.homes * (1 - v * f["slider_max_open_space_share"]))})
                if v > 0:
                    tid = site_target(s)
                    st.walk_m[tid] = {**st.walk_m.get(tid, {}), "park": 0.0}
                prev = next((x for x in st.stacks if x.site_id == s.id), None)
                res = new_build_stack(s, L["parcels"], f, lid, affordable_units=prev.affordable_units if prev else None)
                if res:
                    st.stacks = [x for x in st.stacks if x.site_id != s.id] + [res[0]]
            new_sites.append(s)
        st.sites = new_sites
        return
    tid = e.target_id
    if e.tile in ("homes", "park", "stop"):
        parcel = L["parcels"].get(tid)
        if parcel is None:
            raise Invalid("drop on a parcel")
        at = pre.centroid.get(tid)
        if e.tile == "homes":
            if pre.in_flood.get(tid):
                raise Invalid("inside FEMA high-risk flood zone: no new homes")
            homes = pre.homes_by_parcel.get(tid)
            if not homes:
                env = L["envelopes"].get(tid)
                cite = next((c for p in env.paths for c in p.citations), None) if env else None
                raise Invalid("no eligible legal path", cite)
            _remove_sites_on(st, tid)
            env = L["envelopes"].get(tid)
            max_h = next((p.allows.get("max_height_ft") for p in env.paths if p.eligible), None) if env else None
            height = f["newbuild_assumed_stories"] * f["story_height_ft"]
            site = Site(id=f"tile-{tid}", kind="new_build", parcel_ids=[tid], building_id=None,
                        geometry=parcel.geometry, homes=homes, height_ft=min(height, max_h or height), status="pursue")
            res = new_build_stack(site, L["parcels"], f, lid)
            if res is None:
                site = site.model_copy(update={"status": "watch"})
            else:
                st.stacks.append(res[0])
            st.sites.append(site)
            st.deals.append(_deal_for(site, parcel, f))
        elif e.tile == "park":
            _remove_sites_on(st, tid)
            st.infra_added.append(InfraFeature(kind="park", geometry=parcel.geometry,
                                               attrs={"proposed": True, "parcel_id": tid}, prov=_PROV))
            if at:
                _improve(st, "park", at)
        else:
            if at is None:
                raise Invalid("no location for this parcel")
            covered = sum(c["demand"] for c in pre.demand_cells
                          if _dist(tuple(c["lonlat"]), at) <= f["stop_catchment_m"])
            st.stops.append(Stop(id=f"tile-stop-{tid}", lonlat=at, route_ids=[],
                                 riders_per_day_low=round(covered * f["ridership_rate_low"], 1),
                                 riders_per_day_high=round(covered * f["ridership_rate_high"], 1), prov=_PROV))
            st.transit_changed = True
            _improve(st, "frequent_stop", at)
        return
    if e.tile in ("convert_residential", "convert_hotel"):
        use = "residential" if e.tile == "convert_residential" else "hotel"
        b = L["buildings"].get(tid)
        cand = st.conversions.get(tid)
        if b is None or cand is None:
            raise Invalid("drop on a building")
        if cand.scores_by_use[use].legal == 0:
            path = cand.legal_path
            env = L["envelopes"].get(b.parcel_id)
            if path is None and env:
                path = next((p for p in env.paths if p.citations), None)
            raise Invalid(f"no eligible legal path allows {use} here", path.citations[0] if path and path.citations else None)
        parcel = L["parcels"].get(b.parcel_id)
        basis = parcel_basis([parcel]) if parcel else None
        units = cand.est_units
        homes = conversion_homes(use, units, f)
        rentable = b.rentable_area_sqft.value
        st.conversions[tid] = cand.model_copy(update={
            "best_use": use, "overall": _overall(cand, use, f),
            "embodied_co2_saved_tonnes": round(embodied_co2_saved(rentable, f), 1) if rentable else None})
        st.changed_conversions.add(tid)
        sid = f"conv-{tid}"
        st.sites = [s for s in st.sites if s.id != sid]
        st.stacks = [x for x in st.stacks if x.site_id != sid]
        st.deals = [d for d in st.deals if d.site_id != sid]
        stories = b.stories.value or 1
        site = Site(id=sid, kind="conversion", parcel_ids=[b.parcel_id] if b.parcel_id else [], building_id=tid,
                    geometry=b.footprint, homes=homes, height_ft=stories * f["story_height_ft"], status="pursue")
        pf = conversion_pro_forma_for(use, units, rentable, b.typical_floor_sqft.value, basis, f, lid)
        if pf is None:
            site = site.model_copy(update={"status": "watch"})
        else:
            stack, _ = finance.capital_stack(sid, pf, f, finance.incentive_per_unit(lid, f) if use != "hotel" else 0.0)
            st.stacks.append(stack)
            site = site.model_copy(update={"status": "pursue"})
        st.sites.append(site)
        st.deals.append(_deal_for(site, parcel, f, b.vacancy_pct.value))
        return
    raise Invalid(f"unsupported edit {e.kind}/{e.tile}")


def _overall(cand: ConversionCandidate, use: str, f: dict) -> float:
    s = cand.scores_by_use[use]
    w = f["reuse_weights"]
    return round(sum(w[k] * getattr(s, k) for k in w) / sum(w.values()), 4)


def _normalize(edits: list[Edit]) -> list[Edit]:
    """remove_tile drops the earlier tile placed on the same target."""
    out: list[Edit] = []
    for e in edits:
        if e.kind == "remove_tile":
            for i in range(len(out) - 1, -1, -1):
                if out[i].kind == "place_tile" and out[i].target_id == e.target_id:
                    del out[i]
                    break
        else:
            out.append(e)
    return out


def _run(base: Plan, edits: list[Edit], f: dict) -> _State:
    st = _State(base, f)
    for e in _normalize(edits):
        try:
            _apply(st, e)
        except Invalid:
            continue
    return st


def _score(st: _State) -> tuple[list[TargetScore], Scoreboard]:
    L = _lookups(st.base)
    return score_plan(st.sites, st.stacks, st.conversions, L["rentable"], L["roof"], L["acres"], st.walk_m,
                      st.base.precomputed.in_flood, st.base.precomputed.solar_kwh_per_kw_year, st.f)


def rescore(base: Plan, edits: list[Edit], f: dict) -> RescoreResponse:
    rejected = None
    if edits and edits[-1].kind != "remove_tile":
        st = _run(base, edits[:-1], f)
        try:
            _apply(st, edits[-1])
        except Invalid as ex:
            rejected = Rejection(edit_index=len(edits) - 1, reason=ex.reason, citation=ex.citation,
                                 factor_key=ex.factor_key)
            st = _run(base, edits[:-1], f)
    else:
        st = _run(base, edits, f)
    targets, board = _score(st)
    _, base_board = _score(_State(base, f))
    deltas = {k: round(getattr(board, k) - getattr(base_board, k), 4) for k in Scoreboard.model_fields
              if isinstance(getattr(board, k), (int, float))}
    # Patch keys replace whole Plan fields; conversions and transit only appear when an edit changed them.
    patch = {"sites": st.sites, "stacks": st.stacks, "deals": st.deals, "targets": targets,
             "infrastructure_added": st.infra_added}
    if st.changed_conversions:
        patch["conversions"] = [st.conversions[c.building_id] for c in base.conversions]
    if st.transit_changed:
        patch["transit"] = base.transit.model_copy(update={"stops": st.stops})
    if base.goals_report is not None:
        patch["goals_report"] = goals.report(st.sites, st.stacks, base.options.goals, base.transit,
                                             base.goals_report.existing_affordable)
    return RescoreResponse(plan_patch={k: _dump(v) for k, v in patch.items()}, scoreboard=board, deltas=deltas,
                           rejected=rejected)


def _dump(v):
    if isinstance(v, list):
        return [x.model_dump(mode="json") if hasattr(x, "model_dump") else x for x in v]
    return v.model_dump(mode="json") if hasattr(v, "model_dump") else v


