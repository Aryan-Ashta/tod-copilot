"""The loader serves agent-built corpora (backend/corpus/agent/<j>/) beside curated ones: agent rules and their
citations carry status agent_verified, curated wins on a clash. Offline, against a tmp corpus."""
import pytest
import yaml

from backend.corpus import loader
from backend.models import zoning

CITE_A = {"doc_id": "a_code", "section": "Sec. 1", "quote": "Housing is permitted"}
CITE_B = {"doc_id": "b_code", "section": "Sec. 2", "quote": "Apartments are allowed by right"}


def _rules(path: str, cite: dict) -> list[dict]:
    return [{"path": path, "rule": "eligible", "applies_if": {}, "value": True, "cite": cite},
            {"path": path, "rule": "allows_uses", "applies_if": {}, "value": ["residential"], "cite": cite},
            {"path": path, "rule": "approval_steps", "applies_if": {}, "value": 1, "cite": cite}]


def _doc(d, jurisdiction: str, doc_id: str, heading: str, text: str) -> dict:
    (d / f"{doc_id}.md").write_text(f"# {doc_id}\n\n## {heading}\n\n{text}\n")
    return {"doc_id": doc_id, "title": doc_id, "jurisdiction": jurisdiction, "path_name": None,
            "url": f"https://example.gov/{doc_id}", "retrieved_at": "2025-11-14"}


@pytest.fixture
def corpus_dir(tmp_path, monkeypatch):
    root = tmp_path / "corpus"
    (root / "a").mkdir(parents=True)
    (root / "rules").mkdir()
    (root / "index.yaml").write_text(yaml.safe_dump(
        [_doc(root / "a", "a", "a_code", "Sec. 1", "Housing is permitted in every district, version 1.")]))
    (root / "rules" / "a.yaml").write_text(yaml.safe_dump(_rules("A path", CITE_A)))
    (root / "paths.yaml").write_text(yaml.safe_dump({"A path": {"kind": "both"}}))
    agent = root / "agent"
    (agent / "b").mkdir(parents=True)
    (agent / "b" / "index.yaml").write_text(yaml.safe_dump(
        [_doc(agent / "b", "b", "b_code", "Sec. 2", "Apartments are allowed by right near stations.")]))
    (agent / "b" / "rules.yaml").write_text(yaml.safe_dump(_rules("B path", CITE_B)))
    (agent / "b" / "paths.yaml").write_text(yaml.safe_dump({"B path": {"kind": "conversion"},
                                                           "A path": {"kind": "new_construction"}}))
    (agent / "a").mkdir()
    (agent / "a" / "rules.yaml").write_text(yaml.safe_dump(_rules("Agent A path", CITE_A)))
    monkeypatch.setattr(loader, "CORPUS_DIR", root)
    loader.clear_cache()
    yield root
    loader.clear_cache()


def test_agent_corpus_is_served_with_status(corpus_dir):
    assert loader.has_rules("b")
    assert {r["status"] for r in loader.load_rules("b")} == {"agent_verified"}
    assert loader.load_rules("a") == _rules("A path", CITE_A)   # curated rules file wins over agent/a/
    assert {d["doc_id"]: d["status"] for d in loader.load_index()} == {"a_code": "reviewed",
                                                                       "b_code": "agent_verified"}
    assert loader.load_sections("b_code") == {"Sec. 2": "Apartments are allowed by right near stations."}
    assert loader.path_info("B path")["kind"] == "conversion"
    assert loader.path_info("A path")["kind"] == "both"          # curated paths.yaml wins
    assert loader.search_corpus("b", "apartments")[0]["doc_id"] == "b_code"
    path = zoning.apply_rules({}, loader.load_rules("b"), ["B path"], {})[0]
    assert path.eligible is True and {c.status for c in path.citations} == {"agent_verified"}
    curated = zoning.apply_rules({}, loader.load_rules("a"), ["A path"], {})[0]
    assert {c.status for c in curated.citations} == {"reviewed"}
