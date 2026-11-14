"""Plan areas: a whole recorded locale, a drawn sub-area inside one, or an experimental custom area elsewhere in
the US that is recorded live into cache/areas/<id>/."""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal, Optional
from uuid import uuid4

import yaml
from shapely.geometry import box, shape

from backend.data.geo import to_utm
from backend.data.locales import LOCALE_IDS, get_locale, locale_dir

CUSTOM_STEPS = ("osm", "gtfs", "demand", "fema", "afdc", "pvwatts", "fcc", "costar", "matterport")


class AreaError(ValueError):
    pass


@dataclass
class AreaResolution:
    kind: Literal["recorded", "subarea", "custom"]
    locale_id: Optional[str]
    boundary: Optional[dict]


def utm_epsg(lon: float, lat: float) -> int:
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


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
        bb = box(*loc.bbox)
        if g.within(bb):
            return AreaResolution("subarea", lid, boundary)
        if g.intersects(bb):
            raise AreaError(f"boundary crosses the edge of the recorded {loc.name} area: draw it fully inside, "
                            "or fully outside to run a custom area")
    return AreaResolution("custom", None, boundary)


def create_custom_area(name: str, boundary: dict, step: Callable[[str], None]) -> str:
    """Record public data (plus CoStar/Matterport where the local kit covers it) for a drawn area. Returns its id."""
    from backend.data import record
    area_id = f"area-{uuid4().hex[:8]}"
    d = locale_dir(area_id)
    d.mkdir(parents=True)
    g = shape(boundary)
    c = g.centroid
    (d / "locale.yaml").write_text(yaml.safe_dump({
        "id": area_id, "name": f"{name} (custom)",
        "purpose": "Experimental custom area: public data recorded live; CoStar and Matterport only where the kit "
                   "covers it",
        "data_tier": "public_only", "jurisdiction": "custom", "bbox": [round(v, 6) for v in g.bounds],
        "boundary": boundary, "utm_epsg": utm_epsg(c.x, c.y), "county_fips": "00000", "transit_agency": "unknown",
        "stations": [], "experimental": True, "aliases": []}, sort_keys=False, allow_unicode=True))
    record.NOW = datetime.now(timezone.utc).isoformat()   # provenance time of this recording, not of server start
    failures = []
    for s in CUSTOM_STEPS:
        step(f"Recording {s} for {name}")
        try:
            record.STEPS[s](area_id)
        except Exception as e:  # one missing source must not sink the area; its data stays missing
            msg = f"{s} failed: {type(e).__name__}: {e}"[:300]
            step(msg)
            failures.append(msg)
    if failures:   # appended last: the fcc step rewrites _notes.md
        with (d / "_notes.md").open("a") as fh:
            fh.write("".join(f"- {m}\n" for m in failures))
    cs = d / "costar" / "buildings.json"
    if cs.exists() and cs.read_text().strip() not in ("", "[]"):
        data = yaml.safe_load((d / "locale.yaml").read_text())
        data["data_tier"] = "costar_full"
        (d / "locale.yaml").write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))
    get_locale.cache_clear()
    return area_id
