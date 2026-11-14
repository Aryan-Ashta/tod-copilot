"""Record public data for one locale into backend/fixtures/<id>/ (docs/03, plan Phase 2 step 9).

Usage: uv run python scripts/record_fixtures.py --locale <id> [--only county,osm,gtfs,demand,fema,afdc,pvwatts,utilities,station,costar]

Every HTTP call goes through backend.data.http_cache.cached_get (osmnx uses its own cache under cache/osmnx).
"""
import argparse
import csv
import gzip
import io
import json
import math
import statistics
import sys
import re
import zipfile

import httpx  # noqa: E402
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402
import yaml  # noqa: E402
from shapely import simplify  # noqa: E402
from shapely.geometry import LineString, Point, mapping, shape  # noqa: E402
from shapely.ops import nearest_points  # noqa: E402
from shapely.strtree import STRtree  # noqa: E402

from backend import settings  # noqa: E402
from backend.data.geo import lonlat_to_utm, to_utm  # noqa: E402
from backend.data.http_cache import cached_get, evict  # noqa: E402

NOW = datetime.now(timezone.utc).isoformat()
MAX_PARCELS = 6000

HCAD = "https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0"
LA_PARCELS = "https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0"
LA_ZONING = "https://maps.lacity.org/lahub/rest/services/City_Planning_Department/MapServer/8"
LA_SEWER = "https://maps.lacity.org/lahub/rest/services/Sewer_Information/MapServer/9"
BREVARD = "https://gis.brevardfl.gov/gissrv/rest/services/Base_Map/Parcel_New_WKID2881/MapServer/5"
BREVARD_ZONING = "https://gis.brevardfl.gov/gissrv/rest/services/Planning_Development/Zoning_WKID2881/MapServer/0"
COCOA_ZONING = ("https://services1.arcgis.com/Tex1uhbqnOZPx6qT/arcgis/rest/services/"
                "Public_View_Cocoa_Zoning_with_Split_Lots_June_2023_view/FeatureServer/1")
COCOA_SEWER_AREA = "https://gis.brevardfl.gov/gissrv/rest/services/Utility_Services/Other_Service_Area_WKID2881/MapServer/0"
COCOA_WATER_AREA = "https://gis.brevardfl.gov/gissrv/rest/services/Utility_Services/Other_Service_Area_WKID2881/MapServer/1"
FEMA = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28"
TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer"
ACS_VEHICLES = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Vehicle_Availability_Boundaries/FeatureServer/2"
NOMINATIM = "https://nominatim.openstreetmap.org/search"

GTFS = {
    "houston_downtown": ["https://files.mobilitydatabase.org/mdb-2060/latest.zip"],
    "la_wilshire_koreatown": ["https://gitlab.com/LACMTA/gtfs_rail/-/raw/master/gtfs_rail.zip",
                              "https://gitlab.com/LACMTA/gtfs_bus/-/raw/master/gtfs_bus.zip"],
    "brevard_cocoa": ["https://files.mobilitydatabase.org/ntd-40063/latest.zip"],
}
STATE = {"houston_downtown": ("tx", "48"), "la_wilshire_koreatown": ("ca", "06"), "brevard_cocoa": ("fl", "12")}

# Cocoa Brightline station: Space Coast TPO / press place it behind the Walmart at 2700 Clearlake Rd,
# between that site and the FEC railroad corridor.
COCOA_WALMART = (-80.7531379, 28.3954023)
COCOA_SOURCES = [
    "https://nominatim.openstreetmap.org/search?format=json&q=Walmart+Supercenter+2700+Clearlake+Rd+Cocoa+FL",
    "https://mynews13.com/fl/orlando/news/2026/10/06/-million-grant-advances-brightline-station-in-cocoa",
]


# ---------------------------------------------------------------- helpers
def fixture_dir(lid: str, sub: str) -> Path:
    d = settings.FIXTURES_DIR / lid / sub
    d.mkdir(parents=True, exist_ok=True)
    return d


def write_meta(d: Path, source: str, urls: list[str], **extra) -> None:
    (d / "_meta.json").write_text(json.dumps({"source": source, "urls": urls, "retrieved_at": NOW, **extra}, indent=1))


def write_geojson(path: Path, features: list[dict]) -> None:
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    if path.stat().st_size > 25e6:
        for f in features:
            f["geometry"] = mapping(simplify(shape(f["geometry"]), 0.00002))
        path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))


def load_locale_yaml(lid: str) -> dict:
    return yaml.safe_load((settings.FIXTURES_DIR / lid / "locale.yaml").read_text())


def save_locale_yaml(lid: str, data: dict, header: str = "") -> None:
    p = settings.FIXTURES_DIR / lid / "locale.yaml"
    p.write_text(header + yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def arcgis_query(url: str, bbox, where: str = "1=1", out_fields: str = "*", geometry: bool = True,
                 page: int = 1000) -> list[dict]:
    feats, offset = [], 0
    while True:
        params = {"geometry": ",".join(f"{v:.6f}" for v in bbox), "geometryType": "esriGeometryEnvelope",
                  "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects", "where": where,
                  "outFields": out_fields, "returnGeometry": str(geometry).lower(), "f": "geojson",
                  "orderByFields": "OBJECTID", "resultOffset": offset, "resultRecordCount": page}
        d = cached_get(f"{url}/query", params)
        if "error" in d:
            evict(f"{url}/query", params)
            raise RuntimeError(f"{url}: {d['error']}")
        batch = d.get("features", [])
        feats += batch
        exceeded = d.get("exceededTransferLimit") or d.get("properties", {}).get("exceededTransferLimit")
        if not exceeded or not batch:
            return feats
        offset += len(batch)


def arcgis_count(url: str, bbox, where: str = "1=1") -> int:
    params = {"geometry": ",".join(f"{v:.6f}" for v in bbox), "geometryType": "esriGeometryEnvelope",
              "inSR": 4326, "where": where, "returnCountOnly": "true", "f": "json"}
    return cached_get(f"{url}/query", params)["count"]


def bbox_center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def expand_bbox(b, metres: float):
    dlat = metres / 111_320
    dlon = metres / (111_320 * math.cos(math.radians((b[1] + b[3]) / 2)))
    return (b[0] - dlon, b[1] - dlat, b[2] + dlon, b[3] + dlat)


def in_bbox(lon, lat, b) -> bool:
    return b[0] <= lon <= b[2] and b[1] <= lat <= b[3]


def ms_year(v):
    if v in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(int(v) / 1000, tz=timezone.utc).year
    except (TypeError, ValueError, OSError):
        return None


def num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def join(*parts) -> str:
    return " ".join(str(p).strip() for p in parts if p not in (None, "", 0) and str(p).strip())


# ---------------------------------------------------------------- station (Brevard)
def record_station(lid: str) -> None:
    if lid != "brevard_cocoa":
        return
    import osmnx as ox
    configure_osmnx()
    cached_get(NOMINATIM, {"format": "json", "q": "Walmart Supercenter 2700 Clearlake Rd Cocoa FL"})
    wb = (COCOA_WALMART[0] - 0.02, COCOA_WALMART[1] - 0.02, COCOA_WALMART[0] + 0.02, COCOA_WALMART[1] + 0.02)
    full, _ = fetch_osm_xml(f"{lid}_station", wb)
    rail = ox.features_from_xml(full, tags={"railway": "rail"})
    lines = [g for g in rail.geometry if g.geom_type in ("LineString", "MultiLineString")]
    epsg = 32617
    p = Point(lonlat_to_utm(*COCOA_WALMART, epsg))
    best = min((to_utm(g, epsg) for g in lines), key=lambda g: g.distance(p))
    snapped = nearest_points(best, p)[0]
    # Station sits between the store and the corridor: midpoint of store point and snapped rail point.
    mid_utm = ((snapped.x + p.x) / 2, (snapped.y + p.y) / 2)
    from pyproj import Transformer
    lon, lat = Transformer.from_crs(epsg, 4326, always_xy=True).transform(*mid_utm)
    dist_m = snapped.distance(p)
    data = load_locale_yaml(lid)
    data["stations"] = [{
        "name": "Cocoa Brightline station (planned)", "lonlat": [round(lon, 6), round(lat, 6)],
        "mode": "intercity_rail_planned", "source_url": COCOA_SOURCES[0],
        "note": ("approximate: behind Walmart at 2700 Clearlake Rd, between it and the FEC corridor (Space Coast TPO); "
                 f"midpoint of the store point and the nearest OSM railway=rail line ({dist_m:.0f} m apart); "
                 f"sources: {', '.join(COCOA_SOURCES)}"),
    }]
    dlat = 3218.7 / 111_320
    dlon = 3218.7 / (111_320 * math.cos(math.radians(lat)))
    data["bbox"] = [round(lon - dlon, 5), round(lat - dlat, 5), round(lon + dlon, 5), round(lat + dlat, 5)]
    save_locale_yaml(lid, data)
    print(f"station {lon:.6f},{lat:.6f}; bbox {data['bbox']}")


# ---------------------------------------------------------------- county parcels
def parcel_source(lid: str):
    if lid == "houston_downtown":
        return HCAD, "Stacked=0 OR Stacked IS NULL"
    if lid == "la_wilshire_koreatown":
        return LA_PARCELS, "1=1"
    return BREVARD, "1=1"


def shrink_bbox_if_needed(lid: str) -> list[float]:
    data = load_locale_yaml(lid)
    url, where = parcel_source(lid)
    bbox = list(data["bbox"])
    n = arcgis_count(url, bbox, where)
    original, steps = list(bbox), 0
    st = data.get("stations") or []
    cx, cy = ((sum(s["lonlat"][0] for s in st) / len(st), sum(s["lonlat"][1] for s in st) / len(st))
              if st else bbox_center(bbox))
    while n > MAX_PARCELS:
        bbox = [bbox[0] + 0.1 * (cx - bbox[0]), bbox[1] + 0.1 * (cy - bbox[1]),
                bbox[2] - 0.1 * (bbox[2] - cx), bbox[3] - 0.1 * (bbox[3] - cy)]
        steps += 1
        n = arcgis_count(url, bbox, where)
    if steps:
        data["bbox"] = [round(v, 5) for v in bbox]
        data["bbox_note"] = (f"shrunk {steps}x by 10% per side toward the stations from {original} "
                             f"to keep parcels under {MAX_PARCELS} ({n} parcels)")
        save_locale_yaml(lid, data)
        print(data["bbox_note"])
    return data["bbox"]


def zoning_lookup(url: str, field: str, bbox):
    feats = arcgis_query(url, bbox, out_fields=field)
    geoms = [shape(f["geometry"]) for f in feats if f.get("geometry")]
    codes = [f["properties"][field] for f in feats if f.get("geometry")]
    tree = STRtree(geoms)

    def lookup(geom):
        c = geom.representative_point()
        for i in tree.query(c, predicate="within"):
            return (codes[i] or "").strip() or None
        return None
    return lookup, len(feats)


def norm_houston(p: dict) -> dict:
    addr = join(p.get("site_str_pfx"), p.get("site_str_num"), p.get("site_str_name"), p.get("site_str_sfx"),
                p.get("site_str_sfx_dir"))
    return {"id": str(p["HCAD_NUM"]), "address": addr or None, "owner": p.get("owner_name_1"),
            "last_sale_usd": None, "last_sale_year": ms_year(p.get("new_owner_date")),
            "assessed_value_usd": num(p.get("total_market_val")), "area_acres": num(p.get("Acreage")),
            "raw_use": p.get("state_class"), "raw_use_desc": p.get("land_use"), "year_built": None,
            "building_sqft": None, "units": None, "city": p.get("site_city"), "zoning_code": None}


def norm_la(p: dict) -> dict:
    land, imp = num(p.get("Roll_LandValue")), num(p.get("Roll_ImpValue"))
    yb = p.get("YearBuilt1")
    yb = int(yb) if yb and str(yb).strip().isdigit() and int(yb) > 1800 else None
    base = p.get("Roll_LandBaseYear")
    return {"id": str(p["AIN"]), "address": (p.get("SitusFullAddress") or "").strip() or None, "owner": None,
            "last_sale_usd": None, "last_sale_year": int(base) if base and int(base) > 1975 else None,
            "assessed_value_usd": (land or 0) + (imp or 0) if land is not None else None, "area_acres": None,
            "raw_use": p.get("UseType"), "raw_use_desc": p.get("UseDescription"), "raw_code": p.get("UseCode"),
            "year_built": yb,
            "building_sqft": num(p.get("SQFTmain1")) or None, "units": num(p.get("Units1")) or None,
            "city": p.get("SitusCity"), "zoning_code": None}


def norm_brevard(p: dict) -> dict:
    street = None if (p.get("STREET_NAME") or "").strip().upper() in ("", "UNKNOWN") else p.get("STREET_NAME")
    addr = join(p.get("STREET_NUMBER"), p.get("STREET_DIRECTION_PREFIX"), street, p.get("STREET_TYPE")) if street else ""
    land, bldg = num(p.get("LAND_VALUE")), num(p.get("BLDG_VALUE"))
    return {"id": str(p.get("PARCEL_ID") or p.get("TaxAcct")), "address": (f"{addr}, {p.get('CITY')}" if addr else None),
            "owner": p.get("OWNER_NAME1"), "last_sale_usd": None, "last_sale_year": None,
            "assessed_value_usd": (land or 0) + (bldg or 0) if land is not None or bldg is not None else None,
            "area_acres": num(p.get("ACRES")), "raw_use": p.get("USE_CODE"), "raw_use_desc": p.get("USE_CODE_DESCRIPTION"),
            "year_built": None, "building_sqft": num(p.get("LIV_AREA")) or None, "units": None, "city": p.get("CITY"),
            "zoning_code": None}


def record_county(lid: str) -> None:
    bbox = shrink_bbox_if_needed(lid)
    url, where = parcel_source(lid)
    raw = arcgis_query(url, bbox, where)
    norm = {"houston_downtown": norm_houston, "la_wilshire_koreatown": norm_la, "brevard_cocoa": norm_brevard}[lid]
    urls = [url]
    zoning, zoning_note = None, None
    if lid == "la_wilshire_koreatown":
        zoning, n = zoning_lookup(LA_ZONING, "ZONE_CMPLT", bbox)
        urls.append(LA_ZONING)
        zoning_note = f"City of LA Generalized Zoning layer, field ZONE_CMPLT ({n} polygons)"
    elif lid == "brevard_cocoa":
        city, n_city = zoning_lookup(COCOA_ZONING, "Zoning", bbox)
        county, n_county = zoning_lookup(BREVARD_ZONING, "ZONING", bbox)
        zoning = lambda g: city(g) or county(g)  # noqa: E731  City of Cocoa governs inside the city
        urls += [COCOA_ZONING, BREVARD_ZONING]
        zoning_note = (f"City of Cocoa zoning layer, field Zoning ({n_city} polygons), then Brevard County zoning "
                       f"layer, field ZONING ({n_county} polygons) for unincorporated parcels")
    feats, seen = [], set()
    for f in raw:
        if not f.get("geometry"):
            continue
        props = norm(f["properties"])
        if props["id"] in seen or props["id"] in ("None", ""):
            continue
        seen.add(props["id"])
        g = shape(f["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        if zoning:
            props["zoning_code"] = zoning(g)
        feats.append({"type": "Feature", "id": props["id"], "properties": props, "geometry": mapping(g)})
    d = fixture_dir(lid, "county")
    write_geojson(d / "parcels.geojson", feats)
    write_meta(d, "county_parcels", urls, where=where, zoning=zoning_note,
               houston_zoning="Houston has no zoning" if lid == "houston_downtown" else None)
    print(f"county: {len(feats)} parcels")


# ---------------------------------------------------------------- OSM
def configure_osmnx():
    import osmnx as ox
    ox.settings.cache_folder = str(settings.CACHE_DIR / "osmnx")
    ox.settings.use_cache = True
    ox.settings.requests_timeout = 300
    ox.settings.useful_tags_way = list(set(ox.settings.useful_tags_way) | {
        "sidewalk", "sidewalk:left", "sidewalk:right", "sidewalk:both", "footway", "cycleway", "cycleway:left",
        "cycleway:right", "cycleway:both"})


def _tag(row, key):
    v = row.get(key) if key in row else None
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else v


def osm_id(idx) -> str:
    el, i = idx if isinstance(idx, tuple) else ("way", idx)
    return f"osm:{i}" if el == "way" else f"osm:{el[0]}{i}"


OSM_API = "https://api.openstreetmap.org/api/0.6/map"
WALK_EXCLUDE = re.compile(r"abandoned|bus_guideway|construction|cycleway|motor|^no$|planned|platform|proposed|raceway|razed")


def _osm_tile(b) -> list:
    """One OSM API /map call (cached); split into quadrants when the API refuses (node limit)."""
    import xml.etree.ElementTree as ET
    try:
        raw = cached_get(OSM_API, {"bbox": ",".join(f"{v:.5f}" for v in b)}, fmt="bytes", timeout=180)
    except httpx.HTTPStatusError as e:
        if e.response.status_code != 400:
            raise
        mx, my = bbox_center(b)
        return [el for q in ((b[0], b[1], mx, my), (mx, b[1], b[2], my), (b[0], my, mx, b[3]), (mx, my, b[2], b[3]))
                for el in _osm_tile(q)]
    return list(ET.fromstring(raw))


def fetch_osm_xml(lid: str, b, tile: float = 0.01) -> tuple[Path, Path]:
    """Overpass is unreachable from the recording machine, so read the OSM editing API in tiles.

    Returns (full merged XML, walkable-highways-only XML) under cache/osm/.
    """
    import xml.etree.ElementTree as ET
    els: dict[tuple[str, str], ET.Element] = {}
    nx_, ny_ = math.ceil((b[2] - b[0]) / tile), math.ceil((b[3] - b[1]) / tile)
    for i in range(nx_):
        for j in range(ny_):
            t = (b[0] + i * tile, b[1] + j * tile, min(b[2], b[0] + (i + 1) * tile), min(b[3], b[1] + (j + 1) * tile))
            for el in _osm_tile(t):
                if el.tag in ("node", "way", "relation"):
                    els[(el.tag, el.get("id"))] = el
    out = settings.CACHE_DIR / "osm"
    out.mkdir(parents=True, exist_ok=True)
    order = {"node": 0, "way": 1, "relation": 2}
    items = sorted(els.items(), key=lambda kv: (order[kv[0][0]], int(kv[0][1])))

    def dump(path: Path, keep) -> None:
        root = ET.Element("osm", version="0.6", generator="tod-copilot")
        for _, el in items:
            if keep(el):
                root.append(el)
        ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)

    def walkable(el) -> bool:
        if el.tag == "node":
            return True
        if el.tag != "way":
            return False
        t = {c.get("k"): c.get("v") for c in el if c.tag == "tag"}
        hw = t.get("highway")
        return bool(hw) and t.get("area") != "yes" and not WALK_EXCLUDE.search(hw) and t.get("foot") != "no" \
            and t.get("service") != "private" and t.get("access") != "private"

    full, walk = out / f"{lid}.osm", out / f"{lid}_walk.osm"
    dump(full, lambda el: True)
    dump(walk, walkable)
    return full, walk


def record_osm(lid: str) -> None:
    import osmnx as ox
    configure_osmnx()
    b = tuple(load_locale_yaml(lid)["bbox"])
    d = fixture_dir(lid, "osm")
    full_xml, walk_xml = fetch_osm_xml(lid, b)
    from shapely.geometry import box
    poly = box(*b)
    # buildings
    bdf = ox.features_from_xml(full_xml, polygon=poly, tags={"building": True})
    bfeats = []
    for idx, row in bdf.iterrows():
        g = row.geometry
        if g is None or g.geom_type not in ("Polygon", "MultiPolygon"):
            continue
        props = {"id": osm_id(idx), "building": _tag(row, "building"), "levels": _tag(row, "building:levels"),
                 "height": _tag(row, "height"), "name": _tag(row, "name"), "amenity": _tag(row, "amenity"),
                 "parking": _tag(row, "parking"), "addr": join(_tag(row, "addr:housenumber"), _tag(row, "addr:street")) or None}
        bfeats.append({"type": "Feature", "properties": props, "geometry": mapping(g)})
    write_geojson(d / "buildings.geojson", bfeats)
    # features
    tags = {"amenity": ["school", "clinic", "doctors", "hospital", "charging_station", "parking"],
            "shop": ["supermarket", "grocery"], "leisure": ["park"], "railway": ["rail", "light_rail", "subway"],
            "highway": ["cycleway"], "cycleway": True, "cycleway:left": True, "cycleway:right": True,
            "cycleway:both": True}
    fdf = ox.features_from_xml(full_xml, polygon=poly, tags=tags)
    feats = []
    for idx, row in fdf.iterrows():
        g = row.geometry
        if g is None:
            continue
        am, kinds = _tag(row, "amenity"), []
        if am == "school":
            kinds.append("school")
        if am in ("clinic", "doctors", "hospital"):
            kinds.append("clinic")
        if am == "charging_station":
            kinds.append("ev_charger")
        if am == "parking" and _tag(row, "parking") in (None, "surface") and g.geom_type in ("Polygon", "MultiPolygon"):
            kinds.append("parking_surface")
        if _tag(row, "shop") in ("supermarket", "grocery"):
            kinds.append("grocery")
        if _tag(row, "leisure") == "park":
            kinds.append("park")
        if _tag(row, "railway") in ("rail", "light_rail", "subway") and g.geom_type in ("LineString", "MultiLineString"):
            kinds.append("rail")
        cyc = [_tag(row, k) for k in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both")]
        if g.geom_type in ("LineString", "MultiLineString") and (
                _tag(row, "highway") == "cycleway" or any(c not in (None, "no", "separate", "shared_lane") for c in cyc)):
            kinds.append("bike_lane")
        for k in kinds:
            props = {"id": osm_id(idx), "kind": k, "name": _tag(row, "name"),
                     "railway": _tag(row, "railway"), "parking": _tag(row, "parking")}
            feats.append({"type": "Feature", "properties": props, "geometry": mapping(g)})
    write_geojson(d / "features.geojson", feats)
    # walk graph
    G = ox.graph_from_xml(walk_xml, bidirectional=True, simplify=True, retain_all=False)
    nodes = [[int(n), round(a["x"], 7), round(a["y"], 7)] for n, a in G.nodes(data=True)]
    edges, seen = [], set()
    for u, v, a in G.edges(data=True):
        key = (min(u, v), max(u, v), round(a.get("length", 0), 1))
        if key in seen:
            continue
        seen.add(key)
        hw = a.get("highway")
        hw = hw[0] if isinstance(hw, list) else hw
        sw = None
        for k in ("sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right"):
            val = a.get(k)
            val = val[0] if isinstance(val, list) else val
            if val is not None:
                sw = val if k == "sidewalk" else ("yes" if val in ("yes", "separate") else val)
                if sw in ("both", "left", "right", "yes", "separate"):
                    break
        fw = a.get("footway")
        fw = fw[0] if isinstance(fw, list) else fw
        if hw == "footway" and fw == "sidewalk":
            sw = "footway_sidewalk"
        edges.append([int(u), int(v), round(float(a.get("length", 0)), 1), hw, sw])
    with gzip.open(d / "walk_graph.json.gz", "wt") as fh:
        json.dump({"nodes": nodes, "edges": edges}, fh, separators=(",", ":"))
    write_meta(d, "osm", [f"{OSM_API} (tiled bbox calls; Overpass unreachable), parsed with osmnx {ox.__version__}"], bbox=b)
    print(f"osm: {len(bfeats)} buildings, {len(feats)} features, {len(nodes)} nodes, {len(edges)} edges")


# ---------------------------------------------------------------- GTFS
def _read(z: zipfile.ZipFile, name: str, **kw) -> pd.DataFrame | None:
    names = {Path(n).name: n for n in z.namelist()}
    if name not in names:
        return None
    return pd.read_csv(z.open(names[name]), dtype=str, keep_default_na=False, **kw)


def _secs(t: str) -> int | None:
    try:
        h, m, s = (int(x) for x in t.split(":"))
        return h * 3600 + m * 60 + s
    except (ValueError, AttributeError):
        return None


def active_services(z: zipfile.ZipFile) -> tuple[set[str], str]:
    cal, cd = _read(z, "calendar.txt"), _read(z, "calendar_dates.txt")
    candidates = []
    if cal is not None and len(cal):
        start = max(min(cal.start_date), date.today().strftime("%Y%m%d"))
        candidates = [datetime.strptime(start, "%Y%m%d").date() + timedelta(days=i) for i in range(21)]
    elif cd is not None:
        candidates = sorted({datetime.strptime(x, "%Y%m%d").date() for x in cd.date})
    best, best_day = set(), ""
    for day in candidates:
        if day.weekday() != 1:  # Tuesday
            continue
        ds = day.strftime("%Y%m%d")
        svc = set()
        if cal is not None and len(cal):
            m = cal[(cal.tuesday == "1") & (cal.start_date <= ds) & (cal.end_date >= ds)]
            svc |= set(m.service_id)
        if cd is not None and len(cd):
            day_cd = cd[cd.date == ds]
            svc |= set(day_cd[day_cd.exception_type == "1"].service_id)
            svc -= set(day_cd[day_cd.exception_type == "2"].service_id)
        if len(svc) > len(best):
            best, best_day = svc, ds
    return best, best_day


def record_gtfs(lid: str) -> None:
    data = load_locale_yaml(lid)
    b = tuple(data["bbox"])
    keep_box = expand_bbox(b, 1000)
    routes_out, stops_out, rail_stations = [], {}, {}
    for url in GTFS[lid]:
        z = zipfile.ZipFile(io.BytesIO(cached_get(url, fmt="bytes", timeout=300)))
        stops, routes, trips = _read(z, "stops.txt"), _read(z, "routes.txt"), _read(z, "trips.txt")
        st = _read(z, "stop_times.txt", usecols=["trip_id", "stop_id", "departure_time", "stop_sequence"])
        shapes = _read(z, "shapes.txt")
        services, day = active_services(z)
        trips_today = trips[trips.service_id.isin(services)] if services else trips
        stops["lon"], stops["lat"] = stops.stop_lon.astype(float), stops.stop_lat.astype(float)
        near = stops[[in_bbox(x, y, keep_box) for x, y in zip(stops.lon, stops.lat)]]
        near_ids = set(near.stop_id)
        st_today = st[st.trip_id.isin(set(trips_today.trip_id))].copy()
        st_today["secs"] = st_today.departure_time.map(_secs)
        st_today["seq"] = st_today.stop_sequence.astype(int)
        trip_route = trips_today.set_index("trip_id")
        serving = st_today[st_today.stop_id.isin(near_ids)]
        route_ids = set(trip_route.loc[serving.trip_id.unique(), "route_id"])
        st_today = st_today.join(trip_route[["route_id", "direction_id", "shape_id"] if "shape_id" in trip_route
                                            else ["route_id", "direction_id"]], on="trip_id")
        if "direction_id" not in st_today:
            st_today["direction_id"] = "0"
        stop_routes = defaultdict(set)
        for sid, rid in zip(serving.stop_id, trip_route.loc[serving.trip_id, "route_id"]):
            stop_routes[sid].add(rid)
        stops_idx = stops.set_index("stop_id")
        route_hw = {}
        for rid in sorted(route_ids):
            r = routes[routes.route_id == rid].iloc[0]
            rtype = int(r.route_type)
            mode = "rail" if rtype in (0, 1, 2, 12) else "bus"
            rst = st_today[st_today.route_id == rid]
            hws = []
            for _, dst in rst.groupby("direction_id"):
                busiest = dst.stop_id.value_counts().idxmax()
                at = dst[dst.stop_id == busiest]
                peak = at[(at.secs >= 7 * 3600) & (at.secs < 9 * 3600)]
                if len(peak):
                    hws.append(120 / len(peak))
                elif len(at) > 1:
                    span = (at.secs.max() - at.secs.min()) / 60
                    hws.append(span / (len(at) - 1))
            hw = round(min(hws), 1) if hws else None
            route_hw[rid] = hw
            durations = rst.groupby("trip_id").secs.agg(lambda s: s.max() - s.min())
            cycle_h = round(float(statistics.median(durations)) * 2 / 3600, 2) if len(durations) else None
            geom = None
            if shapes is not None and "shape_id" in rst and rst.shape_id.notna().any():
                sid = rst.drop_duplicates("trip_id").shape_id.value_counts().idxmax()
                sh = shapes[shapes.shape_id == sid].copy()
                sh["seq"] = sh.shape_pt_sequence.astype(int)
                sh = sh.sort_values("seq")
                geom = LineString(list(zip(sh.shape_pt_lon.astype(float), sh.shape_pt_lat.astype(float))))
            if geom is None:
                tid = rst.trip_id.value_counts().idxmax()
                seq = rst[rst.trip_id == tid].sort_values("seq")
                geom = LineString([(stops_idx.loc[s, "lon"], stops_idx.loc[s, "lat"]) for s in seq.stop_id])
            geom = simplify(geom, 0.00003)
            color = r.get("route_color") or ("E3342F" if mode == "rail" else "8A8A8A")
            routes_out.append({"type": "Feature", "properties": {
                "route_id": rid, "short_name": r.get("route_short_name") or r.get("route_long_name"), "mode": mode,
                "route_type": rtype, "peak_headway_min": hw, "cycle_time_h": cycle_h, "color": f"#{color}",
                "service_day": day, "feed_url": url}, "geometry": mapping(geom)})
        for sid in near_ids:
            if sid not in stop_routes:
                continue
            row = stops_idx.loc[sid]
            rids = sorted(stop_routes[sid])
            hws = [route_hw[r] for r in rids if route_hw.get(r) is not None]
            stops_out[sid] = {"type": "Feature", "properties": {
                "stop_id": sid, "name": row.stop_name, "route_ids": rids,
                "peak_headway_min": min(hws) if hws else None,
                "rail": any(int(routes[routes.route_id == r].iloc[0].route_type) in (0, 1) for r in rids)},
                "geometry": {"type": "Point", "coordinates": [float(row.lon), float(row.lat)]}}
            rtypes = {int(routes[routes.route_id == r].iloc[0].route_type) for r in rids}
            if rtypes & {0, 1} and in_bbox(float(row.lon), float(row.lat), b):
                name = re.sub(r"\s+(NB|SB|EB|WB)$", "", row.stop_name.split(" - ")[0].strip())
                name = re.sub(r"\bStn\b", "Station", name)
                mode = "heavy_rail" if 1 in rtypes else "light_rail"
                rail_stations.setdefault(name, []).append((float(row.lon), float(row.lat), mode, url))
    d = fixture_dir(lid, "gtfs")
    write_geojson(d / "routes.geojson", routes_out)
    write_geojson(d / "stops.geojson", list(stops_out.values()))
    write_meta(d, "gtfs", GTFS[lid])
    if lid in ("houston_downtown", "la_wilshire_koreatown"):
        data = load_locale_yaml(lid)
        data["stations"] = [{"name": n, "lonlat": [round(sum(p[0] for p in pts) / len(pts), 6),
                                                   round(sum(p[1] for p in pts) / len(pts), 6)],
                             "mode": pts[0][2], "source_url": pts[0][3]} for n, pts in sorted(rail_stations.items())]
        save_locale_yaml(lid, data)
        print(f"stations: {[s['name'] for s in data['stations']]}")
    print(f"gtfs: {len(routes_out)} routes, {len(stops_out)} stops")


# ---------------------------------------------------------------- demand
def record_demand(lid: str) -> None:
    data = load_locale_yaml(lid)
    b = expand_bbox(tuple(data["bbox"]), 400)
    st_abbr = STATE[lid][0]
    blocks = arcgis_query(f"{TIGER}/2", b, out_fields="GEOID,INTPTLAT,INTPTLON,HU100", geometry=False)
    # This hosted layer caps pages at 50 and rejects paged geojson queries; one f=json centroid query suffices.
    tq = {"where": "1=1", "geometry": ",".join(f"{v:.6f}" for v in b), "geometryType": "esriGeometryEnvelope",
          "inSR": 4326, "outSR": 4326, "outFields": "GEOID,B08201_002E", "returnGeometry": "false",
          "returnCentroid": "true", "f": "json"}
    tr = cached_get(f"{ACS_VEHICLES}/query", tq)
    if "error" in tr or tr.get("exceededTransferLimit"):
        evict(f"{ACS_VEHICLES}/query", tq)
        raise RuntimeError(f"ACS tract query failed or truncated: {tr.get('error')}")
    tracts = tr["features"]
    lodes_url = None
    for year in (2024, 2023, 2022):
        url = f"https://lehd.ces.census.gov/data/lodes/LODES8/{st_abbr}/wac/{st_abbr}_wac_S000_JT00_{year}.csv.gz"
        try:
            raw = cached_get(url, fmt="bytes", timeout=300)
            lodes_url = url
            break
        except Exception:
            continue
    block_ids = {f["properties"]["GEOID"] for f in blocks}
    jobs = {}
    with gzip.open(io.BytesIO(raw), "rt") as fh:
        for row in csv.DictReader(fh):
            if row["w_geocode"] in block_ids:
                jobs[row["w_geocode"]] = int(row["C000"])
    points = []
    for f in blocks:
        p = f["properties"]
        homes = int(p.get("HU100") or 0)
        if jobs.get(p["GEOID"]) or homes:
            points.append({"lonlat": [float(p["INTPTLON"]), float(p["INTPTLAT"])], "jobs": jobs.get(p["GEOID"], 0),
                           "homes": homes, "zero_car": 0, "geoid": p["GEOID"]})
    for f in tracts:
        p, c = f["attributes"], f.get("centroid")
        if c and p.get("B08201_002E"):
            points.append({"lonlat": [round(c["x"], 6), round(c["y"], 6)], "jobs": 0, "homes": 0,
                           "zero_car": int(p["B08201_002E"]), "geoid": p["GEOID"]})
    d = fixture_dir(lid, "demand")
    (d / "points.json").write_text(json.dumps(points, separators=(",", ":")))
    write_meta(d, "census_lodes_acs", [lodes_url, f"{TIGER}/2", ACS_VEHICLES],
               note=("LODES8 WAC C000 jobs per 2020 block; 2020 Census HU100 housing units per block (TIGERweb); "
                     "ACS 2019-2023 B08201_002E zero-vehicle households per tract (Esri Living Atlas), placed at the "
                     "tract's interior point. The Census Data API now requires a key, so ACS block groups were not used."))
    print(f"demand: {len(points)} points, jobs={sum(p['jobs'] for p in points)}, homes={sum(p['homes'] for p in points)}")


# ---------------------------------------------------------------- FEMA
def record_fema(lid: str) -> None:
    b = tuple(load_locale_yaml(lid)["bbox"])
    feats = arcgis_query(FEMA, b, where="SFHA_TF='T'", out_fields="FLD_ZONE,ZONE_SUBTY,SFHA_TF,DFIRM_ID")
    out = [{"type": "Feature", "properties": {"FLD_ZONE": f["properties"]["FLD_ZONE"],
                                              "ZONE_SUBTY": f["properties"].get("ZONE_SUBTY")},
            "geometry": f["geometry"]} for f in feats if f.get("geometry")]
    d = fixture_dir(lid, "fema")
    write_geojson(d / "flood_zones.geojson", out)
    write_meta(d, "fema", [FEMA], where="SFHA_TF='T'")
    print(f"fema: {len(out)} SFHA polygons")


# ---------------------------------------------------------------- NREL (AFDC, PVWatts)
def record_afdc(lid: str) -> None:
    b = tuple(load_locale_yaml(lid)["bbox"])
    url = "https://developer.nlr.gov/api/alt-fuel-stations/v1/nearest.json"  # NREL API host moved to nlr.gov
    params = {"fuel_type": "ELEC", "api_key": settings.NREL_API_KEY, "limit": "all",
              "latitude": f"{(b[1] + b[3]) / 2:.5f}", "longitude": f"{(b[0] + b[2]) / 2:.5f}", "radius": "3"}
    for attempt in range(3):
        try:
            d = cached_get(url, params, timeout=30)
            break
        except Exception as e:  # unreachable: OSM charging stations are the fallback
            print(f"afdc attempt {attempt + 1} failed: {e}")
    else:
        print("afdc: unreachable; skipped (OSM amenity=charging_station is the fallback)")
        return
    feats = [{"type": "Feature", "properties": {"name": s.get("station_name"), "id": s.get("id")},
              "geometry": {"type": "Point", "coordinates": [s["longitude"], s["latitude"]]}}
             for s in d.get("fuel_stations", []) if in_bbox(s["longitude"], s["latitude"], b)]
    out = fixture_dir(lid, "afdc")
    write_geojson(out / "stations.geojson", feats)
    write_meta(out, "afdc", [url])
    print(f"afdc: {len(feats)} stations")


def record_pvwatts(lid: str) -> None:
    b = tuple(load_locale_yaml(lid)["bbox"])
    lon, lat = bbox_center(b)
    url = "https://developer.nlr.gov/api/pvwatts/v8.json"  # NREL API host moved to nlr.gov
    params = {"api_key": settings.NREL_API_KEY, "system_capacity": 1, "module_type": 0, "losses": 14,
              "array_type": 1, "tilt": 20, "azimuth": 180, "lat": f"{lat:.4f}", "lon": f"{lon:.4f}"}
    for attempt in range(3):
        try:
            d = cached_get(url, params, timeout=30)
            break
        except Exception as e:
            print(f"pvwatts attempt {attempt + 1} failed: {e}")
    else:
        print("pvwatts: unreachable; skipped (factor solar_kwh_per_kw_year is the fallback)")
        return
    out = fixture_dir(lid, "pvwatts")
    (out / "solar.json").write_text(json.dumps({"annual_kwh_per_kw": d["outputs"]["ac_annual"], "lonlat": [lon, lat]}))
    write_meta(out, "pvwatts", [url])
    print(f"pvwatts: {d['outputs']['ac_annual']:.0f} kWh/kW/yr")


# ---------------------------------------------------------------- utilities
def record_utilities(lid: str) -> None:
    b = tuple(load_locale_yaml(lid)["bbox"])
    notes = settings.FIXTURES_DIR / lid / "_notes.md"
    layers = {"la_wilshire_koreatown": [("sewer_main", LA_SEWER, "LA Sanitation sewer pipes")],
              "brevard_cocoa": [("sewer_main", COCOA_SEWER_AREA, "City of Cocoa sewer service area"),
                                ("water_main", COCOA_WATER_AREA, "City of Cocoa water service area")]}.get(lid, [])
    if not layers:
        notes.write_text("# Data notes\n\n- TODO(kickoff): no public water, sewer or power layer found for this locale "
                         "(searched City of Houston and Harris County ArcGIS directories). Utilities are missing; the "
                         "infrastructure agent reports \"utility data not public here; confirm with the utility\".\n")
        print("utilities: none public; noted")
        return
    d = fixture_dir(lid, "utilities")
    for kind, url, label in layers:
        feats = arcgis_query(url, b, out_fields="OBJECTID")
        out = [{"type": "Feature", "properties": {"kind": kind, "layer": label},
                "geometry": f["geometry"]} for f in feats if f.get("geometry")]
        write_geojson(d / f"{kind}.geojson", out)
        print(f"utilities: {kind} {len(out)} features ({label})")
    write_meta(d, "city_open_data", [u for _, u, _ in layers], layers={k: lbl for k, _, lbl in layers})
    notes.write_text("# Data notes\n\n- No power layer is public here; power is treated as missing.\n"
                     "- TODO(kickoff): broadband (FCC National Broadband Map) needs an account token; missing.\n")


# ---------------------------------------------------------------- CoStar-shaped fixtures (hand-entered)
def record_costar(lid: str) -> None:
    """Link hand-entered buildings_source.yaml to OSM footprints and county parcels; write costar/*.json."""
    d = settings.FIXTURES_DIR / lid / "costar"
    src = d / "buildings_source.yaml"
    if not src.exists():
        print("costar: no buildings_source.yaml; skipped")
        return
    entries = yaml.safe_load(src.read_text()) or []
    bfc = json.loads((settings.FIXTURES_DIR / lid / "osm" / "buildings.geojson").read_text())["features"]
    pfc = json.loads((settings.FIXTURES_DIR / lid / "county" / "parcels.geojson").read_text())["features"]
    bgeoms = [shape(f["geometry"]) for f in bfc]
    pgeoms = [shape(f["geometry"]) for f in pfc]
    btree, ptree = STRtree(bgeoms), STRtree(pgeoms)
    buildings, parcels, unlinked = [], [], []
    for e in entries:
        pt = Point(*e["lonlat"])
        # Geocodes land on the street side or on small structures; named towers are the largest footprint
        # within ~25 m of the geocoded point.
        hits = [i for i in btree.query(pt.buffer(0.00025), predicate="intersects")]
        if not hits:  # nearest footprint within ~40 m
            i = btree.nearest(pt)
            hits = [i] if bgeoms[i].distance(pt) < 0.0004 else []
        if not hits:
            unlinked.append(e.get("name") or e["address"])
            continue
        bi = max(hits, key=lambda i: bgeoms[i].area)
        bid = bfc[bi]["properties"]["id"]
        c = bgeoms[bi].representative_point()
        ph = [i for i in ptree.query(c, predicate="intersects")] or [i for i in ptree.query(pt, predicate="intersects")]
        pid = max(ph, key=lambda i: pgeoms[i].intersection(bgeoms[bi]).area) if ph else None
        fields = {k: v for k, v in (e.get("fields") or {}).items() if v and v.get("value") is not None}
        if e.get("name"):
            fields["name"] = {"value": e["name"], "source_url": next(iter(fields.values()))["source_url"] if fields
                              else e.get("geocode_url"), "note": e.get("address")}
        if e.get("address"):
            fields["address"] = {"value": e["address"], "source_url": e.get("geocode_url"), "note": "geocoded address"}
        buildings.append({"id": bid, "parcel_id": pfc[pid]["properties"]["id"] if pid is not None else None,
                          "fields": fields})
        pf = {k: v for k, v in (e.get("parcel_fields") or {}).items() if v and v.get("value") is not None}
        if pf and pid is not None:
            parcels.append({"id": pfc[pid]["properties"]["id"], "fields": pf})
    (d / "buildings.json").write_text(json.dumps(buildings, indent=1))
    (d / "parcels.json").write_text(json.dumps(parcels, indent=1))
    if not (d / "leases.json").exists():
        (d / "leases.json").write_text("[]")
    write_meta(d, "costar_fixture", [str(src.relative_to(ROOT))],
               note="hand-entered from cited public reporting; TODO(kickoff): replace with CoStar export")
    print(f"costar: {len(buildings)} buildings linked, {len(parcels)} parcels; unlinked: {unlinked}")


STEPS = {"station": record_station, "county": record_county, "osm": record_osm, "gtfs": record_gtfs,
         "demand": record_demand, "fema": record_fema, "afdc": record_afdc, "pvwatts": record_pvwatts,
         "utilities": record_utilities, "costar": record_costar}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locale", required=True, choices=["houston_downtown", "la_wilshire_koreatown", "brevard_cocoa"])
    ap.add_argument("--only", default=",".join(STEPS))
    a = ap.parse_args()
    for name in a.only.split(","):
        print(f"== {a.locale}: {name}")
        STEPS[name](a.locale)


if __name__ == "__main__":
    main()
