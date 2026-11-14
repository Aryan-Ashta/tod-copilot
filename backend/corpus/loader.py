"""Legal corpus access: index, verbatim sections, BM25 search, structured rules.

Layout and formats: docs/10-legal-corpus.md. Each document is `<jurisdiction>/<doc_id>.md` with one
`## <official section>` heading per section and the verbatim text under it. Curated documents (reviewed by a
person) live under backend/corpus/; agent-built ones (code-checked, not reviewed) under backend/corpus/agent/
<jurisdiction>/ and carry status agent_verified. Curated wins on a doc_id or rules-file clash.
"""
from __future__ import annotations

import copy
import re
from functools import lru_cache
from pathlib import Path

import yaml
from rank_bm25 import BM25Okapi

from backend.settings import CORPUS_DIR

RULE_KINDS = {
    "eligible", "max_height_ft", "max_units_per_acre", "max_far", "parking_min_per_unit",
    "allows_uses", "approval_steps", "discretionary", "note", "stop_tier",
}
USES = {"residential", "hotel", "mixed_use", "keep_current"}
ATTRS = {
    "property_type", "land_use", "building_age_years", "stories", "distance_to_stop_mi", "station_mode",
    "stop_tier", "area_acres", "zoning_code", "in_flood_zone", "est_units",
}
OPS = {"in", "lte", "gte", "eq"}


def _with_state(jurisdiction: str) -> tuple[str, ...]:
    """The jurisdiction plus the state whose law applies there (backend/registry)."""
    from backend.onboard.registry import state_jurisdiction
    s = state_jurisdiction(jurisdiction)
    return (jurisdiction, s) if s else (jurisdiction,)


def _tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


def agent_dir() -> Path:
    """Agent-built corpora: agent/<jurisdiction>/{index.yaml, <doc_id>.md, rules.yaml, paths.yaml, review.md}."""
    return CORPUS_DIR / "agent"


def _yaml(path: Path):
    with open(path) as fh:
        return yaml.safe_load(fh)


@lru_cache(maxsize=1)
def _index() -> tuple[dict, ...]:
    out = [{**d, "status": "reviewed"} for d in _yaml(CORPUS_DIR / "index.yaml") or []]
    seen = {d["doc_id"] for d in out}
    for p in sorted(agent_dir().glob("*/index.yaml")):
        for d in _yaml(p) or []:
            if d["doc_id"] not in seen:
                seen.add(d["doc_id"])
                out.append({**d, "status": "agent_verified"})
    return tuple(out)


def load_index() -> list[dict]:
    """All documents: doc_id, title, jurisdiction, path_name, url, retrieved_at, status (reviewed|agent_verified)."""
    return [dict(d) for d in _index()]


def _doc(doc_id: str) -> dict:
    for d in _index():
        if d["doc_id"] == doc_id:
            return d
    raise KeyError(f"doc_id not in corpus index: {doc_id}")


@lru_cache(maxsize=None)
def _sections(doc_id: str) -> tuple[tuple[str, str], ...]:
    d = _doc(doc_id)
    base = CORPUS_DIR if d["status"] == "reviewed" else agent_dir()
    text = (base / d["jurisdiction"] / f"{doc_id}.md").read_text()
    out: list[tuple[str, str]] = []
    head: str | None = None
    buf: list[str] = []
    for line in text.split("\n"):
        if line.startswith("## "):
            if head is not None:
                out.append((head, "\n".join(buf).strip()))
            head, buf = line[3:].strip(), []
        elif head is not None:
            buf.append(line)
    if head is not None:
        out.append((head, "\n".join(buf).strip()))
    return tuple(out)


def load_sections(doc_id: str) -> dict[str, str]:
    """Section heading -> verbatim section text, in document order."""
    return dict(_sections(doc_id))


@lru_cache(maxsize=None)
def _bm25(jurisdiction: str) -> tuple[BM25Okapi | None, tuple[dict, ...], tuple[frozenset[str], ...]]:
    jurisdictions = _with_state(jurisdiction)
    chunks = tuple(
        {"doc_id": d["doc_id"], "section": sec, "text": txt}
        for d in _index() if d["jurisdiction"] in jurisdictions
        for sec, txt in _sections(d["doc_id"])
    )
    if not chunks:
        return None, (), ()
    toks = [_tokens(f'{c["section"]} {c["text"]}') for c in chunks]
    return BM25Okapi(toks), chunks, tuple(frozenset(t) for t in toks)


def search_corpus(jurisdiction: str, query: str, k: int = 5) -> list[dict]:
    """Top-k section chunks by BM25 for `query`: [{doc_id, section, text}].

    Only chunks sharing at least one query token are returned. A city or county also searches its state's
    documents (e.g. `los_angeles` searches `california`).
    """
    bm25, chunks, token_sets = _bm25(jurisdiction)
    q = _tokens(query)
    if bm25 is None or not q:
        return []
    scores = bm25.get_scores(q)
    qset = set(q)
    ranked = sorted((i for i in range(len(chunks)) if qset & token_sets[i]), key=lambda i: (-scores[i], i))
    return [dict(chunks[i]) for i in ranked[:k]]


def rules_file(jurisdiction: str) -> Path:
    """The curated (person-reviewed) rules file of a jurisdiction."""
    return CORPUS_DIR / "rules" / f"{jurisdiction}.yaml"


def _agent_rules_file(jurisdiction: str) -> Path:
    return agent_dir() / jurisdiction / "rules.yaml"


@lru_cache(maxsize=None)
def _rules(jurisdiction: str) -> tuple[dict, ...]:
    out = []
    for j in _with_state(jurisdiction):
        if rules_file(j).exists():
            out += _yaml(rules_file(j)) or []
        elif _agent_rules_file(j).exists():
            out += [{**r, "status": "agent_verified"} for r in _yaml(_agent_rules_file(j)) or []]
    return tuple(out)


def has_rules(jurisdiction: str) -> bool:
    """True when the jurisdiction or its state has a curated or agent-built rules file."""
    return any(rules_file(j).exists() or _agent_rules_file(j).exists() for j in _with_state(jurisdiction))


def load_rules(jurisdiction: str) -> list[dict]:
    """Structured rules for a jurisdiction, then its state's: [{path, rule, applies_if, value, cite, status?}].
    Agent-built rules carry status agent_verified; curated ones carry no status (reviewed)."""
    return copy.deepcopy(list(_rules(jurisdiction)))


@lru_cache(maxsize=1)
def _paths() -> dict:
    out = _yaml(CORPUS_DIR / "paths.yaml") or {}
    for p in sorted(agent_dir().glob("*/paths.yaml")):
        for name, info in (_yaml(p) or {}).items():
            out.setdefault(name, info)
    return out


def clear_cache() -> None:
    """Forget cached corpus reads (call after the agent corpus is written in this process)."""
    for f in (_index, _sections, _bm25, _rules, _paths):
        f.cache_clear()


def path_info(name: str) -> dict:
    """{kind: new_construction|conversion|both, explain_note?} for a legal path (backend/corpus/paths.yaml)."""
    return {"kind": "both", **(_paths().get(name) or {})}
