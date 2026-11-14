"""CountyParcelProvider: county assessor parcels, recorded from the county's registry parcel layer
(backend/registry/counties/<fips>.yaml `parcels`), with its `land_use` code map.

PARCELS / OWNERSHIP_SALES at medium confidence; BUILDING_ATTRS (year built, use, area) at low confidence,
attached to the largest OSM footprint on each parcel.
"""
import re
from functools import lru_cache
from typing import Optional

from shapely.geometry import shape
from shapely.strtree import STRtree

from backend.data.geo import area_acres
from backend.data.locales import get_locale
from backend.data.providers._base import features, first_url, fx, meta, prov, retrieved, sourced
from backend.data.resolver import Capability
from backend.onboard import registry
from backend.schemas import Locale, Sourced

BUILDING_USES = {"office", "retail", "hotel", "industrial", "parking_garage", "residential"}
CAPS = {Capability.PARCELS, Capability.OWNERSHIP_SALES, Capability.BUILDING_ATTRS}


def land_use_map(locale_id: str) -> Optional[dict]:
    """The county's registry `land_use` section, or None when it has none (every parcel maps to `other`)."""
    m = registry.county_view(get_locale(locale_id).county_fips).get("land_use")
    return None if registry.section_status(m) in (None, "not_found") else m


def map_land_use(locale_id: str, props: dict) -> str:
    m = land_use_map(locale_id)
    if m is None:
        return "other"
    if m.get("vacant_code_suffix") and (props.get("raw_code") or "").endswith(m["vacant_code_suffix"]):
        return "vacant"
    raw = re.sub(r"\s+", " ", str(props.get(m["field"]) or "").strip())
    return m["map"].get(raw, m["default"])


def _no_zoning_note(locale: Locale) -> Optional[str]:
    """A registry place with `zoning.none` (e.g. Houston) whose jurisdiction is this locale's."""
    for g in registry.place_geoids():
        p = registry.place(g)
        z = p.get("zoning") or {}
        if z.get("none") and registry.place_jurisdiction(p) == locale.jurisdiction:
            return z.get("note") or f"{p.get('name')} has no zoning"
    return None


class CountyParcelProvider:
    name = "county_parcels"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap in CAPS and fx(locale.id, "county", "parcels.geojson").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> list[dict]:
        if cap == Capability.BUILDING_ATTRS:
            return _building_attrs(locale.id)
        return _parcels(locale.id, locale.utm_epsg, cap.value)


def _p(locale_id: str, confidence: str, note: str | None = None):
    return prov("county_parcels", confidence, retrieved(locale_id, "county"), first_url(locale_id, "county"), note)


@lru_cache(maxsize=None)
def _parcels(locale_id: str, epsg: int, cap: str) -> list[dict]:
    loc = get_locale(locale_id)
    county = registry.county(loc.county_fips)
    lu = land_use_map(locale_id)

    def lu_note(pr: dict) -> str:
        return (f"county use code {pr.get(lu['field'])!s} mapped via the registry land_use map" if lu
                else "no land-use code map for this county")
    zoning_note = meta(locale_id, "county").get("zoning")
    no_zoning = _no_zoning_note(loc)
    state = registry.state(loc.county_fips[:2])
    sale_note = (f"{state['name']} is a non-disclosure state" if state["policies"].get("non_disclosure")
                 else "sale price not in the public parcel layer")
    notes = (county.get("parcels") or {}).get("notes") or {}
    out = []
    for f in features(fx(locale_id, "county", "parcels.geojson")):
        pr = f["properties"]
        med = _p(locale_id, "medium")
        row = {"id": pr["id"], "geometry": f["geometry"]}
        if cap == Capability.PARCELS.value:
            acres = pr.get("area_acres") or area_acres(f["geometry"], epsg)
            row["area_acres"] = Sourced(value=round(acres, 4), prov=med)
            row["land_use"] = Sourced(value=map_land_use(locale_id, pr), prov=_p(locale_id, "medium", lu_note(pr)))
            row["address"] = sourced(pr.get("address"), med)
            if no_zoning:
                row["zoning_code"] = sourced(None, med, no_zoning)
            elif zoning_note:
                row["zoning_code"] = sourced(pr.get("zoning_code"), _p(locale_id, "medium", zoning_note),
                                             "no zoning polygon covers this parcel")
            else:
                row["zoning_code"] = sourced(None, med, "no zoning layer recorded for this area")
            row["city"] = pr.get("city")
        else:
            row["owner"] = sourced(pr.get("owner"), med, "owner name not published in this county layer")
            row["last_sale_usd"] = sourced(pr.get("last_sale_usd"), med, sale_note)
            row["last_sale_year"] = sourced(pr.get("last_sale_year"),
                                            _p(locale_id, "medium", notes.get("last_sale_year")),
                                            "sale year not in the public parcel layer")
            row["assessed_value_usd"] = sourced(pr.get("assessed_value_usd"),
                                                _p(locale_id, "medium", notes.get("assessed_value_usd")))
            row["lease_expiry_year"] = Sourced(value=None, prov=_p(locale_id, "missing",
                                                                   "lease data has no public source"))
        out.append(row)
    return out


@lru_cache(maxsize=None)
def _building_attrs(locale_id: str) -> list[dict]:
    """County building facts belong to the parcel; attach them to the largest OSM footprint on it."""
    bfeats = features(fx(locale_id, "osm", "buildings.geojson"))
    if not bfeats:
        return []
    bgeoms = [shape(f["geometry"]) for f in bfeats]
    tree = STRtree([g.representative_point() for g in bgeoms])
    lu = land_use_map(locale_id)
    typed = (lu or {}).get("building_type_reliable", True)
    out = []
    for f in features(fx(locale_id, "county", "parcels.geojson")):
        pr = f["properties"]
        use = map_land_use(locale_id, pr)
        facts = {"year_built": pr.get("year_built"), "rentable_area_sqft": pr.get("building_sqft"),
                 "property_type": use if typed and use in BUILDING_USES else None}
        if not any(v is not None for v in facts.values()):
            continue
        hits = tree.query(shape(f["geometry"]), predicate="contains")
        if len(hits) == 0:
            continue
        bi = max(hits, key=lambda i: bgeoms[i].area)
        low = _p(locale_id, "low", "county record for the parcel, applied to its largest building")
        row = {"id": bfeats[bi]["properties"]["id"], "parcel_id": pr["id"]}
        for k, v in facts.items():
            if v is not None:
                row[k] = Sourced(value=int(v) if k == "year_built" else v, prov=low)
        out.append(row)
    return out
