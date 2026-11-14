"""Shared deep-agent harness for the researchers (docs/12) and the onboarding agents (backend/onboard): a read-only
deepagents agent over a virtual filesystem (saved page text + skills), with a structured final answer and a SQLite
checkpointer so an interrupted run resumes."""
import sqlite3
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from langgraph.errors import GraphRecursionError

from backend.research import registry

EXCLUDED_TOOLS = frozenset({"task", "execute", "write_file", "edit_file"})
RECURSION_LIMIT = 150   # graph steps per job (~3 per tool round); the tools' own budgets normally end a job first
NUDGE_STEPS = 12
FINAL_NUDGE = ("Step budget spent: stop researching. Call your final structured-answer tool now, exactly once, with "
               "what you have verified so far (empty lists are a valid answer).")


def _tool_name(t: Any) -> Optional[str]:
    return t.get("name") if isinstance(t, dict) else getattr(t, "name", None)


def _filter_tools_middleware():
    from langchain.agents.middleware.types import AgentMiddleware

    class ResearchToolFilter(AgentMiddleware):
        """Hide the general-purpose `task`, `execute` and file-writing tools: a researcher reads, it never writes
        or delegates (docs/12 §9)."""

        def wrap_model_call(self, request, handler):
            return handler(request.override(tools=[t for t in request.tools if _tool_name(t) not in EXCLUDED_TOOLS]))

        async def awrap_model_call(self, request, handler):
            return await handler(request.override(tools=[t for t in request.tools
                                                         if _tool_name(t) not in EXCLUDED_TOOLS]))
    return ResearchToolFilter()


def build_agent(model: Any, tools: list[Callable], prompt_path: Path, response_format: type, root: Path,
                checkpointer: Any = None, skills_dirs: Sequence[Path] = (registry.SKILLS_DIR,)):
    """`root` holds the saved page text (/pages/...); skills_dirs[i] is mounted at /skills/<i>/."""
    from deepagents import FilesystemMiddleware, create_deep_agent
    from deepagents.backends import CompositeBackend, FilesystemBackend
    from langchain.agents.structured_output import ToolStrategy
    root.mkdir(parents=True, exist_ok=True)
    routes = {f"/skills/{i}/": FilesystemBackend(root_dir=d, virtual_mode=True) for i, d in enumerate(skills_dirs)}
    backend = CompositeBackend(default=FilesystemBackend(root_dir=root, virtual_mode=True), routes=routes)
    return create_deep_agent(
        model=model, tools=tools, system_prompt=prompt_path.read_text(),
        # ToolStrategy: the answer is an explicit final tool call (the response model) that ends the run; schema
        # errors go back to the model to fix.
        skills=list(routes), backend=backend, response_format=ToolStrategy(response_format),
        checkpointer=checkpointer,
        middleware=[FilesystemMiddleware(backend=backend, tools=["ls", "read_file", "grep", "glob"]),
                    _filter_tools_middleware()],
        name=prompt_path.stem)


def invoke(agent, message: str, thread_id: str, recursion_limit: int = RECURSION_LIMIT) -> tuple[Any, dict]:
    """Run (or resume) one job's agent; returns (structured_response, token usage)."""
    from langchain_core.callbacks import UsageMetadataCallbackHandler
    handler = UsageMetadataCallbackHandler()
    config = {"configurable": {"thread_id": thread_id}, "callbacks": [handler], "recursion_limit": recursion_limit,
              "run_name": f"research-{thread_id}"}
    state = agent.get_state(config) if getattr(agent, "checkpointer", None) else None
    try:
        if state is not None and state.values.get("structured_response") is not None:
            out = state.values
        elif state is not None and state.next:
            out = agent.invoke(None, config)   # resume an interrupted run from its checkpoint
        else:
            out = agent.invoke({"messages": [{"role": "user", "content": message}]}, config)
    except GraphRecursionError:
        if not getattr(agent, "checkpointer", None):
            raise
        # Out of graph steps (file reads and greps have no budget): one last turn to give the final answer.
        out = agent.invoke({"messages": [{"role": "user", "content": FINAL_NUDGE}]},
                           {**config, "recursion_limit": NUDGE_STEPS})
    meta = dict(handler.usage_metadata)
    tokens = {"input_tokens": sum(int(m.get("input_tokens") or 0) for m in meta.values()),
              "output_tokens": sum(int(m.get("output_tokens") or 0) for m in meta.values())}
    return out.get("structured_response"), tokens


def checkpointer(path: Path):
    from langgraph.checkpoint.sqlite import SqliteSaver
    path.parent.mkdir(parents=True, exist_ok=True)
    return SqliteSaver(sqlite3.connect(str(path), check_same_thread=False))
