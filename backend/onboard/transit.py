"""Transit feeds for a county, deterministically from the Mobility Database catalog (no LLM): every active US GTFS
feed whose bounding box intersects the county and spans at most a region (drops national and statewide feeds).
GTFS-Flex variants are dropped: they repeat their agency's fixed-route feed plus demand-response zones, which the
GTFS step does not model, and would double every route."""
import csv
import io
import re

from shapely.geometry import box

from backend.data.http_cache import cached_get
from backend.onboard import geo, registry
from backend.onboard.common import stamp

CATALOG_URL = "https://files.mobilitydatabase.org/feeds_v2.csv"
MAX_SPAN_DEG = 5.0
BB = "location.bounding_box."


def feeds_for(bbox) -> list[dict]:
    """[{id, url, provider}] sorted by id."""
    text = cached_get(CATALOG_URL, fmt="text", timeout=120)
    area = box(*bbox)
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        if (r.get("data_type") != "gtfs" or r.get("location.country_code") != "US"
                or r.get("status") not in ("active", "") or not r.get("urls.latest")
                or re.search(r"\bflex\b", r.get("name") or "", re.I)):
            continue
        try:
            s, n = float(r[BB + "minimum_latitude"]), float(r[BB + "maximum_latitude"])
            w, e = float(r[BB + "minimum_longitude"]), float(r[BB + "maximum_longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        if n - s > MAX_SPAN_DEG or e - w > MAX_SPAN_DEG or not box(w, s, e, n).intersects(area):
            continue
        out.append({"id": r["id"], "url": r["urls.latest"], "provider": (r.get("provider") or "").strip()})
    return sorted(out, key=lambda f: f["id"])


def ensure_transit(fips: str) -> dict:
    """Write the county's transit_feeds section (agent_verified, or not_found); never replaces a reviewed one."""
    c = registry.county(fips)
    if registry.section_status(c.get("transit_feeds")) == "reviewed":
        return c["transit_feeds"]
    try:
        feeds = feeds_for(geo.county_bbox(fips))
        section = stamp("agent_verified" if feeds else "not_found", "mobility-database-catalog", feeds=feeds,
                        source_url=CATALOG_URL)
        if not feeds:
            section["reason"] = "no active regional GTFS feed in the Mobility Database covers this county"
    except Exception as e:   # catalog unreachable or its columns changed: record nothing rather than guess
        section = stamp("not_found", "mobility-database-catalog", feeds=[],
                        reason=f"Mobility Database catalog unavailable ({type(e).__name__})")
    c = registry.county(fips)
    c["transit_feeds"] = section
    registry.save_county(fips, c)
    return section
