"""Monthly rent per unit from the Zillow Observed Rent Index (ZORI), a public CSV with no key:
https://www.zillow.com/research/data/ (Rentals > ZORI, all homes plus multifamily, smoothed, ZIP level).

Which ZIPs count: every ZIP (Census ZCTA) whose internal point lies inside the bbox, plus the ZIP nearest to each
station (by ZCTA internal point, Census 2024 Gazetteer). The value is the median of those ZIPs' latest ZORI; ZIPs
without a ZORI series are listed as missing, never filled. Downloads go through cached_get.
"""
import csv
import io
import math
import statistics
import zipfile
from typing import Optional

from backend.data.http_cache import cached_get, retrieved_at

ZORI_URL = "https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv"
GAZ_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip"


def zcta_points() -> dict[str, tuple[float, float]]:
    """ZCTA -> (lon, lat) internal point."""
    raw = cached_get(GAZ_URL, fmt="bytes", timeout=120)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        text = z.read(z.namelist()[0]).decode("utf-8")
    rows = csv.reader(io.StringIO(text), delimiter="\t")
    head = [h.strip() for h in next(rows)]
    i_id, i_lat, i_lon = head.index("GEOID"), head.index("INTPTLAT"), head.index("INTPTLONG")
    return {r[i_id].strip(): (float(r[i_lon]), float(r[i_lat])) for r in rows if r}


def zori_latest() -> tuple[str, dict[str, float]]:
    """(month, ZIP -> latest ZORI) for ZIPs with a value in the latest month."""
    text = cached_get(ZORI_URL, fmt="text", timeout=120)
    rows = csv.reader(io.StringIO(text))
    head = next(rows)
    i_zip, month = head.index("RegionName"), head[-1]
    out = {}
    for r in rows:
        if r and r[-1]:
            out[r[i_zip].zfill(5)] = float(r[-1])
    return month, out


def zips_for(bbox, stations: list[tuple[str, tuple[float, float]]],
             points: dict[str, tuple[float, float]]) -> dict[str, str]:
    """ZIP -> why it was picked (inside the bbox, or nearest to a named station)."""
    w, s, e, n = bbox
    why: dict[str, str] = {z: "inside bbox" for z, (x, y) in points.items() if w <= x <= e and s <= y <= n}
    for name, (lon, lat) in stations:
        k = math.cos(math.radians(lat))
        z = min(points, key=lambda z: ((points[z][0] - lon) * k) ** 2 + (points[z][1] - lat) ** 2)
        why.setdefault(z, f"nearest to {name}")
    return dict(sorted(why.items()))


def zori_rent(bbox, stations: list[tuple[str, tuple[float, float]]]) -> Optional[dict]:
    """{value, zips, missing, month, url, retrieved_at, note}, or None when no picked ZIP has a ZORI value."""
    why = zips_for(bbox, stations, zcta_points())
    if not why:   # a box with no ZCTA point inside and no stations: use the ZIP nearest the box centre
        why = zips_for(bbox, [("area centre", ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2))], zcta_points())
    month, zori = zori_latest()
    have = {z: zori[z] for z in why if z in zori}
    if not have:
        return None
    value = round(statistics.median(have.values()))
    missing = [z for z in why if z not in zori]
    return {"value": value, "zips": have, "missing": missing, "month": month, "url": ZORI_URL,
            "retrieved_at": retrieved_at(ZORI_URL),
            "note": (f"median of the latest ZORI ({month}) over ZIP(s) {', '.join(sorted(have))}"
                     + (f"; no ZORI series for {', '.join(missing)}" if missing else ""))}
