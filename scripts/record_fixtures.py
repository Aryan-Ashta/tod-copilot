"""Record public data for a recorded locale (backend/fixtures/<id>/) or a drawn metro area (cache/areas/<id>/).

Usage:
  uv run python scripts/record_fixtures.py --locale <id> [--only county,osm,gtfs,demand,fema,afdc,pvwatts,utilities,station,costar]
  uv run python scripts/record_fixtures.py --metros   # supported county/city outlines (backend/fixtures/metros/)

The steps live in backend/data/record.py.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.data.locales import get_locale  # noqa: E402
from backend.data.record import STEPS, record_metros  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--locale", type=str, help="a recorded locale id or an area-* id")
    g.add_argument("--metros", action="store_true", help="record the supported county and city outlines")
    ap.add_argument("--only", default=",".join(STEPS))
    a = ap.parse_args()
    if a.metros:
        record_metros()
        return
    try:
        get_locale(a.locale)
    except KeyError as e:
        ap.error(str(e))
    for name in a.only.split(","):
        print(f"== {a.locale}: {name}")
        STEPS[name](a.locale)


if __name__ == "__main__":
    main()
