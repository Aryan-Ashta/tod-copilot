"""Whole agent-research pipeline on one recorded locale with a scripted fake chat model and a fake search (docs/12
§10): deepagents runs the real tools, the verifier keeps only the code-verified fact, the YAML has the
research/buildings_source.yaml shape, the linker accepts it and the resolver serves it. Offline."""
import json
from typing import Any

import pytest
import yaml
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from backend import settings
from backend.data import locales
from backend.data.resolver import Capability, default_resolver
from backend.research import agent, pages
from backend.research.context import PlanContext
from backend.research.tools import FixtureSearch
from backend.tests.research_helpers import seed_page

LID = "brevard_cocoa"
URL = "https://example.org/cocoa-retail"
QUERY = "2712 Clearlake Rd Cocoa store"


class ScriptedModel(GenericFakeChatModel):
    """Plays back AIMessages (tool calls included); tools are bound by name, so binding is a no-op."""

    def bind_tools(self, tools: Any, **kw: Any):
        return self


def _call(name: str, args: dict, i: int) -> AIMessage:
    return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": f"call_{i}", "type": "tool_call"}])


class Exploding(GenericFakeChatModel):
    def bind_tools(self, tools: Any, **kw: Any):
        return self

    def _generate(self, *a, **kw):
        raise AssertionError("a cached job must not call the model")


@pytest.fixture
def env(tmp_path, monkeypatch):
    cache, fixtures = tmp_path / "cache", tmp_path / "fixtures"
    cache.mkdir()
    work = fixtures / LID
    work.mkdir(parents=True)
    for child in (locales.FIXTURES_DIR / LID).iterdir():
        if child.name != "agent_research":
            (work / child.name).symlink_to(child)
    monkeypatch.setattr(settings, "CACHE_DIR", cache)
    pages._cached.cache_clear()
    job = PlanContext(LID).queue()[0]
    street = job.address.split(",")[0].title()
    seed_page(URL, f"<html><body><h1>{job.label}</h1><p>The store at {street} in Cocoa was built in 1994 and "
                   f"anchors the Clearlake corridor.</p><p>Vacancy at the center was 12% in 2019.</p></body></html>")
    monkeypatch.setattr(locales, "FIXTURES_DIR", fixtures)
    return {"job": job, "dir": work / "agent_research"}


def test_pipeline_with_fake_model(env):
    job = env["job"]
    good = {"field": "year_built", "value": 1994, "source_url": URL, "quote": "in Cocoa was built in 1994 and anchors",
            "source_type": "press", "as_of": "2026"}
    stale = {"field": "vacancy_pct", "value": 12, "source_url": URL, "quote": "Vacancy at the center was 12% in 2019",
             "source_type": "press", "as_of": "2019"}
    denied = {"field": "stories", "value": 1, "source_url": "https://www.loopnet.com/Listing/x",
              "quote": "a one-story 1 story retail building here"}
    final = {"job_id": job.job_id, "building_id": job.building_id, "facts": [good, stale, denied],
             "not_found": ["asking_rent_usd_sqft_yr", "parking_spaces"]}
    model = ScriptedModel(messages=iter([
        _call("web_search", {"query": QUERY}, 1),
        _call("fetch_page", {"url": URL}, 2),
        _call("grep", {"pattern": "built in"}, 3),
        _call("check_facts", {"facts": [good, stale]}, 4),
        _call("ResearchedBuilding", final, 5),
        AIMessage(content="done"),
    ]))
    search = FixtureSearch({QUERY: [{"url": URL, "title": "Cocoa retail", "snippet": ""},
                                    {"url": "https://www.loopnet.com/Listing/x", "title": "LoopNet", "snippet": ""}]})
    rep = agent.run_locale(LID, model=model, search=search, max_jobs=1, workers=1, quiet=True)
    assert (rep.jobs, rep.run, rep.accepted, rep.proposed) == (1, 1, 1, 3), rep.text()
    assert rep.rejects == {"stale": 1, "denylisted": 1}

    # the page text was saved for the agent's grep / read_file
    saved = list((settings.CACHE_DIR / "research" / LID / "pages").glob("*.txt"))
    assert len(saved) == 1 and "built in 1994" in saved[0].read_text()

    # YAML: research/buildings_source.yaml shape, parsed value, quote in the note, confidence capped by source type
    entries = yaml.safe_load((env["dir"] / "buildings_source.yaml").read_text())
    assert len(entries) == 1
    e = entries[0]
    assert e["building_id"] == job.building_id and len(e["lonlat"]) == 2
    yb = e["fields"]["year_built"]
    assert yb["value"] == 1994 and yb["source_url"] == URL and yb["confidence"] == "low"
    assert "built in 1994" in yb["note"] and "code-verified" in yb["note"]
    rejects = [json.loads(x) for x in (env["dir"] / "rejects.jsonl").read_text().splitlines()]
    assert {r["check"] for r in rejects} == {"stale", "denylisted"}

    # the linker accepted it and the resolver serves it as agent_research
    linked = json.loads((env["dir"] / "buildings.json").read_text())
    assert [b["id"] for b in linked] == [job.building_id]
    recs = {r["id"]: r for r in default_resolver().get_records(locales.get_locale(LID), Capability.BUILDING_ATTRS)}
    v = recs[job.building_id]["year_built"]
    assert v.value == 1994 and v.prov.source == "agent_research" and v.prov.url == URL

    # resumable: a re-run reads the cached job result and never calls the model
    rep2 = agent.run_locale(LID, model=Exploding(messages=iter([])), search=search, max_jobs=1, workers=1, quiet=True)
    assert (rep2.cached, rep2.run, rep2.accepted) == (1, 0, 1)
