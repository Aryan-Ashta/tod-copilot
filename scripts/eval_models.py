"""Evaluate Anthropic models as the LLM coordinator and recommend a default (plan step 8).

Usage: uv run python scripts/eval_models.py [--models a,b] [--reps 1]
Writes cache/eval/models-<date>.json (raw per-run data) and docs/model-eval.md; prints `recommended default: <model>`.

Metrics per model, over the three recorded locales x reps:
- completion: mean share of the 8 agents whose last tool the LLM ran
- fallbacks: runs where the LLM coordinator failed (timeout, error) and the deterministic driver took over
- median seconds of the LLM phase; total tokens and cost from scripts/model_prices.yaml
- grounded %: numbers (> 10, or non-integers) in LLM-written notes that match, within 1%, a number in that agent's
  tool outputs or its progress-step texts (both computed by code)
"""
import argparse
import json
import re
import statistics
import sys
from datetime import date
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend import settings  # noqa: E402
from backend.agents.coordinator import PLANS_DIR, run_plan  # noqa: E402
from backend.data.locales import LOCALE_IDS  # noqa: E402

DEFAULT_MODELS = ["anthropic:claude-haiku-5-5", "anthropic:claude-sonnet-5-5", "anthropic:claude-opus-5-5",
                  "anthropic:claude-sonnet-4-6"]
PROMPT = "Plan transit-oriented development around the stations: what to convert, what to build, how to connect it"
NUM = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*([kKmMbB])?\b")
MULT = {"k": 1e3, "m": 1e6, "b": 1e9}
N_AGENTS = 8


def numbers(text: str) -> list[float]:
    out = []
    for raw, suf in NUM.findall(text):
        try:
            v = float(raw.replace(",", ""))
        except ValueError:
            continue
        v *= MULT.get(suf.lower(), 1) if suf else 1
        if v.is_integer() and v <= 10:
            continue
        out.append(v)
    return out


def grounded(note: str, sources: list[str]) -> tuple[int, int]:
    ref = [n for s in sources for n in numbers(s)]
    ns = numbers(note)
    ok = sum(1 for n in ns if any(abs(n - r) <= 0.01 * max(abs(r), 1e-9) for r in ref))
    return ok, len(ns)


def step_texts(plan_id: str) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    p = PLANS_DIR / f"{plan_id}.events.jsonl"
    for line in p.read_text().splitlines() if p.exists() else []:
        e = json.loads(line)
        if e.get("status") == "running":
            out.setdefault(e["agent"], []).append(e.get("step") or "")
    return out


def run_one(model: str, lid: str, r: int) -> dict:
    slug = model.split(":")[-1]
    pid = f"eval-{slug}-{lid}-{r}"
    plan = run_plan(lid, PROMPT, pid, emit=lambda e: None, llm=True, model=model)
    lr = plan.llm_run
    steps = step_texts(pid)
    g_ok = g_n = 0
    for agent in lr.notes_from_llm:
        ok, n = grounded(plan.notes.get(agent, ""), lr.tool_outputs.get(agent, []) + steps.get(agent, []))
        g_ok, g_n = g_ok + ok, g_n + n
    return {"model": model, "locale": lid, "rep": r, "plan_id": pid, "seconds": lr.seconds,
            "agents_completed": lr.agents_completed, "notes_from_llm": lr.notes_from_llm,
            "fallback_reason": lr.fallback_reason, "input_tokens": lr.input_tokens, "output_tokens": lr.output_tokens,
            "grounded": g_ok, "numbers": g_n, "notes": {a: plan.notes.get(a) for a in lr.notes_from_llm}}


def summarize(model: str, runs: list[dict], prices: dict) -> dict:
    tin = [x["input_tokens"] for x in runs]
    tout = [x["output_tokens"] for x in runs]
    has_tokens = all(t is not None for t in tin + tout)
    price = prices.get(model)
    cost = (sum(tin) * price["input_usd_per_mtok"] + sum(tout) * price["output_usd_per_mtok"]) / 1e6 \
        if has_tokens and price else None
    n_num = sum(x["numbers"] for x in runs)
    return {"model": model, "runs": len(runs),
            "completion": statistics.mean(len(x["agents_completed"]) / N_AGENTS for x in runs),
            "fallbacks": sum(1 for x in runs if x["fallback_reason"]),
            "median_s": statistics.median(x["seconds"] for x in runs),
            "tokens": sum(tin) + sum(tout) if has_tokens else None, "cost_usd": cost,
            "grounded_pct": 100 * sum(x["grounded"] for x in runs) / n_num if n_num else None}


def recommend(rows: list[dict]) -> str:
    """Among models with full completion and no fallbacks, the highest grounded %; within 2 points, the faster.
    If none qualifies: highest completion, then grounded %."""
    ok = [r for r in rows if r["completion"] == 1.0 and r["fallbacks"] == 0]
    if not ok:
        return max(rows, key=lambda r: (r["completion"], r["grounded_pct"] or 0))["model"]
    best = max(r["grounded_pct"] or 0 for r in ok)
    near = [r for r in ok if (r["grounded_pct"] or 0) >= best - 2]
    return min(near, key=lambda r: r["median_s"])["model"]


def fmt(v, spec: str) -> str:
    return "n/a" if v is None else format(v, spec)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=",".join(DEFAULT_MODELS))
    ap.add_argument("--reps", type=int, default=1)
    a = ap.parse_args()
    if not settings.ANTHROPIC_API_KEY or settings.OFFLINE:
        sys.exit("eval_models needs ANTHROPIC_API_KEY and DEMO_OFFLINE unset")
    prices = yaml.safe_load((ROOT / "scripts" / "model_prices.yaml").read_text())
    models = a.models.split(",")
    runs: list[dict] = []
    for m in models:
        for lid in LOCALE_IDS:
            for r in range(a.reps):
                x = run_one(m, lid, r)
                runs.append(x)
                print(f"{m} {lid} #{r}: {len(x['agents_completed'])}/8 agents, {x['seconds']:.1f}s, "
                      f"grounded {x['grounded']}/{x['numbers']}" + (f", fallback: {x['fallback_reason']}"
                                                                   if x["fallback_reason"] else ""))
    rows = [summarize(m, [x for x in runs if x["model"] == m], prices) for m in models]
    rec = recommend(rows)
    today = date.today().isoformat()
    out = settings.CACHE_DIR / "eval"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"models-{today}.json").write_text(json.dumps({"runs": runs, "summary": rows, "recommended": rec}, indent=1))
    lines = [f"# LLM coordinator model evaluation ({today})", "",
             f"Generated by `scripts/eval_models.py` (reps={a.reps}, prompt: \"{PROMPT}\", locales: "
             f"{', '.join(LOCALE_IDS)}). Raw runs: `cache/eval/models-{today}.json` (git-ignored).", "",
             "Grounded % = numbers in LLM-written notes that match a number in that agent's tool outputs or progress "
             "steps within 1% (integers <= 10 ignored). Cost uses base prices in `scripts/model_prices.yaml`.", "",
             "| model | completion | fallbacks | median s | tokens | cost USD | grounded % |",
             "|---|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['model']} | {r['completion']:.2f} | {r['fallbacks']}/{r['runs']} | {r['median_s']:.1f} | "
                     f"{fmt(r['tokens'], ',')} | {fmt(r['cost_usd'], '.3f')} | {fmt(r['grounded_pct'], '.0f')} |")
    lines += ["", f"**Recommended default: `{rec}`** (rule: full completion and no fallbacks, then highest grounded %, "
                  "ties within 2 points to the faster model).", "", "## Sample notes (Houston, building_reuse)", ""]
    for m in models:
        x = next((x for x in runs if x["model"] == m and x["locale"] == "houston_downtown"), None)
        note = (x or {}).get("notes", {}).get("building_reuse")
        lines += [f"- **{m}**: {note if note else 'no LLM note (agent not completed by the LLM)'}"]
    (ROOT / "docs" / "model-eval.md").write_text("\n".join(lines) + "\n")
    print(f"recommended default: {rec}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
