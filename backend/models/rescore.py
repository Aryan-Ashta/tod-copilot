"""Re-score (docs/05): apply meeting-mode edits to a built plan using only pure functions and Precomputed.

Stateless: the full edit list is applied to the base plan on every call, so undo = edits[:-1] and reset = [].
Every tile is checked against the base plan (_check); a refused tile changes nothing and the latest refused edit
still in the list is reported. The slider is one plan-wide setting: its last value applies after all other edits.
With from_existing the edits start from existing conditions (no agent sites, existing transit only) and an
apply_suggestions edit brings in the agents' plan.
The helpers here (site stacks, plan scoring) are also what the agents use, so rescore(plan, []) reproduces
the plan's own numbers exactly.
"""
import copy
import math
from datetime import date, datetime, timezone
from typing import Optional

import numpy as np

from backend.data.geo import M2_PER_ACRE, SQFT_PER_M2, lonlat_dist_m
from backend.models import deal as deal_model
from backend.models import finance, goals
from backend.models import transit as transit_model
from backend.models.targets import build_targets, embodied_co2_saved, walk_gaps
from backend.schemas import (CapitalStack, Citation, ConversionCandidate, DealStrategy, Edit, InfraFeature, Parcel,
                             Plan, Provenance, Rejection, RescoreResponse, Route, Scoreboard, ScoreSnapshot, Site, Stop,
                             TargetScore, TransitPlan)

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
    from backend.models.reuse import hotel_keys, mixed_use_retail_sqft   # one formula with the reuse score
    inc = finance.incentive_per_unit(locale_id, f)
    if use == "hotel":
        return finance.conversion_pro_forma(0, basis, rentable, f, 0.0, "hotel_conversion_cost_usd_per_sqft",
                                            extra_value_usd=hotel_keys(rentable, f) * f["hotel_value_usd_per_key"])
    if use == "mixed_use":
        retail = mixed_use_retail_sqft(rentable, f) * f["retail_rent_usd_sqft_yr"] * (1 - f["vacancy_rate"] - f["opex_ratio"])
        return finance.conversion_pro_forma(math.floor(units * f["mixed_use_residential_share"]), basis, rentable, f,
                                            inc, extra_noi_usd=retail)
    return finance.conversion_pro_forma(units, basis, rentable, f, inc)


def conversion_homes(use: str, units: Optional[int], f: dict) -> int:
    if not units or use == "hotel":
        return 0
    return math.floor(units * f["mixed_use_residential_share"]) if use == "mixed_use" else units


def lot_share(site: Site, sites: list[Site], rentable_by_building: dict[str, Optional[float]]) -> float:
    """Share of its lot's acquisition basis a conversion pays: the conversion sites in `sites` on one lot split it by
    rentable area, so the lot is bought once (the funding agent and rescore both price with this)."""
    def area(s: Site) -> float:
        return rentable_by_building.get(s.building_id) or 0.0
    lot = set(site.parcel_ids)
    total = sum(area(s) for s in sites if s.kind == "conversion" and s.building_id and lot & set(s.parcel_ids))
    return area(site) / total if total else 1.0


def in_plan(site: Site) -> bool:
    """Funded (priced) and watch sites; pass and reserve are out."""
    return site.status in ("pursue", "watch")


def score_plan(sites: list[Site], stacks: list[CapitalStack], conversions: dict[str, ConversionCandidate],
               rentable_by_building: dict[str, Optional[float]], roof_by_building: dict[str, Optional[float]],
               parcel_acres: dict[str, Optional[float]], walk_m: dict[str, dict], in_flood: dict[str, bool],
               kwh_per_kw_year: Optional[float], f: dict, open_share: Optional[dict[str, float]] = None,
               forgone_new_build_homes: int = 0) -> tuple[list[TargetScore], Scoreboard]:
    """open_share: site id -> share of its lot left open by the green-space slider (shrinks the new-build roof).
    forgone_new_build_homes: new-build homes given up to green space (credited in embodied_co2_saved)."""
    open_share = open_share or {}
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
            roofs.append(acres * SQFT_PER_ACRE * f["site_lot_coverage_ratio"] * (1 - open_share.get(s.id, 0.0)))
    targets = build_targets(homes_by_target, walk_m, in_flood, conv_area, roofs, kwh_per_kw_year, f,
                            forgone_new_build_homes)
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
_EXISTING_ROUTE_KINDS = ("rail_existing", "bus_existing")
_TILE_STOP_PREFIX = "tile-stop-"


def existing_transit(t: TransitPlan) -> TransitPlan:
    """Existing conditions from the agents' TransitPlan.

    Routes: rail_existing/bus_existing. An upgraded existing bus route ("upg-<route_id>", models/transit drops its
    bus_existing entry) comes back as "bus-<route_id>" on the same geometry; its pre-upgrade headway is not in the
    plan, so headway_min is None. Stops: the plan's stops are the GTFS feed stops plus the new feeder stops; a stop
    is new when every route it serves is a new route. Feed stops keep the plan's ridership range, which the
    transit agent split with the feeder stops. Coverage is the baseline; no new operating funding.
    """
    routes = [r for r in t.routes if r.kind in _EXISTING_ROUTE_KINDS]
    have = {r.id for r in routes}
    for r in t.routes:
        rid = f"bus-{r.id.removeprefix('upg-')}"
        if r.id.startswith("upg-") and rid not in have:
            routes.append(Route(id=rid, kind="bus_existing", geometry=r.geometry, headway_min=None, phase=0,
                                annual_operating_cost_usd=0.0))
            have.add(rid)
    new_ids = {r.id for r in t.routes if r.kind not in _EXISTING_ROUTE_KINDS}
    stops = [s for s in t.stops if not s.route_ids or not set(s.route_ids) <= new_ids]
    kept = {s.id for s in stops}
    return t.model_copy(update={"routes": routes, "stops": stops,
                                "measurements": [m for m in t.measurements if m.target_id in kept],
                                "coverage_pct": t.coverage_baseline_pct, "annual_operating_cost_usd": 0.0})


class _State:
    def __init__(self, base: Plan, f: dict, from_existing: bool = False):
        self.base, self.f = base, f
        if from_existing:
            self.sites: list[Site] = []
            self.stacks: list[CapitalStack] = []
            self.deals: list[DealStrategy] = []
            self.transit = existing_transit(base.transit)
        else:
            self.sites = list(base.sites)
            self.stacks = list(base.stacks)
            self.deals = list(base.deals)
            self.transit = base.transit
        self.conversions = dict((c.building_id, c) for c in base.conversions)
        # Precomputed.walk_m comes from the infrastructure agent, which measures walks to the existing feed's
        # frequent stops before the transit agent runs: it is the existing condition and also what the agents'
        # plan is scored with. Its "frequent_stop_planned" key (walk to the agents' upgraded/feeder stops) is the
        # only part of the agents' plan in it: existing conditions drop it and apply_suggestions restores it.
        if from_existing:
            self.walk_m = dict(_walk_split(base)[0])
        else:
            self.walk_m = dict(base.precomputed.walk_m)  # inner dicts replaced, never mutated
        self.infra_added: list[InfraFeature] = []
        self.changed_conversions: set[str] = set()
        self.transit_changed = from_existing
        self.suggestions_applied = not from_existing   # apply_suggestions is a no-op unless from_existing
        self.taken_parcels: set[str] = set()     # targets of applied place_tile edits
        self.taken_buildings: set[str] = set()
        self.tile_cover: set[str] = set()        # demand cells (h3) within stop_catchment_m of a tile stop
        self.open_share: dict[str, float] = {}    # site id -> open-space share set by the slider (replaced, never mutated)
        self.forgone_new_build_homes = 0          # new-build homes given up to the slider and park tiles


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
             "acres": {p.id: p.area_acres.value for p in base.parcels},
             "conversions": {c.building_id: c for c in base.conversions}}
    pre = base.precomputed
    walk_ids = [t for t in pre.walk_m if t in pre.centroid]
    cache["walk_ids"] = walk_ids
    cache["walk_lonlat"] = np.asarray([pre.centroid[t] for t in walk_ids], dtype=float).reshape(-1, 2)
    cells = pre.demand_cells
    cache["cell_lonlat"] = np.asarray([c["lonlat"] for c in cells], dtype=float).reshape(-1, 2)
    cache["cell_h3"] = np.asarray([c["h3"] for c in cells], dtype=object)
    cache["stop_cells"] = {}
    if len(_LOOKUPS) > 16:
        _LOOKUPS.clear()
    _LOOKUPS[id(base)] = (base, cache)
    return cache


_PLANNED = "frequent_stop_planned"


def _walk_split(base: Plan) -> tuple[dict, dict]:
    """walk_m without the agents' planned frequent stops (existing conditions), and those planned walks."""
    L = _lookups(base)
    if "walk_existing" not in L:
        wm = base.precomputed.walk_m
        L["walk_existing"] = {t: ({k: v for k, v in w.items() if k != _PLANNED} if _PLANNED in w else w)
                              for t, w in wm.items()}
        L["walk_planned"] = {t: w[_PLANNED] for t, w in wm.items() if _PLANNED in w}
    return L["walk_existing"], L["walk_planned"]


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return lonlat_dist_m(a, b)


def _dists_m(ll: np.ndarray, at: tuple[float, float]) -> np.ndarray:
    """lonlat_dist_m from every row of ll to `at`, vectorized (same formula)."""
    lat = np.radians((ll[:, 1] + at[1]) / 2)
    return np.hypot((ll[:, 0] - at[0]) * 111_320 * np.cos(lat), (ll[:, 1] - at[1]) * 110_540)


def _improve(st: _State, kind: str, at: tuple[float, float]) -> None:
    """A new park/stop at `at` shortens the walk of every target whose straight-line walk to it is shorter."""
    pre, L = st.base.precomputed, _lookups(st.base)
    detour = st.f["walk_detour_factor"]
    ids = L["walk_ids"]
    base_m = L.setdefault("walk_base_m", {}).get(kind)
    if base_m is None:
        base_m = np.asarray([pre.walk_m[t].get(kind) for t in ids], dtype=float)   # None -> nan
        base_m = np.where(np.isnan(base_m), np.inf, base_m)
        L["walk_base_m"][kind] = base_m
    d = _dists_m(L["walk_lonlat"], at) * detour
    # Edits only shorten walks, so a target can only improve where d beats its precomputed walk.
    for i in np.flatnonzero(d < base_m):
        tid = ids[i]
        w = st.walk_m[tid]
        di = float(d[i])
        if w.get(kind) is None or di < w[kind]:
            st.walk_m[tid] = {**w, kind: round(di, 1)}
    if len(st.walk_m) > len(pre.walk_m):   # targets the slider added
        for tid in st.walk_m.keys() - pre.walk_m.keys():
            c = pre.centroid.get(tid)
            w = st.walk_m[tid]
            if c is None:
                continue
            di = _dist(c, at) * detour
            if w.get(kind) is None or di < w[kind]:
                st.walk_m[tid] = {**w, kind: round(di, 1)}


def _remove_sites_on(st: _State, pid: str, kind: Optional[str] = None) -> None:
    """Drop the sites (of `kind`, or all) on parcel pid with their stacks and deals."""
    gone = {s.id for s in st.sites if pid in s.parcel_ids and (kind is None or s.kind == kind)}
    if not gone:
        return
    st.sites = [s for s in st.sites if s.id not in gone]
    st.stacks = [x for x in st.stacks if x.site_id not in gone]
    st.deals = [d for d in st.deals if d.site_id not in gone]


def _stop_cell(L: dict, s: Stop) -> str:
    sc = L["stop_cells"]
    h = sc.get(s.id)
    if h is None:
        h = sc[s.id] = transit_model.stop_cell(s.lonlat)
    return h


def _add_stop(st: _State, stop: Stop) -> None:
    """Add a stop. Each demand cell it covers (the agents' rule in models/transit.estimate_ridership: centroid within
    stop_catchment_m, or the stop inside the cell) is re-split evenly among all its covering stops, so riders move from
    the stops already sharing it instead of being counted twice. Coverage adds the demand within stop_catchment_m that
    no frequent stop reached (the agents' coverage rule)."""
    f, L = st.f, _lookups(st.base)
    cells, cat = st.base.precomputed.demand_cells, f["stop_catchment_m"]
    stops = st.transit.stops
    gain, lost = 0.0, np.zeros(len(stops))
    if cells:
        d = _dists_m(L["cell_lonlat"], stop.lonlat)
        hit = np.flatnonzero((d <= cat) | (L["cell_h3"] == transit_model.stop_cell(stop.lonlat)))
        if len(hit):
            ll = np.asarray([s.lonlat for s in stops], dtype=float).reshape(-1, 2)
            sc = np.asarray([_stop_cell(L, s) for s in stops], dtype=object)
        for i in hit:
            c = cells[i]
            cov = (_dists_m(ll, tuple(c["lonlat"])) <= cat) | (sc == c["h3"])
            k = int(cov.sum())
            gain += c["demand"] / (k + 1)
            if k:
                lost[cov] += c["demand"] / k - c["demand"] / (k + 1)
        st.tile_cover.update(cells[i]["h3"] for i in np.flatnonzero(d <= cat))
    rl, rh = f["ridership_rate_low"], f["ridership_rate_high"]
    kept = [s if not lost[j] else s.model_copy(update={
        "riders_per_day_low": max(0.0, round(s.riders_per_day_low - lost[j] * rl, 1)),
        "riders_per_day_high": max(0.0, round(s.riders_per_day_high - lost[j] * rh, 1))}) for j, s in enumerate(stops)]
    stop = stop.model_copy(update={"riders_per_day_low": round(gain * rl, 1), "riders_per_day_high": round(gain * rh, 1)})
    st.transit = st.transit.model_copy(update={"stops": [*kept, stop], "coverage_pct": _coverage(st)})


def _coverage(st: _State) -> float:
    """coverage_pct of the current network plus the tile stops: precomputed.demand_cells flag the cells the agents'
    existing ("covered_baseline") and planned ("covered") frequent stops reach."""
    t = st.base.transit
    key, pct = ("covered", t.coverage_pct) if st.suggestions_applied else ("covered_baseline", t.coverage_baseline_pct)
    cells = st.base.precomputed.demand_cells
    gain = sum(c["demand"] for c in cells if c["h3"] in st.tile_cover and not c.get(key))
    total = sum(c["demand"] for c in cells)
    return min(100.0, round(pct + 100 * gain / total, 1)) if gain and total else pct


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
    if e.kind == "apply_suggestions":
        _apply_suggestions(st)
        return
    if e.kind == "slider":
        if e.value is not None and not math.isfinite(e.value):
            raise Invalid("slider value must be a number")
        v = max(0.0, min(1.0, e.value or 0.0))
        share = v * f["slider_max_open_space_share"]
        new_sites, open_share, forgone = [], dict(st.open_share), 0
        for s in st.sites:
            if s.kind == "new_build" and in_plan(s):
                homes = math.floor(s.homes * (1 - share))
                forgone += s.homes - homes
                s = s.model_copy(update={"homes": homes})
                open_share[s.id] = 1 - (1 - open_share.get(s.id, 0.0)) * (1 - share)
                acres = sum(L["acres"].get(p) or 0 for p in s.parcel_ids)
                if share * acres * SQFT_PER_ACRE >= f["min_park_area_sqft"]:
                    tid = site_target(s)
                    st.walk_m[tid] = {**st.walk_m.get(tid, {}), "park": 0.0}
                prev = next((x for x in st.stacks if x.site_id == s.id), None)
                res = new_build_stack(s, L["parcels"], f, lid, affordable_units=prev.affordable_units if prev else None)
                if res:
                    st.stacks = [x for x in st.stacks if x.site_id != s.id] + [res[0]]
            new_sites.append(s)
        st.sites, st.open_share = new_sites, open_share
        st.forgone_new_build_homes += forgone
        return
    if e.kind != "place_tile":
        raise Invalid(f"unsupported edit {e.kind}")
    _check(base, f, e)
    tid = e.target_id
    if e.tile in ("homes", "park", "stop"):
        parcel = L["parcels"][tid]
        at = pre.centroid.get(tid)
        if e.tile == "homes":
            homes = pre.homes_by_parcel[tid]
            _remove_sites_on(st, tid)
            env = L["envelopes"].get(tid)
            max_h = next((p.allows.get("max_height_ft") for p in env.paths if p.eligible), None) if env else None
            height = f["newbuild_assumed_stories"] * f["story_height_ft"]
            site = Site(id=f"tile-{tid}", kind="new_build", parcel_ids=[tid], building_id=None,
                        geometry=parcel.geometry, homes=homes, height_ft=min(height, max_h or height), status="pursue")
            deal = _deal_for(site, parcel, f)
            res = new_build_stack(site, L["parcels"], f, lid)
            if res is not None:
                st.stacks.append(res[0])
            if res is None or deal.strategy == "pass":   # the agents' rule (funding.compare_options)
                site = site.model_copy(update={"status": "watch"})
            st.sites.append(site)
            st.deals.append(deal)
        elif e.tile == "park":
            st.forgone_new_build_homes += sum(s.homes or 0 for s in st.sites
                                              if tid in s.parcel_ids and s.kind == "new_build" and in_plan(s))
            _remove_sites_on(st, tid)
            st.infra_added.append(InfraFeature(kind="park", geometry=parcel.geometry,
                                               attrs={"proposed": True, "parcel_id": tid}, prov=_PROV))
            if at and (parcel.area_acres.value or 0) * SQFT_PER_ACRE >= f["min_park_area_sqft"]:
                _improve(st, "park", at)
        else:
            _add_stop(st, Stop(id=f"{_TILE_STOP_PREFIX}{tid}", lonlat=at, route_ids=[], riders_per_day_low=0.0,
                               riders_per_day_high=0.0, prov=_PROV))
            st.transit_changed = True
            _improve(st, "frequent_stop", at)
        return
    use = _CONVERT[e.tile]
    b, cand = L["buildings"][tid], st.conversions[tid]
    parcel = L["parcels"].get(b.parcel_id)
    basis = parcel_basis([parcel]) if parcel else None
    units = cand.est_units
    homes = conversion_homes(use, units, f)
    rentable = b.rentable_area_sqft.value
    st.conversions[tid] = cand.model_copy(update={
        "best_use": use, "overall": _overall(cand, use, f),
        "embodied_co2_saved_tonnes": round(embodied_co2_saved(rentable, f), 1) if rentable else None})
    st.changed_conversions.add(tid)
    if b.parcel_id:   # one lot never holds a new build and a conversion: the last tile wins (as the homes tile)
        _remove_sites_on(st, b.parcel_id, "new_build")
    sid = f"conv-{tid}"
    st.sites = [s for s in st.sites if s.id != sid]
    st.stacks = [x for x in st.stacks if x.site_id != sid]
    st.deals = [d for d in st.deals if d.site_id != sid]
    stories = b.stories.value or 1
    site = Site(id=sid, kind="conversion", parcel_ids=[b.parcel_id] if b.parcel_id else [], building_id=tid,
                geometry=b.footprint, homes=homes, height_ft=stories * f["story_height_ft"], status="pursue")
    deal = _deal_for(site, parcel, f, b.vacancy_pct.value)
    pf = conversion_pro_forma_for(use, units, rentable, b.typical_floor_sqft.value, basis, f, lid)
    if pf is not None:
        stack, _ = finance.capital_stack(sid, pf, f, finance.incentive_per_unit(lid, f) if use != "hotel" else 0.0)
        st.stacks.append(stack)
    if pf is None or deal.strategy == "pass":   # the agents' rule (funding.compare_options)
        site = site.model_copy(update={"status": "watch"})
    st.sites.append(site)
    st.deals.append(deal)
    if b.parcel_id:
        _share_lot(st, b.parcel_id)


_CONVERT = {"convert_residential": "residential", "convert_hotel": "hotel"}


def _check(base: Plan, f: dict, e: Edit) -> None:
    """Raise Invalid when a place_tile cannot apply. Pure: validity depends only on the base plan and the edit, so
    _normalize knows which tiles took effect."""
    if e.kind != "place_tile":
        return
    L, pre, tid = _lookups(base), base.precomputed, e.target_id
    if e.tile in ("homes", "park", "stop"):
        if tid not in L["parcels"]:
            raise Invalid("drop on a parcel")
        if e.tile == "homes":
            if pre.in_flood.get(tid):
                raise Invalid("inside FEMA high-risk flood zone: no new homes")
            if not pre.homes_by_parcel.get(tid):
                raise _no_homes(L["envelopes"].get(tid))
        elif e.tile == "stop" and pre.centroid.get(tid) is None:
            raise Invalid("no location for this parcel")
        return
    use = _CONVERT.get(e.tile)
    if use is None:
        raise Invalid(f"unsupported edit {e.kind}/{e.tile}")
    b, cand = L["buildings"].get(tid), L["conversions"].get(tid)
    if b is None or cand is None:
        raise Invalid("drop on a building")
    if cand.scores_by_use[use].legal == 0:
        path = cand.legal_path
        env = L["envelopes"].get(b.parcel_id)
        if path is None and env:
            path = next((p for p in env.paths if p.citations), None)
        raise Invalid(f"no eligible legal path allows {use} here", path.citations[0] if path and path.citations else None)
    if b.property_type.value == use:
        raise Invalid(f"already a {use} building: converting it to {use} changes nothing")
    homes = conversion_homes(use, cand.est_units, f)
    if use != "hotel" and cand.est_units is not None and homes == 0:
        raise Invalid("too small for one home", factor_key="avg_unit_sqft_residential")
    if homes and (pre.in_flood.get(tid) or pre.in_flood.get(b.parcel_id)):
        raise Invalid("inside FEMA high-risk flood zone: no new homes")


def _no_homes(env) -> Invalid:
    """Why a lot has no homes capacity, from the corpus only: "not covered" unless a cited path decides it."""
    if env is None or all(p.eligible is None for p in env.paths):
        return Invalid("not covered by the legal corpus for this lot")
    ok = [p for p in env.paths if p.eligible]
    if ok:
        p = next((p for p in ok if p.homes is None), ok[0])
        why = f"{p.name}: homes allowed on this lot not covered by the legal corpus" if p.homes is None \
            else f"{p.name} allows no homes on this lot"
        return Invalid(why, p.citations[0] if p.citations else None)
    no = next((p for p in env.paths if p.eligible is False and p.citations), None)
    if no is None:
        return Invalid("not covered by the legal corpus for this lot")
    return Invalid("no eligible legal path", no.citations[0])


def _share_lot(st: _State, pid: str) -> None:
    """Re-price the conversions on lot pid with their lot_share (as the funding agent does). A lone conversion keeps
    its price."""
    convs = [s for s in st.sites if s.kind == "conversion" and s.building_id and pid in s.parcel_ids]
    if len(convs) < 2:
        return
    f, L, lid = st.f, _lookups(st.base), st.base.locale.id
    basis = parcel_basis([L["parcels"][pid]]) if pid in L["parcels"] else None
    if basis is None:
        return
    stacks = {x.site_id: x for x in st.stacks}
    for s in convs:
        use = st.conversions[s.building_id].best_use if s.building_id in st.conversions else None
        if s.id not in stacks or use not in ("residential", "mixed_use", "hotel"):
            continue
        b, cand = L["buildings"][s.building_id], st.conversions[s.building_id]
        pf = conversion_pro_forma_for(use, cand.est_units, b.rentable_area_sqft.value, b.typical_floor_sqft.value,
                                      basis * lot_share(s, convs, L["rentable"]), f, lid)
        if pf is None:
            continue
        pf = finance.with_affordable(pf, stacks[s.id].affordable_units, f)
        stacks[s.id] = finance.capital_stack(s.id, pf, f, finance.incentive_per_unit(lid, f) if use != "hotel" else 0.0)[0]
    st.stacks = [stacks[x.site_id] for x in st.stacks]


def _overall(cand: ConversionCandidate, use: str, f: dict) -> float:
    s = cand.scores_by_use[use]
    w = f["reuse_weights"]
    return round(sum(w[k] * getattr(s, k) for k in w) / sum(w.values()), 4)


_Indexed = list[tuple[int, Edit]]


def _normalize(base: Plan, f: dict, edits: list[Edit]) -> tuple[_Indexed, Optional[tuple[int, Edit]], dict]:
    """The edits in effect, with their indices: refused tiles (_check) are left out; remove_tile drops the latest
    tile in effect on its target (and withdraws refused tiles there); a tile placed again on the same target moves
    to the end instead of applying twice. Slider edits are pulled out: the last one is the plan-wide setting.
    Returns (edits in effect, last slider edit or None, {index: Invalid} of refused tiles still in the list)."""
    out: _Indexed = []
    slider, refused = None, {}
    for i, e in enumerate(edits):
        if e.kind == "slider":
            slider = (i, e)
        elif e.kind == "remove_tile":
            for j in range(len(out) - 1, -1, -1):
                if out[j][1].kind == "place_tile" and out[j][1].target_id == e.target_id:
                    del out[j]
                    break
            refused = {j: x for j, x in refused.items() if edits[j].target_id != e.target_id}
        else:
            if e.kind == "place_tile":
                try:
                    _check(base, f, e)
                except Invalid as ex:
                    refused[i] = ex
                    continue
                out = [x for x in out if not (x[1].kind == "place_tile" and x[1].tile == e.tile
                                              and x[1].target_id == e.target_id)]
            out.append((i, e))
    return out, slider, refused


def _apply_suggestions(st: _State) -> None:
    """Bring in the agents' sites/stacks/deals except on targets an earlier tile took (and their new builds on the lot
    of a converted building), the agents' transit network (keeping tile stops, re-split against it) and their planned
    frequent-stop walks (see _State)."""
    if st.suggestions_applied:
        return
    st.suggestions_applied = True
    base, L = st.base, _lookups(st.base)
    lots = {L["buildings"][b].parcel_id for b in st.taken_buildings if b in L["buildings"]} - {None}
    keep = {s.id for s in base.sites
            if not st.taken_parcels.intersection(s.parcel_ids) and s.building_id not in st.taken_buildings
            and not (s.kind == "new_build" and lots.intersection(s.parcel_ids))}
    st.sites = st.sites + [s for s in base.sites if s.id in keep]
    st.stacks = st.stacks + [x for x in base.stacks if x.site_id in keep]
    st.deals = st.deals + [d for d in base.deals if d.site_id in keep]
    for pid in sorted(lots):
        _share_lot(st, pid)
    for t, v in _walk_split(base)[1].items():
        st.walk_m[t] = {**st.walk_m.get(t, {}), _PLANNED: v}
    tile_stops = [s for s in st.transit.stops if s.id.startswith(_TILE_STOP_PREFIX)]
    st.transit = base.transit
    for s in tile_stops:
        _add_stop(st, s)
    st.transit_changed = True


def _step(st: _State, e: Edit) -> None:
    """Apply one edit (raises Invalid, leaving st unchanged) and record the target it took: homes and park tiles
    take their lot, conversions their building; a stop takes nothing."""
    _apply(st, e)
    if e.kind == "place_tile" and e.target_id:
        if e.tile in _CONVERT:
            st.taken_buildings.add(e.target_id)
        elif e.tile in ("homes", "park"):
            st.taken_parcels.add(e.target_id)


def _run(base: Plan, edits: _Indexed, f: dict, from_existing: bool = False) -> _State:
    """The state after the normalized edits (no slider)."""
    st = _State(base, f, from_existing)
    for _, e in edits:
        try:
            _step(st, e)
        except Invalid:
            continue
    return st


def _with_slider(st: _State, slider: Optional[tuple[int, Edit]]) -> tuple[_State, Optional[tuple[int, Invalid]]]:
    """The plan-wide green-space setting applied after every other edit, on a copy so st stays slider-free.
    Value None or 0 is no open space. Returns (state, (slider index, Invalid) when the slider was refused)."""
    if slider is None or not slider[1].value:
        return st, None
    c = copy.copy(st)
    for k, v in vars(st).items():
        if k != "f" and isinstance(v, (list, dict, set)):
            setattr(c, k, copy.copy(v))
    try:
        _apply(c, slider[1])
    except Invalid as ex:
        return st, (slider[0], ex)
    return c, None


def _score(st: _State) -> tuple[list[TargetScore], Scoreboard]:
    L = _lookups(st.base)
    return score_plan(st.sites, st.stacks, st.conversions, L["rentable"], L["roof"], L["acres"], st.walk_m,
                      st.base.precomputed.in_flood, st.base.precomputed.solar_kwh_per_kw_year, st.f,
                      open_share=st.open_share, forgone_new_build_homes=st.forgone_new_build_homes)


def _snapshot(st: _State) -> ScoreSnapshot:
    targets, board = _score(st)
    return ScoreSnapshot(scoreboard=board, targets=targets)


def rescore(base: Plan, edits: list[Edit], f: dict, from_existing: bool = False) -> RescoreResponse:
    st = _State(base, f, from_existing)
    start = _snapshot(st)
    suggested = start if not from_existing else _snapshot(_State(base, f))
    existing = start if from_existing else _snapshot(_State(base, f, True))
    steps: list[ScoreSnapshot] = []
    # Each prefix is normalized; when that appends just this edit to the edits in effect, it applies incrementally,
    # any other change (remove_tile, a tile placed again) replays them. The slider applies last on a copy.
    eff, slider, refused = [], None, {}
    cur, slider_refused = st, None
    for i, e in enumerate(edits):
        prev, prev_slider = [j for j, _ in eff], slider[0] if slider else None
        eff, slider, refused = _normalize(base, f, edits[:i + 1])
        now_ids = [j for j, _ in eff]
        if now_ids == prev and (slider[0] if slider else None) == prev_slider:
            steps.append(steps[-1] if steps else start)
            continue
        if now_ids == prev + [i]:
            try:
                _step(st, e)
            except Invalid:
                pass
        elif now_ids != prev:
            st = _run(base, eff, f, from_existing)
        cur, slider_refused = _with_slider(st, slider)
        steps.append(_snapshot(cur))
    if slider_refused:
        refused[slider_refused[0]] = slider_refused[1]
    rejected = None
    if refused:
        k = max(refused)
        ex = refused[k]
        rejected = Rejection(edit_index=k, reason=ex.reason, citation=ex.citation, factor_key=ex.factor_key)
    st = cur
    now = steps[-1] if steps else start
    board, base_board = now.scoreboard, suggested.scoreboard
    deltas = {k: round(getattr(board, k) - getattr(base_board, k), 4) for k in Scoreboard.model_fields
              if isinstance(getattr(board, k), (int, float))}
    # Patch keys replace whole Plan fields; conversions and transit only appear when an edit changed them
    # (transit always with from_existing).
    patch = {"sites": st.sites, "stacks": st.stacks, "deals": st.deals, "targets": now.targets,
             "infrastructure_added": st.infra_added}
    if st.changed_conversions:
        patch["conversions"] = [st.conversions[c.building_id] for c in base.conversions]
    if st.transit_changed:
        patch["transit"] = st.transit
    if base.goals_report is not None:
        patch["goals_report"] = goals.report(st.sites, st.stacks, base.options.goals, st.transit,
                                             base.goals_report.existing_affordable)
    return RescoreResponse(plan_patch={k: _dump(v) for k, v in patch.items()}, scoreboard=board, deltas=deltas,
                           rejected=rejected, steps=steps, existing=existing, suggested=suggested)


def _dump(v):
    if isinstance(v, list):
        return [x.model_dump(mode="json") if hasattr(x, "model_dump") else x for x in v]
    return v.model_dump(mode="json") if hasattr(v, "model_dump") else v


