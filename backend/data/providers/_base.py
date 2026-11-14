"""Shared helpers for fixture-backed providers. Runtime providers read committed fixtures only."""
import json
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from backend.data.locales import locale_dir
from backend.schemas import Confidence, Provenance, Sourced


def fx(locale_id: str, *parts: str) -> Path:
    return locale_dir(locale_id).joinpath(*parts)


@lru_cache(maxsize=None)
def meta(locale_id: str, sub: str) -> dict:
    p = fx(locale_id, sub, "_meta.json")
    return json.loads(p.read_text()) if p.exists() else {}


def retrieved(locale_id: str, sub: str) -> datetime:
    t = meta(locale_id, sub).get("retrieved_at")
    return datetime.fromisoformat(t) if t else datetime.now(timezone.utc)


def first_url(locale_id: str, sub: str) -> Optional[str]:
    urls = meta(locale_id, sub).get("urls") or []
    return urls[0] if urls else None


@lru_cache(maxsize=None)
def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def features(path: Path) -> list[dict]:
    return load_json(path)["features"] if path.exists() else []


def prov(source: str, confidence: Confidence, at: datetime, url: Optional[str] = None,
         note: Optional[str] = None) -> Provenance:
    return Provenance(source=source, confidence=confidence, retrieved_at=at, url=url, note=note)


def sourced(value: Any, p: Provenance, missing_note: Optional[str] = None) -> Sourced:
    """Wrap a value; None becomes an explicit missing value with the same source."""
    if value is None:
        return Sourced(value=None, prov=p.model_copy(update={"confidence": "missing",
                                                             "note": missing_note or p.note}))
    return Sourced(value=value, prov=p)
