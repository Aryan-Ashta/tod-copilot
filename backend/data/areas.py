"""Plan areas: a whole recorded locale, a drawn sub-area inside one (recorded data), or a drawn area anywhere in
Harris County (Houston) or Los Angeles County, recorded live into cache/areas/<id>/ from the same county, CoStar,
Matterport and Vexcel sources as its metro's recorded locale. Nothing outside those two counties is supported."""
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from typing import Callable, Literal, Optional
from uuid import uuid4

import yaml
from shapely.geometry import Point, box, shape

from backend.data.geo import to_utm
from backend.data.locales import LOCALE_IDS, get_locale, locale_dir
from backend.settings import FIXTURES_DIR

METROS_PATH = FIXTURES_DIR / "metros" / "outlines.geojson"
COUNTY_EDGE_TOLERANCE_DEG = 0.005   # outlines are simplified to ~50 m; allow drawing right up to the county line
METRO_STEPS = ("osm", "county", "gtfs", "demand", "fema", "afdc", "pvwatts", "utilities", "fcc", "costar",
               "matterport", "vexcel")
NOT_SUPPORTED = "only Harris County (Houston) and Los Angeles County are supported: draw the boundary inside one of them"


class AreaError(ValueError):
    pass


@dataclass
class AreaResolution:
    kind: Literal["recorded", "subarea", "metro"]
    locale_id: Optional[str]          # recorded locale (recorded/subarea) or None until a metro area is recorded
    boundary: Optional[dict]
    sources_from: Optional[str] = None
    jurisdiction: Optional[str] = None
    county_fips: Optional[str] = None
    label: Optional[str] = None       # "City of Houston", "Los Angeles County outside the City of Los Angeles"
    area_km2: Optional[float] = None


@lru_cache(maxsize=1)
def metro_outlines() -> dict:
    return json.loads(METROS_PATH.read_text())


def metro_county(lon: float, lat: float) -> Optional[str]:
    """Name of the supported county containing the point, or None."""
    p = Point(lon, lat)
    return next((f["properties"]["name"] for f in metro_outlines()["features"]
                 if f["properties"]["kind"] == "county" and shape(f["geometry"]).contains(p)), None)


def _county_label(name: str) -> str:
    return name if name.endswith("County") else f"{name} County"


def utm_epsg(lon: float, lat: float) -> int:
    return (32600 if lat >= 0 else 32700) + int((lon + 180) // 6) + 1


def resolve_area(locale_id: Optional[str], boundary: Optional[dict], f_max_km2: float) -> AreaResolution:
    if boundary is None:
        if locale_id not in LOCALE_IDS:
            raise AreaError("pick a recorded area or draw a boundary")
        return AreaResolution("recorded", locale_id, None)
    try:
        g = shape(boundary)
    except Exception as e:
        raise AreaError("boundary must be a valid polygon") from e
    if g.geom_type not in ("Polygon", "MultiPolygon") or not g.is_valid or g.is_empty:
        raise AreaError("boundary must be a valid polygon")
    c = g.centroid
    a = to_utm(g, utm_epsg(c.x, c.y)).area / 1e6
    if a > f_max_km2:
        raise AreaError(f"boundary is {a:.1f} km²; draw at most {f_max_km2:g} km²")
    for lid in LOCALE_IDS:
        loc = get_locale(lid)
        if g.within(box(*loc.bbox)):
            return AreaResolution("subarea", lid, boundary, sources_from=lid, jurisdiction=loc.jurisdiction,
                                  county_fips=loc.county_fips, label=f"Inside {loc.name}", area_km2=round(a, 2))
    feats = metro_outlines()["features"]
    county = next((f for f in feats if f["properties"]["kind"] == "county"
                   and g.within(shape(f["geometry"]).buffer(COUNTY_EDGE_TOLERANCE_DEG))), None)
    if county is None:
        raise AreaError(NOT_SUPPORTED)
    src = county["properties"]["sources_from"]
    city = next(f for f in feats if f["properties"]["kind"] == "place" and f["properties"]["sources_from"] == src)
    cname = city["properties"]["name"].removesuffix(" city")
    county_name = _county_label(county["properties"]["name"].removesuffix(" County"))
    # Legal rules follow the city the area mostly lies in; outside the city there is no corpus (not covered).
    in_city = g.intersection(shape(city["geometry"])).area >= 0.5 * g.area
    if in_city:
        jur, label = city["properties"]["jurisdiction"], f"City of {cname}"
    else:
        jur = f"{county_name.lower().replace(' ', '_')}_outside_{cname.lower().replace(' ', '_')}"
        label = f"{county_name} outside the City of {cname}"
    return AreaResolution("metro", None, boundary, sources_from=src, jurisdiction=jur,
                          county_fips=county["properties"]["geoid"], label=label, area_km2=round(a, 2))


def record_area(name: str, res: AreaResolution, step: Callable[[str], None]) -> str:
    """Record a drawn metro area with its metro's sources. Returns the new locale id."""
    from backend.data import record
    src = get_locale(res.sources_from)
    area_id = f"area-{uuid4().hex[:8]}"
    d = locale_dir(area_id)
    d.mkdir(parents=True)
    g = shape(res.boundary)
    (d / "locale.yaml").write_text(yaml.safe_dump({
        "id": area_id, "name": f"{name} ({res.label})",
        "purpose": f"Drawn area in {res.label}, recorded live from the same county, CoStar, Matterport and Vexcel "
                   f"sources as {src.name}",
        "data_tier": "public_only", "jurisdiction": res.jurisdiction, "bbox": [round(v, 6) for v in g.bounds],
        "boundary": res.boundary, "utm_epsg": src.utm_epsg, "county_fips": res.county_fips,
        "transit_agency": src.transit_agency, "stations": [], "aliases": [], "sources_from": res.sources_from},
        sort_keys=False, allow_unicode=True))
    record.NOW = datetime.now(timezone.utc).isoformat()   # provenance time of this recording, not of server start
    failures = []
    for s in METRO_STEPS:
        step(f"Recording {s} for {name}")
        try:
            record.STEPS[s](area_id)
        except Exception as e:  # one failed source must not sink the area; its data stays missing
            msg = f"{s} failed: {type(e).__name__}: {e}"[:300]
            step(msg)
            failures.append(msg)
        get_locale.cache_clear()   # steps rewrite locale.yaml (stations, data tier)
        if s == "costar":
            cs = d / "costar" / "buildings.json"
            if cs.exists() and cs.read_text().strip() not in ("", "[]"):
                data = yaml.safe_load((d / "locale.yaml").read_text())
                data["data_tier"] = "costar_full"   # matterport and the providers key off the tier
                (d / "locale.yaml").write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
    if failures:   # appended last: the fcc and utilities steps rewrite _notes.md
        with (d / "_notes.md").open("a") as fh:
            fh.write("".join(f"- {m}\n" for m in failures))
    get_locale.cache_clear()
    return area_id
