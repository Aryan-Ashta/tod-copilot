"""Which US county and incorporated places an area lies in: the committed outlines fixture first (onboarded counties
and places, works offline), then Census TIGERweb. All HTTP goes through cached_get."""
import json
from functools import lru_cache
from typing import Optional

from shapely.geometry import box, shape

from backend import settings
from backend.data.http_cache import OfflineCacheMiss, cached_get
from backend.onboard import registry

TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1"
TIGER_PLACES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Places_CouSub_ConCity_SubMCD/MapServer/4"
OUTLINES_PATH = settings.FIXTURES_DIR / "metros" / "outlines.geojson"
_GEOM = {"returnGeometry": "true", "maxAllowableOffset": 0.0005, "outSR": 4326, "f": "geojson"}


@lru_cache(maxsize=1)
def outlines() -> dict:
    return json.loads(OUTLINES_PATH.read_text()) if OUTLINES_PATH.exists() else {"type": "FeatureCollection",
                                                                                   "features": []}


def _tiger_county_at(lon: float, lat: float) -> Optional[dict]:
    """TIGER county GeoJSON feature containing the point (properties GEOID, NAME, STATE, INTPTLAT, INTPTLON)."""
    d = cached_get(f"{TIGER_COUNTIES}/query", {
        "geometry": f"{lon:.5f},{lat:.5f}", "geometryType": "esriGeometryPoint", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "GEOID,NAME,STATE,INTPTLAT,INTPTLON", **_GEOM})
    feats = d.get("features") or []
    return feats[0] if feats else None


def _tiger_places(bbox) -> list[dict]:
    """TIGER incorporated-place GeoJSON features intersecting the bbox (properties GEOID, NAME, BASENAME, STATE)."""
    d = cached_get(f"{TIGER_PLACES}/query", {
        "geometry": ",".join(f"{v:.5f}" for v in bbox), "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects", "outFields": "GEOID,NAME,BASENAME,STATE", **_GEOM})
    return d.get("features") or []


def county_at(lon: float, lat: float) -> Optional[dict]:
    """{geoid, name, state, geometry (shapely)} of the county containing the point, or None."""
    from shapely.geometry import Point
    pt = Point(lon, lat)
    for f in outlines()["features"]:
        pr = f["properties"]
        if pr["kind"] == "county" and shape(f["geometry"]).contains(pt):
            return {"geoid": pr["geoid"], "name": pr["name"], "state": pr["geoid"][:2], "geometry": shape(f["geometry"])}
    f = _tiger_county_at(lon, lat)
    if f is None:
        return None
    pr = f["properties"]
    return {"geoid": pr["GEOID"], "name": pr["NAME"], "state": pr["STATE"], "geometry": shape(f["geometry"])}


def places_in(bbox) -> list[dict]:
    """{geoid, name, basename, state, jurisdiction, geometry} of incorporated places intersecting the bbox, by GEOID.
    Onboarded places (outlines fixture) carry their registry jurisdiction."""
    b = box(*bbox)
    out = {}
    for f in outlines()["features"]:
        pr = f["properties"]
        if pr["kind"] == "place" and shape(f["geometry"]).intersects(b):
            reg = registry.place(pr["geoid"])
            out[pr["geoid"]] = {"geoid": pr["geoid"], "name": pr["name"], "state": pr["geoid"][:2],
                                "basename": reg.get("basename") or pr["name"].removesuffix(" city"),
                                "jurisdiction": pr.get("jurisdiction") or registry.place_jurisdiction(reg),
                                "geometry": shape(f["geometry"])}
    try:
        tiger = _tiger_places(bbox)
    except OfflineCacheMiss:   # DEMO_OFFLINE=1: onboarded places (the outlines fixture) only
        tiger = []
    for f in tiger:
        pr = f["properties"]
        if pr["GEOID"] in out or not f.get("geometry"):
            continue
        reg = registry.place(pr["GEOID"])
        out[pr["GEOID"]] = {"geoid": pr["GEOID"], "name": pr["NAME"], "basename": pr["BASENAME"], "state": pr["STATE"],
                            "jurisdiction": registry.place_jurisdiction(reg or pr), "geometry": shape(f["geometry"])}
    return [out[k] for k in sorted(out)]


def county_bbox(fips5: str) -> tuple[float, float, float, float]:
    """Bounds of the county outline (outlines fixture, else TIGERweb)."""
    for f in outlines()["features"]:
        if f["properties"]["kind"] == "county" and f["properties"]["geoid"] == fips5:
            return shape(f["geometry"]).bounds
    d = cached_get(f"{TIGER_COUNTIES}/query", {"where": f"GEOID='{fips5}'", "outFields": "GEOID", **_GEOM})
    return shape(d["features"][0]["geometry"]).bounds


def county_info(fips5: str) -> dict:
    """{fips, name, state, sample_lonlat}: the registry's, else TIGER's (interior point)."""
    c = registry.county(fips5)
    if c.get("name") and c.get("sample_lonlat"):
        return {"fips": fips5, "name": c["name"], "state": c.get("state") or fips5[:2],
                "sample_lonlat": c["sample_lonlat"]}
    d = cached_get(f"{TIGER_COUNTIES}/query", {"where": f"GEOID='{fips5}'", "outFields": "GEOID,NAME,STATE,INTPTLAT,"
                                               "INTPTLON", "returnGeometry": "false", "f": "json"})
    a = d["features"][0]["attributes"]
    return {"fips": fips5, "name": a["NAME"], "state": a["STATE"],
            "sample_lonlat": [float(a["INTPTLON"]), float(a["INTPTLAT"])]}


def write_outlines() -> None:
    """TIGERweb outlines of every registry county and place -> backend/fixtures/metros/outlines.geojson, simplified
    to ~50 m so area checks for onboarded places work offline."""
    from backend.data.record import write_geojson, write_meta
    feats = []
    for kind, url, ids in (("county", TIGER_COUNTIES, registry.county_fips_list()),
                           ("place", TIGER_PLACES, registry.place_geoids())):
        for geoid in ids:
            d = cached_get(f"{url}/query", {"where": f"GEOID='{geoid}'", "outFields": "GEOID,NAME", **_GEOM})
            f = d["features"][0]
            reg = registry.county(geoid) if kind == "county" else registry.place(geoid)
            fips = geoid if kind == "county" else reg.get("county")
            feats.append({"type": "Feature", "properties": {
                "kind": kind, "geoid": geoid, "name": f["properties"]["NAME"],
                "sources_from": registry.county(fips).get("recorded_locale") if fips else None,
                "jurisdiction": (registry.county_jurisdiction(reg) if kind == "county"
                                 else registry.place_jurisdiction(reg))},
                "geometry": f["geometry"]})
            print(f"outlines: {f['properties']['NAME']}")
    d = OUTLINES_PATH.parent
    d.mkdir(parents=True, exist_ok=True)
    write_geojson(OUTLINES_PATH, feats)
    write_meta(d, "census_tigerweb", [TIGER_COUNTIES, TIGER_PLACES], note="Census TIGERweb current counties and "
               "incorporated places of every backend/registry entry, maxAllowableOffset 0.0005 deg")
    outlines.cache_clear()
