"""Record public data for a recorded locale (backend/fixtures/<id>/) or a drawn metro area (cache/areas/<id>/).

Usage:
  uv run python scripts/record_fixtures.py --locale <id> [--only county,osm,gtfs,demand,fema,afdc,pvwatts,utilities,station,costar]
  doppler run -- uv run python scripts/record_fixtures.py --locale <id> --only agent_research   # LLM + search (docs/12)
  doppler run -- uv run python scripts/record_fixtures.py --locale <id> --only agent_market     # factors.yaml proposals
  doppler run -- uv run python scripts/onboard.py --outlines   # onboarded county/city outlines (backend/fixtures/metros/)

The steps live in backend/data/record.py.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.data.locales import get_locale  # noqa: E402
from backend.data.record import LLM_STEPS, STEPS  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locale", type=str, required=True, help="a recorded locale id or an area-* id")
    ap.add_argument("--only", default=",".join(s for s in STEPS if s not in LLM_STEPS),
                    help=f"comma-separated steps; {', '.join(LLM_STEPS)} run only when named")
    a = ap.parse_args()
    try:
        get_locale(a.locale)
    except KeyError as e:
        ap.error(str(e))
    for name in a.only.split(","):
        print(f"== {a.locale}: {name}")
        STEPS[name](a.locale)


if __name__ == "__main__":
    main()
