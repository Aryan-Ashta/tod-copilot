"""Field coverage on candidate buildings, before and after agent research (docs/12 §1 table, §11).

Usage: DEMO_OFFLINE=1 uv run python scripts/research_coverage.py [--locale <id> ...]

"before" drops the agent_research provider from the resolver; "after" is the normal resolver. Counts are candidate
buildings (common.candidate_buildings) with a value from any source, plus parcel sale prices over all parcels.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.agents import common  # noqa: E402
from backend.agents.context import RunContext  # noqa: E402
from backend.data.factors import resolve  # noqa: E402
from backend.data.locales import LOCALE_IDS, get_locale  # noqa: E402
from backend.data.resolver import default_resolver  # noqa: E402

FIELDS = ("vacancy_pct", "asking_rent_usd_sqft_yr", "parking_spaces", "building_class", "year_built", "stories",
          "rentable_area_sqft", "typical_floor_sqft")


def coverage(locale_id: str, with_agent: bool) -> dict:
    r = default_resolver()
    if not with_agent:
        r.providers = [p for p in r.providers if p.name != "agent_research"]
    ctx = RunContext(locale=get_locale(locale_id), prompt="coverage", resolver=r, f=resolve(locale_id),
                     emit=lambda e: None)
    cand = common.candidate_buildings(ctx)
    parcels = common.load_parcels(ctx)

    def real(sv) -> bool:
        return sv.value is not None and sv.prov.source != "derived"
    row = {"candidates": len(cand),
           "any CoStar value": sum(any(getattr(b, k).prov.source == "costar" for k in common.BUILDING_FIELDS)
                                   for b in cand),
           "any agent_research value": sum(any(getattr(b, k).prov.source == "agent_research"
                                               for k in common.BUILDING_FIELDS) for b in cand)}
    row.update({k: sum(real(getattr(b, k)) for b in cand) for k in FIELDS})
    row["parcel last_sale_usd"] = f"{sum(p.last_sale_usd.value is not None for p in parcels)} / {len(parcels)}"
    return row


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locale", action="append", help="locale or area id (repeatable); default: the three recorded")
    ids = ap.parse_args().locale or list(LOCALE_IDS)
    rows = {lid: (coverage(lid, False), coverage(lid, True)) for lid in ids}
    keys = list(next(iter(rows.values()))[0])
    print("| Field | " + " | ".join(f"{lid} before | after" for lid in ids) + " |")
    print("|---|" + "---|---|" * len(ids))
    for k in keys:
        print(f"| {k} | " + " | ".join(f"{b[k]} | {a[k]}" for b, a in rows.values()) + " |")


if __name__ == "__main__":
    main()
