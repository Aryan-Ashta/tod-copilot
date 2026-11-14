"""Agent research for a drawn metro area (docs/12 §8.2), run in the background after its plan is ready.

Each accepted fact is streamed as an event; when research finishes with new facts the plan is rebuilt
deterministically (no LLM) from the area's data plus cache/areas/<id>/agent_research/ and saved under the same plan
id, so the UI reloads it and re-applies its edits through `rescore`. The plan never waits on research."""
from typing import Callable, Optional

from backend.agents.coordinator import PLANS_DIR, run_plan
from backend.research import registry
from backend.research.agent import Report, run_locale
from backend.schemas import AgentEvent, Plan


def research_area(locale_id: str, plan: Plan, emit: Callable[[AgentEvent], None]) -> tuple[Optional[Plan], Report]:
    """Research the area, stream accepted facts; returns (rebuilt plan or None when nothing was accepted, report)."""

    def on_fact(job, a) -> None:
        emit(AgentEvent(agent="building_reuse", status="done",
                        step=f"Research: {job.label} {a.field.replace('_', ' ')} = {a.value} "
                             f"({registry.domain(a.source_url)}, {a.confidence} confidence)",
                        payload={"research_fact": {"building_id": job.building_id, "parcel_id": job.parcel_id,
                                                   "field": a.field, "value": a.value, "source_url": a.source_url,
                                                   "quote": a.quote, "confidence": a.confidence}}))

    report = run_locale(locale_id, on_fact=on_fact, quiet=True)
    if report.accepted == 0:
        return None, report
    tmp = f"{plan.id}-research"
    try:
        new = run_plan(locale_id, plan.prompt, tmp, emit=lambda e: None, llm=False, options=plan.options)
    finally:
        for suffix in (".json", ".events.jsonl"):
            (PLANS_DIR / f"{tmp}{suffix}").unlink(missing_ok=True)
    new = new.model_copy(update={"id": plan.id, "llm_run": plan.llm_run, "created_at": plan.created_at})
    (PLANS_DIR / f"{plan.id}.json").write_text(new.model_dump_json())
    return new, report
