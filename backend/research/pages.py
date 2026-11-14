"""Page text for agent research: one extractor shared by `fetch_page` (what the agent reads) and the verifier (what
code checks), so both see the same text. Bodies come only from the HTTP cache (backend/data/http_cache.py)."""
import io
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from html.parser import HTMLParser
from typing import Optional

from backend.data import http_cache

_SKIP = {"script", "style", "noscript", "template", "svg", "head"}
_BLOCK = {"p", "div", "br", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
          "table", "dt", "dd", "header", "footer", "blockquote", "pre"}
_QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'", "\u00b4": "'",
                         "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2033": '"',
                         "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-",
                         "\u2212": "-", "\u00a0": " ", "\u00ad": ""})


@dataclass
class PageText:
    url: str
    kind: str              # "pdf" | "html" | "text"
    title: Optional[str]
    pages: list[str]       # one entry per PDF page; a single entry for HTML/text

    @property
    def full(self) -> str:
        return "\n".join(self.pages)


class _Html(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0
        self.title: Optional[str] = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self.skip += 1
        if tag == "title":
            self._in_title = True
        if tag in _BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in _SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self._in_title = False
        if tag in _BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self._in_title and self.title is None:
            self.title = data.strip() or None
        if not self.skip:
            self.out.append(data)


def extract(url: str, raw: bytes) -> PageText:
    if raw[:5] == b"%PDF-":
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(raw))
        pages = []
        for p in reader.pages:
            try:
                pages.append(p.extract_text() or "")
            except Exception:  # one unreadable page must not lose the document
                pages.append("")
        title = (reader.metadata or {}).get("/Title") if reader.metadata else None
        return PageText(url, "pdf", str(title) if title else None, pages)
    text = raw.decode("utf-8", errors="replace")
    if re.search(r"<\s*(html|body|div|p|table)\b", text[:5000], re.I):
        h = _Html()
        h.feed(text)
        body = re.sub(r"[ \t\r\f\v]+", " ", "".join(h.out))
        body = re.sub(r"\n\s*\n+", "\n", body).strip()
        return PageText(url, "html", h.title, [body])
    return PageText(url, "text", None, [text])


@lru_cache(maxsize=256)
def _cached(url: str, retrieved_at: str) -> PageText:
    return extract(url, http_cache.cached_get(url, fmt="bytes"))


def cached_page(url: str) -> Optional[PageText]:
    """The page as fetched through the HTTP cache, or None when it was never fetched (never calls out)."""
    at = http_cache.retrieved_at(url)
    return _cached(url, at) if at is not None else None


def normalize(s: str) -> str:
    """Whitespace collapsed, quotes and dashes unified, case folded: the form quotes are matched in."""
    s = unicodedata.normalize("NFKC", s).translate(_QUOTES)
    return re.sub(r"\s+", " ", s).strip().casefold()
