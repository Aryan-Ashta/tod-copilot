"""Loaders shared by several agents: merged parcels and buildings, cached on the RunContext."""
import math
from datetime import datetime, timezone
from typing import Any, Optional

from shapely.geometry import shape
from shapely.strtree import STRtree

from backend.agents.context import RunContext
from backend.data.geo import area_sqft, to_utm
from backend.data.providers.derived import derive_rentable_sqft
from backend.data.resolver import Capability, missing
from backend.schemas import Building, Parcel, Provenance, Sourced

UNDERUSE = ("surface_parking", "vacant", "retail_1story")
CONVERTIBLE = ("office", "retail", "hotel", "industrial", "parking_garage")
PARCEL_FIELDS = ("area_acres", "land_use", "owner", "last_sale_usd", "last_sale_year", "lease_expiry_year",
                 "address", "assessed_value_usd", "zoning_code")
BUILDING_FIELDS = ("property_type", "building_class", "year_built", "year_renovated", "stories", "rentable_area_sqft",
                   "typical_floor_sqft", "vacancy_pct", "asking_rent_usd_sqft_yr", "parking_spaces", "floor_depth_ft",
                   "ceiling_height_ft", "window_wall_pct", "roof_area_sqft", "name")


def _get(rec: dict, k: str, cap: str) -> Sourced:
    v = rec.get(k)
    return v if isinstance(v, Sourced) else missing(cap, f"{k}: no provider has this value here")


def _merge(dst: dict, src: dict) -> None:
    for k, v in src.items():
        if k == "id":
            continue
        cur = dst.get(k)
        if isinstance(v, Sourced):
            if not isinstance(cur, Sourced) or (cur.prov.confidence == "missing" and v.prov.confidence != "missing"):
                dst[k] = v
        elif cur is None:
            dst[k] = v


def load_buildings_raw(ctx: RunContext) -> list[dict]:
    """FOOTPRINTS + BUILDING_ATTRS + INTERIORS merged per building id (attrs first, then interiors)."""
    if "buildings_raw" in ctx.cache:
        return ctx.cache["buildings_raw"]
    loc, r = ctx.locale, ctx.resolver
    merged: dict[str, dict] = {}
    for cap in (Capability.BUILDING_ATTRS, Capability.INTERIORS, Capability.FOOTPRINTS):
        for rec in r.get_records(loc, cap) if r.covering(loc, cap) else []:
            _merge(merged.setdefault(rec["id"], {"id": rec["id"]}), rec)
    ctx.cache["buildings_raw"] = [m for m in merged.values() if m.get("geometry")]
    return ctx.cache["buildings_raw"]


def load_parcels(ctx: RunContext) -> list[Parcel]:
    """PARCELS + OWNERSHIP_SALES (+ LEASES), with the surface-parking and one-story-retail overlays."""
    if "parcels" in ctx.cache:
        return ctx.cache["parcels"]
    loc, r, epsg = ctx.locale, ctx.resolver, ctx.locale.utm_epsg
    merged: dict[str, dict] = {}
    for cap in (Capability.PARCELS, Capability.OWNERSHIP_SALES, Capability.LEASES):
        if not r.covering(loc, cap):
            continue
        for rec in r.get_records(loc, cap):
            _merge(merged.setdefault(rec["id"], {"id": rec["id"]}), rec)
    recs = [m for m in merged.values() if m.get("geometry")]
    # overlays: OSM surface parking share and building heights
    parking = [to_utm(p["geometry"], epsg) for p in (r.get_records(loc, Capability.IMAGERY)
                                                      if r.covering(loc, Capability.IMAGERY) else [])]
    ptree = STRtree(parking) if parking else None
    braw = load_buildings_raw(ctx)
    bpts = [shape(b["geometry"]).representative_point() for b in braw]
    btree = STRtree(bpts) if bpts else None
    out = []
    for m in recs:
        g = shape(m["geometry"])
        lu = m.get("land_use")
        if lu is not None and lu.value is not None:
            gu = to_utm(g, epsg)
            share = 0.0
            if ptree is not None and gu.area > 0:
                hits = ptree.query(gu, predicate="intersects")
                if len(hits):
                    share = sum(parking[i].intersection(gu).area for i in hits) / gu.area
            if share >= 0.5 and lu.value not in ("public", "residential"):
                lu = Sourced(value="surface_parking", prov=lu.prov.model_copy(update={
                    "source": "osm", "note": f"OSM surface parking covers {share:.0%} of the parcel"}))
            elif lu.value == "retail" and btree is not None:
                stories = [braw[i]["stories"].value for i in btree.query(g, predicate="contains")
                           if isinstance(braw[i].get("stories"), Sourced) and braw[i]["stories"].value is not None]
                if stories and max(stories) <= 1:
                    lu = Sourced(value="retail_1story", prov=lu.prov.model_copy(update={
                        "note": f"{lu.prov.note}; tallest building on parcel {max(stories)} story"}))
            m["land_use"] = lu
        fields = {k: _get(m, k, "parcels") for k in PARCEL_FIELDS}
        out.append(Parcel(id=m["id"], geometry=m["geometry"], **fields))
    ctx.cache["parcels"] = out
    ctx.cache["parcels_by_id"] = {p.id: p for p in out}
    return out


def parcel_index(ctx: RunContext) -> tuple[list[Parcel], STRtree]:
    if "parcel_tree" not in ctx.cache:
        ps = load_parcels(ctx)
        ctx.cache["parcel_tree"] = (ps, STRtree([shape(p.geometry) for p in ps]))
    return ctx.cache["parcel_tree"]


def load_buildings(ctx: RunContext) -> list[Building]:
    """Buildings with every schema field Sourced (missing when no provider has it); parcel = parcel containing
    the footprint's centroid. Rentable area is derived from footprint x stories when no source has it."""
    if "buildings" in ctx.cache:
        return ctx.cache["buildings"]
    ps, ptree = parcel_index(ctx)
    eff = ctx.f["reuse_efficiency_factor"]
    out = []
    for m in load_buildings_raw(ctx):
        g = shape(m["geometry"])
        c = g.representative_point()
        hits = ptree.query(c, predicate="within")
        pid = ps[hits[0]].id if len(hits) else (m.get("parcel_id") or "")
        fields = {k: _get(m, k, "building_attrs") for k in BUILDING_FIELDS}
        if fields["rentable_area_sqft"].value is None and fields["stories"].value:
            fp = m.get("footprint_sqft")
            fp_sqft = fp.value if isinstance(fp, Sourced) else area_sqft(g, ctx.locale.utm_epsg)
            fields["rentable_area_sqft"] = Sourced(value=round(derive_rentable_sqft(fp_sqft, fields["stories"].value, eff)),
                                                   prov=Provenance(source="derived", confidence="low",
                                                                   retrieved_at=fields["stories"].prov.retrieved_at,
                                                                   note="derived from footprint x stories x factor "
                                                                        "reuse_efficiency_factor, not measured"))
        ra, sto, tf = fields["rentable_area_sqft"], fields["stories"], fields["typical_floor_sqft"]
        if (tf.prov.source == "derived" and ra.value and sto.value and ra.prov.source != "derived"
                and sto.prov.source != "derived"):
            # A footprint includes podiums; reported area / stories is the closer estimate of a typical floor.
            fields["typical_floor_sqft"] = Sourced(value=round(ra.value / sto.value), prov=Provenance(
                source="derived", confidence="low", retrieved_at=ra.prov.retrieved_at,
                note=f"derived: rentable area ({ra.prov.source}) / stories ({sto.prov.source}), not measured"))
        out.append(Building(id=m["id"], parcel_id=pid, footprint=m["geometry"],
                            osm_id=m["id"] if m["id"].startswith("osm:") else None, **fields))
    ctx.cache["buildings"] = out
    ctx.cache["buildings_by_id"] = {b.id: b for b in out}
    return out


def candidate_buildings(ctx: RunContext) -> list[Building]:
    return [b for b in load_buildings(ctx) if b.property_type.value in CONVERTIBLE]


def underused_parcels(ctx: RunContext) -> list[Parcel]:
    return [p for p in load_parcels(ctx) if p.land_use.value in UNDERUSE]


def centroid_lonlat(geom: dict) -> tuple[float, float]:
    c = shape(geom).representative_point()
    return (round(c.x, 6), round(c.y, 6))


def miles(m: float) -> float:
    return m / 1609.344


def now() -> datetime:
    return datetime.now(timezone.utc)


def euclid_to_stations(ctx: RunContext, lonlat: tuple[float, float]) -> tuple[Optional[float], Optional[Any]]:
    """Metres to the nearest Locale.station (straight line, UTM) and that station."""
    from backend.data.geo import lonlat_to_utm
    if not ctx.locale.stations:
        return None, None
    x, y = lonlat_to_utm(*lonlat, ctx.locale.utm_epsg)
    best = min(ctx.locale.stations, key=lambda s: math.dist((x, y), lonlat_to_utm(*s.lonlat, ctx.locale.utm_epsg)))
    return math.dist((x, y), lonlat_to_utm(*best.lonlat, ctx.locale.utm_epsg)), best
