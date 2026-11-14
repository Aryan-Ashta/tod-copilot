"""AgentResearchProvider (docs/12 §10): below costar and public_research, above county parcels; every value carries
source "agent_research", its own confidence and the quote in its note."""
import json

import pytest

from backend.data import locales
from backend.data.resolver import Capability, default_resolver
from backend.schemas import Sourced

LID = "houston_downtown"
QUOTE = '"Vacancy stood at 38% in Q2 2026" (brokerage_report, as of Q2 2026; agent-found, code-verified)'


def _field(value, conf="medium"):
    return {"value": value, "source_url": "https://example.org/report.pdf", "note": QUOTE, "confidence": conf,
            "retrieved_at": "2026-11-14T12:00:00+00:00"}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    """The Houston fixtures (symlinked) plus a hand-written agent_research/ folder."""
    real = locales.FIXTURES_DIR / LID
    work = tmp_path / LID
    work.mkdir()
    for child in real.iterdir():
        if child.name != "agent_research":
            (work / child.name).symlink_to(child)
    loc = locales.get_locale(LID)
    r = default_resolver()
    recs = {x["id"]: x for x in r.get_records(loc, Capability.BUILDING_ATTRS)}
    has_research = next(i for i, x in recs.items() if isinstance(x.get("vacancy_pct"), Sourced)
                        and x["vacancy_pct"].prov.source == "public_research")
    bare = next(i for i, x in recs.items() if i.startswith("osm:") and "vacancy_pct" not in x)
    parcel = next(x for x in r.get_records(loc, Capability.OWNERSHIP_SALES)
                  if isinstance(x.get("owner"), Sourced) and x["owner"].prov.source == "county_parcels"
                  and x["owner"].value)
    d = work / "agent_research"
    d.mkdir()
    (d / "buildings.json").write_text(json.dumps([
        {"id": has_research, "fields": {"vacancy_pct": _field(1.0)}},
        {"id": bare, "fields": {"vacancy_pct": _field(38)}},
    ]))
    (d / "parcels.json").write_text(json.dumps([{"id": parcel["id"], "fields": {"owner": _field("Example Owner LLC", "low")}}]))
    (d / "_meta.json").write_text(json.dumps({"source": "agent_research", "urls": [], "retrieved_at": "2026-11-14T12:00:00+00:00"}))
    monkeypatch.setattr(locales, "FIXTURES_DIR", tmp_path)
    return {"loc": loc, "has_research": has_research, "bare": bare, "parcel": parcel["id"]}


def test_provider_order():
    names = [p.name for p in default_resolver().providers]
    assert names.index("costar") < names.index("public_research") < names.index("agent_research") \
        < names.index("county_parcels")


def test_agent_values_fill_gaps_but_never_override_better_sources(setup):
    r = default_resolver()
    recs = {x["id"]: x for x in r.get_records(setup["loc"], Capability.BUILDING_ATTRS)}
    kept = recs[setup["has_research"]]["vacancy_pct"]
    assert kept.prov.source == "public_research" and kept.value != 1.0
    filled = recs[setup["bare"]]["vacancy_pct"]
    assert filled.value == 38 and filled.prov.source == "agent_research"
    assert filled.prov.confidence == "medium" and "Vacancy stood at 38%" in filled.prov.note
    assert filled.prov.url == "https://example.org/report.pdf"
    assert filled.prov.retrieved_at.isoformat() == "2026-11-14T12:00:00+00:00"


def test_agent_parcel_values_beat_county(setup):
    recs = {x["id"]: x for x in default_resolver().get_records(setup["loc"], Capability.OWNERSHIP_SALES)}
    owner = recs[setup["parcel"]]["owner"]
    assert owner.value == "Example Owner LLC" and owner.prov.source == "agent_research" and owner.prov.confidence == "low"
