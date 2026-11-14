"""Derive `rent_usd_per_unit_month` per locale from the Zillow Observed Rent Index (ZORI), replacing RentCafe.

RentCafe blocks scripted access (HTTP 403), so its figures cannot be re-checked. The derivation lives in
backend/data/zori.py (also used for drawn areas by the `local_factors` record step).

Usage:
  uv run python scripts/rent_from_zori.py            # all three locales
  uv run python scripts/rent_from_zori.py --locale houston_downtown

Downloads go through backend.data.http_cache (cache/http), so a second run, or DEMO_OFFLINE=1, reads the cache.
Prints the derivation; copy the values and the note into backend/data/factors.yaml by hand.
"""
import argparse
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.data.factors import LOCALE_IDS  # noqa: E402
from backend.data.http_cache import retrieved_at  # noqa: E402
from backend.data.locales import get_locale  # noqa: E402
from backend.data.zori import ZORI_URL, zcta_points, zips_for, zori_latest  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locale", choices=LOCALE_IDS)
    a = ap.parse_args()
    points = zcta_points()
    month, zori = zori_latest()
    print(f"ZORI month {month} (retrieved {retrieved_at(ZORI_URL)}); {ZORI_URL}")
    for lid in [a.locale] if a.locale else LOCALE_IDS:
        loc = get_locale(lid)
        why = zips_for(loc.bbox, [(s.name, tuple(s.lonlat)) for s in loc.stations], points)
        have = {z: zori[z] for z in why if z in zori}
        print(f"\n{lid}")
        for z in why:
            v = f"${have[z]:,.0f}" if z in have else "missing (no ZORI series)"
            print(f"  {z}  {v:>26}  {why[z]}")
        if have:
            print(f"  median of {len(have)} ZIP(s): {round(statistics.median(have.values()))}")
        else:
            print("  no ZIP has a ZORI value: the factor stays missing for this locale")


if __name__ == "__main__":
    main()
