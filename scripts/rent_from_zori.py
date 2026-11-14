"""Derive `rent_usd_per_unit_month` per locale from the Zillow Observed Rent Index (ZORI), replacing RentCafe.

RentCafe blocks scripted access (HTTP 403), so its figures cannot be re-checked. ZORI is a public CSV with no key:
https://www.zillow.com/research/data/ (Rentals > ZORI, all homes plus multifamily, smoothed, ZIP level).

Which ZIPs count for a locale: every ZIP (Census ZCTA) whose internal point lies inside the locale bbox, plus the
ZIP nearest to each station (by ZCTA internal point, Census 2024 Gazetteer). The locale value is the median of
those ZIPs' latest ZORI; ZIPs without a ZORI series are listed as missing, never filled.

Usage:
  uv run python scripts/rent_from_zori.py            # all three locales
  uv run python scripts/rent_from_zori.py --locale houston_downtown

Downloads go through backend.data.http_cache (cache/http), so a second run, or DEMO_OFFLINE=1, reads the cache.
Prints the derivation; copy the values and the note into backend/data/factors.yaml by hand.
"""
import argparse
import csv
import io
import math
import statistics
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.data.factors import LOCALE_IDS  # noqa: E402
from backend.data.http_cache import cached_get, retrieved_at  # noqa: E402
from backend.data.locales import get_locale  # noqa: E402

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


def locale_zips(locale_id: str, points: dict[str, tuple[float, float]]) -> tuple[list[str], dict[str, str]]:
    """ZIPs for a locale and why each was picked."""
    loc = get_locale(locale_id)
    w, s, e, n = loc.bbox
    why: dict[str, str] = {z: "inside bbox" for z, (x, y) in points.items() if w <= x <= e and s <= y <= n}
    for st in loc.stations:
        lon, lat = st.lonlat
        k = math.cos(math.radians(lat))
        z = min(points, key=lambda z: ((points[z][0] - lon) * k) ** 2 + (points[z][1] - lat) ** 2)
        why.setdefault(z, f"nearest to {st.name}")
    return sorted(why), why


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locale", choices=LOCALE_IDS)
    a = ap.parse_args()
    points = zcta_points()
    month, zori = zori_latest()
    print(f"ZORI month {month} (retrieved {retrieved_at(ZORI_URL)}); {ZORI_URL}")
    for lid in [a.locale] if a.locale else LOCALE_IDS:
        zips, why = locale_zips(lid, points)
        have = {z: zori[z] for z in zips if z in zori}
        print(f"\n{lid}")
        for z in zips:
            v = f"${have[z]:,.0f}" if z in have else "missing (no ZORI series)"
            print(f"  {z}  {v:>26}  {why[z]}")
        if have:
            print(f"  median of {len(have)} ZIP(s): {round(statistics.median(have.values()))}")
        else:
            print("  no ZIP has a ZORI value: the factor stays missing for this locale")


if __name__ == "__main__":
    main()
