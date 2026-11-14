"""Every external call goes through here, cached to cache/http keyed by request (AGENTS.md rule 7)."""
import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal, Optional

import httpx

from backend import settings

USER_AGENT = "tod-copilot/0.1 (hackathon; contact in repo)"
_EXT = {"json": "json", "bytes": "bin", "text": "txt"}


class OfflineCacheMiss(RuntimeError):
    def __init__(self, url: str):
        super().__init__(f"DEMO_OFFLINE=1 and no cached response for {url}")
        self.url = url


def cache_key(url: str, params: Optional[dict]) -> str:
    return hashlib.sha256(f"GET {url} {json.dumps(params, sort_keys=True)}".encode()).hexdigest()


def cached_get(url: str, params: Optional[dict] = None, *, headers: Optional[dict] = None,
               fmt: Literal["json", "bytes", "text"] = "json", timeout: float = 60.0) -> Any:
    d = settings.CACHE_DIR / "http"
    key = cache_key(url, params)
    body_path = d / f"{key}.{_EXT[fmt]}"
    if body_path.exists():
        raw = body_path.read_bytes()
    else:
        if settings.OFFLINE:
            raise OfflineCacheMiss(url)
        h = {"User-Agent": USER_AGENT, **(headers or {})}
        r = httpx.get(url, params=params, headers=h, timeout=timeout, follow_redirects=True)
        r.raise_for_status()
        raw = r.content
        d.mkdir(parents=True, exist_ok=True)
        body_path.write_bytes(raw)
        (d / f"{key}.meta.json").write_text(json.dumps(
            {"url": url, "params": params, "retrieved_at": datetime.now(timezone.utc).isoformat()}))
    if fmt == "bytes":
        return raw
    if fmt == "text":
        return raw.decode("utf-8", errors="replace")
    return json.loads(raw)


def retrieved_at(url: str, params: Optional[dict] = None) -> Optional[str]:
    meta = settings.CACHE_DIR / "http" / f"{cache_key(url, params)}.meta.json"
    return json.loads(meta.read_text())["retrieved_at"] if meta.exists() else None


def evict(url: str, params: Optional[dict] = None) -> None:
    """Drop a cached response (e.g. an HTTP-200 body that carries an API error)."""
    for p in (settings.CACHE_DIR / "http").glob(f"{cache_key(url, params)}.*"):
        p.unlink()
