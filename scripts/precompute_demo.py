"""Build the recorded demo runs for all three locales, then run the locale golden tests (docs/08).

Usage: uv run python scripts/precompute_demo.py [--no-llm] [--locale <id> ...]
Writes cache/plans/demo-<locale>.json and .events.jsonl; exits non-zero if any golden test fails.
"""
import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.agents.coordinator import run_plan  # noqa: E402
from backend.data.locales import LOCALE_IDS  # noqa: E402

PROMPT = "Plan transit-oriented development around the stations: what to convert, what to build, how to connect it"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="deterministic driver only (templated notes)")
    ap.add_argument("--locale", action="append", choices=LOCALE_IDS,
                    help="rebuild only these locales (repeatable); the others keep their cached plans")
    a = ap.parse_args()
    for lid in a.locale or LOCALE_IDS:
        t = time.time()
        plan = run_plan(lid, PROMPT, f"demo-{lid}", emit=lambda e: None, llm=False if a.no_llm else None)
        errs = f" errors: {plan.agent_errors}" if plan.agent_errors else ""
        print(f"{lid}: plan demo-{lid} in {time.time() - t:.1f}s, {len(plan.sites)} sites{errs}")
    r = subprocess.run(["uv", "run", "pytest", "backend/tests/locales", "-rA", "-q", "-p", "no:warnings"],
                       cwd=ROOT, capture_output=True, text=True)
    rows = re.findall(r"^(PASSED|FAILED|SKIPPED|ERROR) (\S+?)(?: - (.*))?$", r.stdout, re.M)
    print(f"\n{'result':8} test")
    for status, test, reason in rows:
        print(f"{status:8} {test.split('/')[-1]}" + (f"  ({reason[:120]})" if reason else ""))
    if not rows:
        print(r.stdout[-2000:], r.stderr[-2000:])
    return 0 if r.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
