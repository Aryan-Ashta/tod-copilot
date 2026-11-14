"""Curated legal corpus access: index, verbatim sections, BM25 search, structured rules.

Layout and formats: docs/10-legal-corpus.md. Each document is `<jurisdiction>/<doc_id>.md` with one
`## <official section>` heading per section and the verbatim text under it.
"""
from __future__ import annotations

import copy
import re
from functools import lru_cache

import yaml
from rank_bm25 import BM25Okapi

from backend.settings import CORPUS_DIR

# Jurisdictions whose search also covers another jurisdiction's documents (state law applies locally).
_SEARCH_ALSO = {"los_angeles": ("california",), "brevard": ("florida",)}


def _tokens(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


@lru_cache(maxsize=1)
def _index() -> tuple[dict, ...]:
    with open(CORPUS_DIR / "index.yaml") as fh:
        return tuple(yaml.safe_load(fh))


def load_index() -> list[dict]:
    """All registered documents: doc_id, title, jurisdiction, path_name, url, retrieved_at."""
    return [dict(d) for d in _index()]


def _doc(doc_id: str) -> dict:
    for d in _index():
        if d["doc_id"] == doc_id:
            return d
    raise KeyError(f"doc_id not in corpus index: {doc_id}")


@lru_cache(maxsize=None)
def _sections(doc_id: str) -> tuple[tuple[str, str], ...]:
    d = _doc(doc_id)
    text = (CORPUS_DIR / d["jurisdiction"] / f"{doc_id}.md").read_text()
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
    jurisdictions = (jurisdiction, *_SEARCH_ALSO.get(jurisdiction, ()))
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

    Only chunks sharing at least one query token are returned. `los_angeles` also searches `california`;
    `brevard` also searches `florida`.
    """
    bm25, chunks, token_sets = _bm25(jurisdiction)
    q = _tokens(query)
    if bm25 is None or not q:
        return []
    scores = bm25.get_scores(q)
    qset = set(q)
    ranked = sorted((i for i in range(len(chunks)) if qset & token_sets[i]), key=lambda i: (-scores[i], i))
    return [dict(chunks[i]) for i in ranked[:k]]


@lru_cache(maxsize=None)
def _rules(jurisdiction: str) -> tuple[dict, ...]:
    with open(CORPUS_DIR / "rules" / f"{jurisdiction}.yaml") as fh:
        return tuple(yaml.safe_load(fh) or [])


def load_rules(jurisdiction: str) -> list[dict]:
    """Structured rules for a jurisdiction: [{path, rule, applies_if, value, cite: {doc_id, section, quote}}]."""
    return copy.deepcopy(list(_rules(jurisdiction)))
