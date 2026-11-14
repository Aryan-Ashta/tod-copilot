"""Onboard a US county (or a legal jurisdiction) with the agents in backend/onboard (docs/12 §14).

Usage:
  doppler run -- uv run python scripts/onboard.py --county 08031 [--only parcels,land_use] [--force]
  doppler run -- uv run python scripts/onboard.py --assessor 08031
  doppler run -- uv run python scripts/onboard.py --corpus state:08 | place:0820000 | county:08031
  uv run python scripts/onboard.py --seed-national-factors
  uv run python scripts/onboard.py --outlines     # backend/fixtures/metros/outlines.geojson from the registry

Results go to backend/registry/ (commit after review) and cache/onboard/ (rejects, page text, checkpoints).
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.onboard import registry  # noqa: E402
from backend.onboard.run import SECTIONS, onboard_county  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--county", help="5-digit county FIPS")
    g.add_argument("--assessor", help="5-digit county FIPS: find its property-card host")
    g.add_argument("--corpus", help="state:<fips2> | place:<geoid7> | county:<fips5>: stage a legal corpus")
    g.add_argument("--seed-national-factors", action="store_true")
    g.add_argument("--outlines", action="store_true")
    ap.add_argument("--only", help=f"comma-separated sections of {', '.join(SECTIONS)}")
    ap.add_argument("--force", action="store_true", help="redo present sections (never replaces reviewed ones)")
    a = ap.parse_args()
    if a.county:
        if a.county[:2] not in registry.us_states():
            ap.error(f"{a.county}: not a US state FIPS prefix")
        out = onboard_county(a.county, only=set(a.only.split(",")) if a.only else None, force=a.force)
    elif a.assessor:
        from backend.onboard.assessor import ensure
        out = ensure(a.assessor)
    elif a.corpus:
        from backend.onboard.corpus import build
        out = build(a.corpus)
    elif a.seed_national_factors:
        from backend.onboard.factors import seed_national
        out = {"national": sorted(seed_national())}
    else:
        from backend.onboard.geo import write_outlines
        write_outlines()
        out = {"outlines": "backend/fixtures/metros/outlines.geojson"}
    print(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
