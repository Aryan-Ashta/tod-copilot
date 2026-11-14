"""Coordinator: runs the eight agents in order, streams events, stores the Plan and its event log.

With an API key (and not offline) a deepagents coordinator delegates to eight LLM subagents whose tools are the
same Python functions the deterministic driver calls; LLM text only becomes `Plan.notes`, never numbers. Any agent
the LLM did not finish is then run by the deterministic driver, so the Plan is identical either way.
"""
import concurrent.futures as cf
import functools
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from pydantic import TypeAdapter

from backend import settings
from backend.agents import (building_reuse, funding, infrastructure, land_deal, site, sustainability_health,
                            transit_network, zoning_legislation)
from backend.agents.context import RunContext
from backend.data.factors import resolve
from backend.data.locales import get_locale
from backend.data.resolver import default_resolver
from backend.schemas import AgentEvent, Plan, Precomputed, TransitPlan

AGENTS = [infrastructure, transit_network, zoning_legislation, site, building_reuse, land_deal, funding,
          sustainability_health]
OUTPUTS = {"infrastructure": ["infrastructure", "readiness"], "transit_network": ["transit"],
           "zoning_legislation": ["envelopes"], "site": ["parcels", "sites"],
           "building_reuse": ["buildings", "conversions", "sites"], "land_deal": ["deals"],
           "funding": ["stacks", "sites"], "sustainability_health": ["targets"]}
PROMPTS = Path(__file__).with_name("prompts")
LLM_TIMEOUT_S = 75
PLANS_DIR = settings.CACHE_DIR / "plans"


def _dump(v):
    if isinstance(v, list):
        return [x.model_dump(mode="json") for x in v]
    return v.model_dump(mode="json")


def _payload(ctx: RunContext, agent: str) -> dict:
    return {k: _dump(ctx.plan_parts[k]) for k in OUTPUTS[agent] if k in ctx.plan_parts}


def _validate(ctx: RunContext, agent: str) -> None:
    for k in OUTPUTS[agent]:
        if k not in ctx.plan_parts:
            raise ValueError(f"{agent} produced no {k}")
        TypeAdapter(Plan.model_fields[k].annotation).validate_python(ctx.plan_parts[k])


def _wrap(ctx: RunContext, agent: str, fn: Callable, last: bool, cancel: threading.Event) -> Callable:
    @functools.wraps(fn)
    def tool(*a, **kw):
        if cancel.is_set():
            return "cancelled: the deterministic driver took over"
        try:
            out = fn(*a, **kw)
        except Exception as e:  # tell the LLM; the deterministic pass reruns the agent
            return f"error: {e}"
        if last:
            ctx.cache.setdefault("done", set()).add(agent)
        return out
    return tool


def _run_llm(ctx: RunContext, notes: dict[str, str]) -> None:
    from deepagents import SubAgent, create_deep_agent
    cancel = threading.Event()
    subagents = []
    for mod in AGENTS:
        ts = mod.tools(ctx)
        wrapped = [_wrap(ctx, mod.NAME, t, i == len(ts) - 1, cancel) for i, t in enumerate(ts)]
        subagents.append(SubAgent(name=mod.NAME, description=mod.GOAL,
                                  system_prompt=(PROMPTS / f"{mod.NAME}.md").read_text(), tools=wrapped))
    agent = create_deep_agent(model=settings.MODEL, tools=[], system_prompt=(PROMPTS / "coordinator.md").read_text(),
                              subagents=subagents)
    msg = {"messages": [{"role": "user", "content": f"{ctx.locale.name}: {ctx.prompt}"}]}
    pool = cf.ThreadPoolExecutor(max_workers=1)
    fut = pool.submit(agent.invoke, msg)
    try:
        result = fut.result(timeout=LLM_TIMEOUT_S)
    finally:
        cancel.set()
        pool.shutdown(wait=False)
    calls = {}
    for m in result["messages"]:
        for tc in getattr(m, "tool_calls", None) or []:
            if tc.get("name") == "task":
                calls[tc["id"]] = tc["args"].get("subagent_type")
        if getattr(m, "type", "") == "tool" and getattr(m, "tool_call_id", None) in calls:
            text = m.content if isinstance(m.content, str) else " ".join(
                c.get("text", "") for c in m.content if isinstance(c, dict))
            if calls[m.tool_call_id] and text.strip():
                notes[calls[m.tool_call_id]] = text.strip()


def run_plan(locale_id: str, prompt: str, plan_id: str, emit: Callable[[AgentEvent], None],
             llm: Optional[bool] = None) -> Plan:
    PLANS_DIR.mkdir(parents=True, exist_ok=True)
    log_path = PLANS_DIR / f"{plan_id}.events.jsonl"
    log = log_path.open("w")
    lock = threading.Lock()

    def emit_all(e: AgentEvent) -> None:
        with lock:
            log.write(e.model_dump_json() + "\n")
            log.flush()
        emit(e)

    locale = get_locale(locale_id)
    ctx = RunContext(locale=locale, prompt=prompt, resolver=default_resolver(), f=resolve(locale_id), emit=emit_all)
    notes: dict[str, str] = {}
    errors: dict[str, str] = {}
    try:
        use_llm = settings.LLM_ENABLED if llm is None else llm
        if use_llm:
            emit_all(AgentEvent(agent="coordinator", status="running", step="LLM coordinator delegating to 8 agents"))
            try:
                _run_llm(ctx, notes)
            except Exception as e:  # timeout, auth, network: fall back, never fail the plan
                emit_all(AgentEvent(agent="coordinator", status="error",
                                    step="LLM coordinator unavailable; deterministic driver used",
                                    payload={"reason": f"{type(e).__name__}: {e}"[:300]}))
        done = ctx.cache.setdefault("done", set())
        for mod in AGENTS:
            name = mod.NAME
            if name not in done:
                emit_all(AgentEvent(agent=name, status="running", step=f"Starting: {mod.GOAL}"))
                for attempt in (1, 2):
                    try:
                        mod.run(ctx)
                        _validate(ctx, name)
                        done.add(name)
                        break
                    except Exception as e:
                        if attempt == 2:
                            errors[name] = str(e)
                            emit_all(AgentEvent(agent=name, status="error", step=str(e)[:300]))
            if name in done:
                notes.setdefault(name, mod.explain(ctx))
                emit_all(AgentEvent(agent=name, status="done", step=notes[name], payload=_payload(ctx, name)))
        p = ctx.plan_parts
        pre = ctx.pre
        plan = Plan(id=plan_id, locale=locale, infrastructure=p.get("infrastructure", []),
                    readiness=p.get("readiness", []),
                    transit=p.get("transit") or TransitPlan(routes=[], stops=[], measurements=[], budget_usd=0),
                    parcels=p.get("parcels", []), buildings=p.get("buildings", []), envelopes=p.get("envelopes", []),
                    conversions=p.get("conversions", []), sites=p.get("sites", []), deals=p.get("deals", []),
                    stacks=p.get("stacks", []), targets=p.get("targets", []), created_at=datetime.now(timezone.utc),
                    prompt=prompt, notes=notes, agent_errors=errors,
                    precomputed=Precomputed(walk_m=pre.get("walk_m", {}), in_flood=pre.get("in_flood", {}),
                                            centroid=pre.get("centroid", {}),
                                            homes_by_parcel=pre.get("homes_by_parcel", {}),
                                            demand_cells=pre.get("demand_cells", []),
                                            solar_kwh_per_kw_year=pre.get("solar_kwh_per_kw_year")))
        (PLANS_DIR / f"{plan_id}.json").write_text(plan.model_dump_json())
        emit_all(AgentEvent(agent="coordinator", status="done", step="Plan ready", payload={"plan_id": plan_id}))
        return plan
    except Exception as e:
        emit_all(AgentEvent(agent="coordinator", status="error", step=f"Plan failed: {e}"[:300]))
        raise
    finally:
        log.close()


def load_plan(plan_id: str) -> Optional[Plan]:
    p = PLANS_DIR / f"{plan_id}.json"
    return Plan.model_validate_json(p.read_text()) if p.exists() else None


