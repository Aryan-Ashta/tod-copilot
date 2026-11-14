"""Shared plumbing for the onboarding agents: work dirs, the deep-agent run, dry-run check tools, reject logs and
registry section stamps. Every agent follows: propose (LLM, tools) -> verify (code, live source) -> write section."""
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from backend import settings
from backend.research import harness
from backend.research import registry as research_registry
from backend.research.tools import SearchProvider, search_provider, web_tools

HERE = Path(__file__).resolve().parent
SKILLS_DIR = HERE / "skills"
PROMPTS_DIR = HERE / "prompts"
MAX_SEARCHES, MAX_FETCHES, MAX_PROBES, MAX_CHECKS = 6, 8, 20, 3   # per agent run; operational budgets


def llm_ready() -> bool:
    return bool(settings.ANTHROPIC_API_KEY) and not settings.OFFLINE


def thresholds() -> dict:
    """The onboard_* verifier thresholds (global factors)."""
    from backend.data.factors import LOCALE_IDS, resolve
    return resolve(LOCALE_IDS[0])


def onboard_dir() -> Path:
    return settings.CACHE_DIR / "onboard"


def work_dir(key: str) -> Path:
    d = onboard_dir() / key
    d.mkdir(parents=True, exist_ok=True)
    return d


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def model_label(model: Any) -> str:
    m = model if model is not None else settings.RESEARCH_MODEL
    return m if isinstance(m, str) else type(m).__name__


def stamp(status: str, model: Any, **section) -> dict:
    """A registry section with its status, verification time and model."""
    return {"status": status, **section, "verified_at": now(), "model": model_label(model)}


def sample_box(lon: float, lat: float, side_m: float) -> tuple[float, float, float, float]:
    half = side_m / 2
    dlat = half / 111_320
    dlon = half / (111_320 * math.cos(math.radians(lat)))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def log_reject(key: str, agent: str, proposal: Any, problems: list[str]) -> None:
    p = work_dir(key) / "rejects.jsonl"
    with p.open("a") as fh:
        fh.write(json.dumps({"agent": agent, "at": now(), "problems": problems,
                             "proposal": proposal.model_dump() if hasattr(proposal, "model_dump") else proposal},
                            default=str) + "\n")


def check_tool(name: str, doc: str, fn: Callable[[Any], list[str]], max_checks: int = MAX_CHECKS) -> Callable:
    """A dry-run tool named `name` that runs the agent's code verifier on a candidate answer."""
    used = [0]

    def tool(proposal: dict) -> str:
        if used[0] >= max_checks:
            return f"check budget spent ({max_checks} checks): give your final structured answer now"
        used[0] += 1
        try:
            problems = fn(proposal)
        except Exception as e:   # a malformed candidate: tell the agent
            return f"invalid candidate: {type(e).__name__}: {str(e)[:300]}"
        return ("passes every check. Give it as your final structured answer now." if not problems else
                "fails:\n- " + "\n- ".join(problems) + "\nFix these from the tools' output, or answer not found.")
    tool.__name__ = name
    tool.__doc__ = doc
    return tool


def run_agent(agent: str, key: str, county_fips: str, extra_tools: list[Callable], response_format: type,
              message: str, *, model: Any = None, search: Optional[SearchProvider] = None,
              max_searches: int = MAX_SEARCHES, max_fetches: int = MAX_FETCHES,
              recursion_limit: int = harness.RECURSION_LIMIT) -> Any:
    """Run one onboarding agent (prompt backend/onboard/prompts/<agent>.md) to its structured answer."""
    model = model if model is not None else settings.RESEARCH_MODEL
    wd = work_dir(key)
    tools = web_tools(county_fips, wd, search or search_provider(), max_searches=max_searches,
                      max_fetches=max_fetches) + extra_tools
    a = harness.build_agent(model, tools, PROMPTS_DIR / f"{agent}.md", response_format, wd,
                            harness.checkpointer(onboard_dir() / "checkpoints.sqlite"),
                            skills_dirs=(SKILLS_DIR, research_registry.SKILLS_DIR))
    res, _ = harness.invoke(a, message, thread_id(agent, key), recursion_limit)
    if res is not None and not isinstance(res, response_format):
        res = response_format.model_validate(res)
    return res


def thread_id(agent: str, key: str) -> str:
    return f"onboard-{agent}-{key}"


def forget(agent: str, key: str) -> None:
    """Drop the agent's checkpoint so the next run proposes afresh (after a rejected answer)."""
    harness.checkpointer(onboard_dir() / "checkpoints.sqlite").delete_thread(thread_id(agent, key))
