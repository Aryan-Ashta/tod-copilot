"""Tools for the research subagents (docs/12 §4, §9): web_search, fetch_page, check_facts (the spec's
`submit_facts`, renamed: the final structured answer is what is submitted). All HTTP goes through
backend/data/http_cache.py; search results are cached by query under cache/research/search/.

Search provider (decided 2026-11-14): Anthropic's server-side web search tool, called through the `anthropic` SDK with
the existing ANTHROPIC_API_KEY (no new key); a fixture-backed fake for tests. Pick with
RESEARCH_SEARCH=anthropic|fixture:<path.yaml>."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional, Protocol

import httpx
import yaml

from backend import settings
from backend.data import http_cache
from backend.research import pages, registry
from backend.schemas import ResearchedFact

PREVIEW_CHARS = 1500
MAX_SEARCHES = 6    # per building job; operational budget, not a model factor
MAX_FETCHES = 8
MAX_CHECKS = 3
BUDGET_SPENT = ("budget spent: no more searching or fetching for this building. Dry-run what you have with "
                "check_facts, then give your final structured answer now")


class SearchProvider(Protocol):
    name: str

    def search(self, query: str) -> list[dict]: ...   # [{url, title, snippet}]


class FixtureSearch:
    """Fake search for tests and offline runs: {query: [{url, title, snippet}]} from a YAML file or dict."""
    name = "fixture"

    def __init__(self, results: dict | str | Path):
        self.results = results if isinstance(results, dict) else yaml.safe_load(Path(results).read_text()) or {}

    def search(self, query: str) -> list[dict]:
        return list(self.results.get(query, []))


class AnthropicSearch:
    """Anthropic's server-side web search tool, one search per query, results cached by query.

    The tool's own `blocked_domains` carries the global denylist, so CoStar-owned sites never come back."""
    name = "anthropic_web_search"
    TOOL = "web_search_20250305"

    def __init__(self, model: Optional[str] = None, blocked: Optional[list[str]] = None):
        self.model = (model or settings.RESEARCH_SEARCH_MODEL).split(":", 1)[-1]
        self.blocked = blocked if blocked is not None else registry.sources_for("")["denylist_domains"]
        self.usage = {"input_tokens": 0, "output_tokens": 0, "searches": 0}

    def _path(self, query: str) -> Path:
        key = hashlib.sha256(f"{self.TOOL} {self.model} {query}".encode()).hexdigest()
        return settings.CACHE_DIR / "research" / "search" / f"{key}.json"

    def search(self, query: str) -> list[dict]:
        p = self._path(query)
        if p.exists():
            return json.loads(p.read_text())["results"]
        if settings.OFFLINE:
            raise http_cache.OfflineCacheMiss(f"web_search: {query}")
        import anthropic
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        msg = client.messages.create(
            model=self.model, max_tokens=512,
            tools=[{"type": self.TOOL, "name": "web_search", "max_uses": 1, "blocked_domains": self.blocked}],
            messages=[{"role": "user", "content": f"Run exactly one web search for this query, then reply 'done'.\n"
                                                  f"Query: {query}"}])
        self.usage["input_tokens"] += msg.usage.input_tokens
        self.usage["output_tokens"] += msg.usage.output_tokens
        self.usage["searches"] += 1
        results = []
        for block in msg.content:
            if getattr(block, "type", "") != "web_search_tool_result" or not isinstance(block.content, list):
                continue
            for r in block.content:
                results.append({"url": r.url, "title": r.title, "snippet": f"page age: {r.page_age}" if
                                getattr(r, "page_age", None) else ""})
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"query": query, "provider": self.name, "model": self.model, "results": results,
                                 "retrieved_at": datetime.now(timezone.utc).isoformat()}, indent=1))
        return results


def search_provider() -> SearchProvider:
    choice = settings.RESEARCH_SEARCH
    if choice.startswith("fixture:"):
        return FixtureSearch(choice.split(":", 1)[1])
    if choice == "anthropic":
        return AnthropicSearch()
    raise ValueError(f"RESEARCH_SEARCH={choice!r}: use 'anthropic' or 'fixture:<path.yaml>'")


def page_file(url: str) -> str:
    return f"/pages/{hashlib.sha256(url.encode()).hexdigest()[:16]}.txt"


def web_tools(county_fips: str, pages_root: Path, search: SearchProvider, *, max_searches: int = MAX_SEARCHES,
              max_fetches: int = MAX_FETCHES) -> list[Callable]:
    """web_search + fetch_page, bound to one county's policies, one working directory for page text and one job's
    budget (enforced here, not left to the prompt: a model that keeps searching gets told to answer)."""
    used = {"search": 0, "fetch": 0}

    def web_search(query: str) -> str:
        """Search the web. Returns up to 10 results as `url | title | snippet` lines. CoStar-owned sites (LoopNet,
        CoStar, Apartments.com, ...) are removed: never use them."""
        if used["search"] >= max_searches:
            return f"{BUDGET_SPENT} ({max_searches} searches used)"
        used["search"] += 1
        try:
            hits = search.search(query)
        except Exception as e:   # offline, quota, network: tell the agent, never guess
            return f"error: search failed ({type(e).__name__}: {str(e)[:200]})"
        hits = [h for h in hits if not registry.denied(h["url"], county_fips)][:10]
        return "\n".join(f"{h['url']} | {h.get('title') or ''} | {h.get('snippet') or ''}" for h in hits) or "no results"

    def fetch_page(url: str) -> str:
        """Fetch a web page or PDF through the cache and save its text to a file you can `grep` and `read_file`
        (PDF pages are marked `=== page N ===`). Only facts from pages fetched here can be accepted."""
        if registry.denied(url, county_fips):
            return f"refused: {registry.domain(url)} is a CoStar-owned site (denylisted); find another source"
        if used["fetch"] >= max_fetches:
            return f"{BUDGET_SPENT} ({max_fetches} page fetches used)"
        used["fetch"] += 1
        try:
            raw = http_cache.cached_get(url, fmt="bytes", timeout=60.0)
        except httpx.HTTPStatusError as e:
            return f"error: HTTP {e.response.status_code} for {url}"
        except Exception as e:
            return f"error: {type(e).__name__}: {str(e)[:200]}"
        try:
            pt = pages.extract(url, raw)
        except Exception as e:
            return f"error: could not read the page text ({type(e).__name__}: {str(e)[:200]})"
        body = ("\n".join(f"=== page {i} ===\n{t}" for i, t in enumerate(pt.pages, 1)) if pt.kind == "pdf"
                else pt.full)
        rel = page_file(url)
        dest = pages_root / rel.lstrip("/")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(f"URL: {url}\n{body}")
        head = pt.full[:PREVIEW_CHARS].strip()
        return (f"saved {rel} ({pt.kind}, {len(pt.pages)} page{'s' if len(pt.pages) != 1 else ''}, "
                f"{len(pt.full):,} chars). Title: {pt.title or 'none'}\n--- first {PREVIEW_CHARS} chars ---\n{head}")

    return [web_search, fetch_page]


def make_tools(county_fips: str, pages_root: Path, search: SearchProvider,
               check: Callable[[list[ResearchedFact]], list[str]], *, max_searches: int = MAX_SEARCHES,
               max_fetches: int = MAX_FETCHES, max_checks: int = MAX_CHECKS) -> list[Callable]:
    """The three research tools: web_tools plus the check_facts dry run of the code verifier."""
    used = {"check": 0}

    def check_facts(facts: list[ResearchedFact]) -> str:
        """Dry-run the code verifier on candidate facts. This does NOT save anything: your final structured answer
        does. Returns one line per fact: `accepted` or `rejected (<check>): <why>`. Fix rejected quotes from the
        saved page text, or drop them; never guess."""
        if used["check"] >= max_checks:
            return f"check budget spent ({max_checks} checks): give your final structured answer now"
        used["check"] += 1
        out = "\n".join(check(facts)) or "no facts given"
        return f"{out}\nNext: give your final structured answer with the accepted facts."

    return web_tools(county_fips, pages_root, search, max_searches=max_searches, max_fetches=max_fetches) + [check_facts]
