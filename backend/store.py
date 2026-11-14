"""In-memory plan runs plus cache/plans/ on disk."""
import asyncio
from dataclasses import dataclass, field
from typing import Optional

from backend.agents.coordinator import PLANS_DIR, load_plan
from backend.schemas import AgentEvent, Plan


@dataclass
class Run:
    events: list[AgentEvent] = field(default_factory=list)
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    finished: bool = False


runs: dict[str, Run] = {}
_plans: dict[str, Plan] = {}


def get_plan(plan_id: str) -> Optional[Plan]:
    if plan_id not in _plans:
        p = load_plan(plan_id)
        if p is None:
            return None
        _plans[plan_id] = p
    return _plans[plan_id]


def put_plan(plan: Plan) -> None:
    _plans[plan.id] = plan


def events_path(plan_id: str):
    return PLANS_DIR / f"{plan_id}.events.jsonl"
