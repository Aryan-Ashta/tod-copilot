"""Review, and on --approve promote, an agent-built legal corpus (backend/corpus/agent/<jurisdiction>/).

Agent-built rules are already used in plans, labeled agent-verified (AGENTS.md ground rule 3). Approving makes them
curated (reviewed by a person).

Usage:
  uv run python scripts/review_corpus.py <jurisdiction>                       # print review.md; changes nothing
  uv run python scripts/review_corpus.py <jurisdiction> --approve [--replace]

Approving moves the documents into backend/corpus/<jurisdiction>/, appends their index entries to
backend/corpus/index.yaml (text append: comments survive), writes rules/<jurisdiction>.yaml, merges path kinds into
backend/corpus/paths.yaml (existing names win), deletes the agent folder and runs the corpus tests. Only a person
runs --approve, after reading every rule against its quote.
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CORPUS = ROOT / "backend" / "corpus"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("jurisdiction")
    ap.add_argument("--approve", action="store_true")
    ap.add_argument("--replace", action="store_true", help="overwrite an existing rules/<jurisdiction>.yaml")
    a = ap.parse_args()
    stage = CORPUS / "agent" / a.jurisdiction
    if not (stage / "review.md").exists():
        sys.exit(f"no agent-built corpus at {stage}")
    print((stage / "review.md").read_text())
    if not a.approve:
        return
    rules_path = CORPUS / "rules" / f"{a.jurisdiction}.yaml"
    if rules_path.exists() and not a.replace:
        sys.exit(f"{rules_path} exists; pass --replace to overwrite it")
    entries = yaml.safe_load((stage / "index.yaml").read_text()) or []
    if not entries or not (stage / "rules.yaml").exists():
        sys.exit("no accepted documents or rules; nothing to approve")
    dest = CORPUS / a.jurisdiction
    dest.mkdir(exist_ok=True)
    for e in entries:
        shutil.move(str(stage / f"{e['doc_id']}.md"), dest / f"{e['doc_id']}.md")
    with (CORPUS / "index.yaml").open("a") as fh:
        fh.write("\n" + yaml.safe_dump(entries, sort_keys=False, allow_unicode=True, width=120))
    shutil.copy(stage / "rules.yaml", rules_path)
    paths_file = CORPUS / "paths.yaml"
    existing = yaml.safe_load(paths_file.read_text()) or {}
    new = {k: v for k, v in (yaml.safe_load((stage / "paths.yaml").read_text()) or {}).items() if k not in existing}
    if new:
        with paths_file.open("a") as fh:
            fh.write(yaml.safe_dump(new, sort_keys=False, allow_unicode=True, default_flow_style=None))
    shutil.rmtree(stage)
    print(f"approved {len(entries)} documents into {dest}; running the corpus tests")
    r = subprocess.run(["uv", "run", "pytest", "backend/tests/test_corpus.py", "-q"], cwd=ROOT)
    sys.exit(r.returncode)


if __name__ == "__main__":
    main()
