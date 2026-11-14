"""Plan areas: a whole recorded locale, a drawn sub-area inside one (recorded data), or a drawn area in any US
county, recorded live into cache/areas/<id>/ from the county's registry sources (backend/registry, filled by the
onboarding agents in backend/onboard). Licensed sources (CoStar, Matterport, Vexcel) only run where the county lists
them."""
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Literal, Optional
from uuid import uuid4

import httpx
import yaml
from shapely.geometry import box, shape

from backend import settings
from backend.data.geo import to_utm
from backend.data.http_cache import OfflineCacheMiss
from backend.data.locales import LOCALE_IDS, get_locale, locale_dir
from backend.onboard import geo, registry

COUNTY_EDGE_TOLERANCE_DEG = 0.005   # outlines are simplified to ~50 m; allow drawing right up to the county line
METRO_STEPS = ("osm", "county", "gtfs", "demand", "fema", "afdc", "pvwatts", "local_factors", "utilities", "fcc",
               "costar", "matterport", "vexcel")
LICENSED_STEPS = ("costar", "matterport", "vexcel")
# Last step, gated by AREA_RESEARCH (off by default): agent research (docs/12 §8.2). It runs after the area's plan is
# shown (backend/app.py), never inside record_area, so recording needs no LLM key and the plan never waits on it.
METRO_BACKGROUND_STEPS = ("agent_research",) if settings.AREA_RESEARCH else ()
NOT_SUPPORTED = "draw the boundary inside one US county"
NEEDS_NETWORK = "finding the county needs the network; with DEMO_OFFLINE=1 draw inside a recorded box"


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
    label: Optional[str] = None       # "City of Houston", "Harris County (outside city limits)"
    area_km2: Optional[float] = None


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
    try:
        county = geo.county_at(c.x, c.y)
        if county is None or not g.within(county["geometry"].buffer(COUNTY_EDGE_TOLERANCE_DEG)):
            raise AreaError(NOT_SUPPORTED)
        places = geo.places_in(g.bounds)
    except (OfflineCacheMiss, httpx.HTTPError) as e:
        raise AreaError(NEEDS_NETWORK) from e
    fips = county["geoid"]
    # Legal rules follow the city the area mostly lies in; outside any city, the county's.
    shares = [(g.intersection(p["geometry"]).area / g.area, p) for p in places]
    share, place = max(shares, key=lambda t: t[0], default=(0.0, None))
    if place is not None and share >= 0.5:
        jur, label = place["jurisdiction"], f"City of {place['basename']}"
    else:
        jur = registry.county_jurisdiction(registry.county(fips) or {"state": fips[:2], "name": county["name"]})
        label = f"{county['name']} (outside city limits)"
    return AreaResolution("metro", None, boundary, sources_from=registry.county(fips).get("recorded_locale"),
                          jurisdiction=jur, county_fips=fips, label=label, area_km2=round(a, 2))


def record_area(name: str, res: AreaResolution, step: Callable[[str], None]) -> str:
    """Onboard the county if needed, then record a drawn area from its registry sources. Returns the new locale id."""
    from backend.data import record
    from backend.onboard.run import onboard_county
    area_id = f"area-{uuid4().hex[:8]}"
    d = locale_dir(area_id)
    d.mkdir(parents=True)
    g = shape(res.boundary)
    failures = list(onboard_county(res.county_fips, g.bounds, step=step)["errors"])
    county = registry.county(res.county_fips)
    if res.sources_from:
        src = get_locale(res.sources_from)
        epsg, agency = src.utm_epsg, src.transit_agency
        purpose = (f"Drawn area in {res.label}, recorded live from the same county sources as {src.name}")
    else:
        epsg = utm_epsg(*g.centroid.coords[0])
        feeds = (county.get("transit_feeds") or {}).get("feeds") or []
        agency = ", ".join(dict.fromkeys(f["provider"] for f in feeds if f.get("provider")))
        purpose = f"Drawn area in {res.label}, recorded live from the county's onboarded public sources"
    (d / "locale.yaml").write_text(yaml.safe_dump({
        "id": area_id, "name": f"{name} ({res.label})", "purpose": purpose,
        "data_tier": "public_only", "jurisdiction": res.jurisdiction, "bbox": [round(v, 6) for v in g.bounds],
        "boundary": res.boundary, "utm_epsg": epsg, "county_fips": res.county_fips,
        "transit_agency": agency, "stations": [], "aliases": [], "sources_from": res.sources_from},
        sort_keys=False, allow_unicode=True))
    record.NOW = datetime.now(timezone.utc).isoformat()   # provenance time of this recording, not of server start
    licensed = set(county.get("licensed_sources") or [])
    for s in METRO_STEPS:
        if s in LICENSED_STEPS and s not in licensed:
            step(f"Skipping {s}: not licensed for this county")
            continue
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
