"""CountyParcelProvider: county assessor parcels (HCAD, LA County Assessor, Brevard Property Appraiser).

PARCELS / OWNERSHIP_SALES at medium confidence; BUILDING_ATTRS (year built, use, area) at low confidence,
attached to the largest OSM footprint on each parcel.
"""
import re
from functools import lru_cache
from pathlib import Path

import yaml
from shapely.geometry import shape
from shapely.strtree import STRtree

from backend.data.geo import area_acres
from backend.data.providers._base import features, first_url, fx, meta, prov, retrieved, sourced
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced

MAPS_PATH = Path(__file__).resolve().parent.parent / "land_use_maps.yaml"
BUILDING_USES = {"office", "retail", "hotel", "industrial", "parking_garage", "residential"}
CAPS = {Capability.PARCELS, Capability.OWNERSHIP_SALES, Capability.BUILDING_ATTRS}


@lru_cache(maxsize=1)
def land_use_maps() -> dict:
    return yaml.safe_load(MAPS_PATH.read_text())


def map_land_use(locale_id: str, props: dict) -> str:
    m = land_use_maps()[locale_id]
    if m.get("vacant_code_suffix") and (props.get("raw_code") or "").endswith(m["vacant_code_suffix"]):
        return "vacant"
    raw = re.sub(r"\s+", " ", str(props.get(m["field"]) or "").strip())
    return m["map"].get(raw, m["default"])


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
    lu = land_use_maps()[locale_id]
    zoning_note = meta(locale_id, "county").get("zoning")
    out = []
    for f in features(fx(locale_id, "county", "parcels.geojson")):
        pr = f["properties"]
        med = _p(locale_id, "medium")
        row = {"id": pr["id"], "geometry": f["geometry"]}
        if cap == Capability.PARCELS.value:
            acres = pr.get("area_acres") or area_acres(f["geometry"], epsg)
            row["area_acres"] = Sourced(value=round(acres, 4), prov=med)
            row["land_use"] = Sourced(value=map_land_use(locale_id, pr), prov=_p(
                locale_id, "medium", f"county use code {pr.get(lu['field'])!s} mapped via land_use_maps.yaml"))
            row["address"] = sourced(pr.get("address"), med)
            if locale_id == "houston_downtown":
                row["zoning_code"] = sourced(None, med, "Houston has no zoning")
            else:
                row["zoning_code"] = sourced(pr.get("zoning_code"), _p(locale_id, "medium", zoning_note),
                                             "no zoning polygon covers this parcel")
            row["city"] = pr.get("city")
        else:
            row["owner"] = sourced(pr.get("owner"), med, "owner name not published in this county layer")
            row["last_sale_usd"] = sourced(pr.get("last_sale_usd"), med,
                                           "Texas is a non-disclosure state" if locale_id == "houston_downtown"
                                           else "sale price not in the public parcel layer")
            year_note = {"houston_downtown": "HCAD new_owner_date (ownership transfer)",
                         "la_wilshire_koreatown": "Prop 13 land base year (last change in ownership)"}.get(locale_id)
            row["last_sale_year"] = sourced(pr.get("last_sale_year"), _p(locale_id, "medium", year_note),
                                            "sale year not in the public parcel layer")
            row["assessed_value_usd"] = sourced(pr.get("assessed_value_usd"), _p(
                locale_id, "medium", {"houston_downtown": "HCAD total market value",
                                      "la_wilshire_koreatown": "Assessor roll land + improvement (Prop 13 limited)",
                                      "brevard_cocoa": "Property Appraiser land + building value"}[locale_id]))
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
    typed = land_use_maps()[locale_id].get("building_type_reliable", True)
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
