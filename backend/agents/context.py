"""Shared run state for one plan build."""
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from backend.data.resolver import Resolver
from backend.schemas import AgentEvent, AgentName, Locale


@dataclass
class RunContext:
    locale: Locale
    prompt: str
    resolver: Resolver
    f: dict[str, Any]
    emit: Callable[[AgentEvent], None]
    plan_parts: dict[str, Any] = field(default_factory=dict)   # Plan fields + "precomputed" pieces
    graph: Any = None                                           # walk graph (networkx)
    dists: dict[str, dict] = field(default_factory=dict)        # kind -> {node: walk metres}
    cache: dict[str, Any] = field(default_factory=dict)         # loaded records shared between agents
    missing: list[str] = field(default_factory=list)            # capabilities with no provider here

    def step(self, agent: AgentName, text: str, payload: Optional[dict] = None) -> None:
        self.emit(AgentEvent(agent=agent, status="running", step=text, payload=payload or {}))

    def need(self, key: str, agent: str) -> Any:
        if key not in self.plan_parts:
            raise ValueError(f"run {agent} first")
        return self.plan_parts[key]

    @property
    def pre(self) -> dict:
        return self.plan_parts.setdefault("precomputed", {})
