"""Verifier for agent-researched facts (docs/12 §7). Pure apart from reading the HTTP cache.

A fact is accepted only when its page was fetched through the cache, the quote is on that page, code parses exactly
one value out of the quote that equals the claimed one, the value is in range and fresh, the cross-checks pass and
the page names the building near the quote. The stored value is the parsed one, never the LLM's."""
import re
from dataclasses import asdict, dataclass, field
from datetime import date
from typing import Optional, Union

from backend.research import pages, registry
from backend.schemas import ResearchedFact

CONF_ORDER = {"missing": 0, "low": 1, "medium": 2, "high": 3}
MAX_CONFIDENCE = "medium"
QUOTE_LEN = (20, 400)

_NUM = re.compile(r"(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?![\d,]*\d)")
_MULT = {"thousand": 1e3, "k": 1e3, "million": 1e6, "mil": 1e6, "mm": 1e6, "m": 1e6, "billion": 1e9, "bn": 1e9,
         "b": 1e9}
_SQFT = r"\s*(?:(million)\s*)?(?:sf|sq\.?\s*ft\.?|sq\.?\s*feet|square[\s-]*f(?:ee|oo)t|rsf|gsf|nrsf|rba)\b"
_MONTHLY = re.compile(r"/\s*mo\b|/\s*month|per month|a month|monthly")
_DIRECTIONS = {"n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"}
_SUFFIXES = {"st", "street", "ave", "av", "avenue", "blvd", "boulevard", "rd", "road", "dr", "drive", "ln", "lane",
             "way", "pkwy", "parkway", "pl", "place", "ct", "court", "hwy", "highway", "fwy", "freeway", "ter",
             "terrace", "cir", "circle", "sq", "square", "trl", "trail", "plz", "plaza", "pike", "expy", "loop"}


@dataclass
class BuildingRef:
    """What the verifier knows about the building a fact claims to describe (merged values, any source)."""
    building_id: str
    name: Optional[str] = None
    address: Optional[str] = None
    osm_levels: Optional[int] = None
    footprint_sqft: Optional[float] = None
    stories: Optional[float] = None
    rentable_area_sqft: Optional[float] = None
    typical_floor_sqft: Optional[float] = None


@dataclass
class Accepted:
    field: str
    value: Union[float, int, str]
    source_url: str
    quote: str
    confidence: str
    note: str
    retrieved_at: str
    source_type: Optional[str] = None
    as_of: Optional[str] = None
    page: Optional[int] = None

    def record(self) -> dict:
        """The fixture record shape ({value, source_url, note} + confidence and retrieved_at)."""
        return {"value": self.value, "source_url": self.source_url, "note": self.note,
                "confidence": self.confidence, "retrieved_at": self.retrieved_at}


@dataclass
class Rejected:
    field: str
    check: str
    detail: str
    fact: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


Verdict = Union[Accepted, Rejected]


# ---------------------------------------------------------------- parsing
def _num(m: re.Match) -> float:
    return float(m.group(1).replace(",", "") + (m.group(2) or ""))


def _anchor_gap(q: str, start: int, end: int, keywords: list[str]) -> Optional[int]:
    """Characters between the number and the nearest keyword, with no other digit in between (None: no keyword)."""
    after = q[end:end + 30]
    after = after[:next((i for i, ch in enumerate(after) if ch.isdigit()), len(after))]
    before = q[max(0, start - 30):start]
    before = before[max((i + 1 for i, ch in enumerate(before) if ch.isdigit()), default=0):]
    gaps = [after.find(k.casefold()) for k in keywords if k.casefold() in after]
    gaps += [len(before) - before.rfind(k.casefold()) - len(k) for k in keywords if k.casefold() in before]
    return min(gaps) if gaps else None


def _anchored(q: str, start: int, end: int, keywords: list[str]) -> bool:
    return _anchor_gap(q, start, end, keywords) is not None


_RANGE = re.compile(r"\s*(?:%|percent|sf|sq\.?\s*ft\.?|square feet)?\s*(?:-|to|and|through|or)\s*\$?\s*")


def _pick(cands: list[tuple[float | str, int, int]], q: str, keywords: list[str]) -> tuple[Optional[float | str], str]:
    """The only value in the quote, or else the only value closest to a field keyword. A range or alternative
    ("between 1857 and 1869", "$24-$28", "12 or 14 stories") is never narrowed to one end."""
    if not cands:
        return None, "no value of this kind in the quote"
    if len({c[0] for c in cands}) == 1:
        return cands[0][0], ""
    s = sorted(cands, key=lambda c: c[1])
    if any(_RANGE.fullmatch(q[a[2]:b[1]]) for a, b in zip(s, s[1:])):
        return None, "the quote gives a range or alternatives, not one value"
    gaps = [(g, c[0]) for c in cands if (g := _anchor_gap(q, c[1], c[2], keywords)) is not None]
    if gaps:
        best = min(g for g, _ in gaps)
        closest = {v for g, v in gaps if g == best}
        if len(closest) == 1:
            return closest.pop(), ""
    return None, f"ambiguous: {len({c[0] for c in cands})} values in the quote"


def parse_value(spec: dict, quote: str, claimed: Union[float, int, str, None] = None) -> tuple[Optional[float | int | str], str]:
    """(value, "") or (None, reason). Exactly one value of the field's kind must come out of the quote."""
    q = pages.normalize(quote)
    kind, kw = spec["parse"], spec.get("keywords") or []
    if kind == "text":
        want = pages.normalize(str(claimed or ""))
        if len(want) < 2:
            return None, "empty text value"
        if want not in q:
            return None, "text value not in quote"
        return re.sub(r"\s+", " ", str(claimed)).strip(), ""   # confirmed present in the quote (case/space aside)
    if kind == "enum":
        vals = [v.casefold() for v in spec["values"]]
        alt = "|".join(re.escape(v) for v in vals)
        found = {m.group(1) or m.group(2) for m in re.finditer(rf"\bclass[\s-]*({alt})\b|\b({alt})[\s-]*class\b", q)}
        if len(found) != 1:
            return None, "no class value in the quote" if not found else f"ambiguous: {len(found)} classes"
        return found.pop().upper(), ""
    if kind == "usd_per_sqft_yr" and _MONTHLY.search(q):
        return None, "monthly rent; values are never converted"
    cands: list[tuple[float, int, int]] = []
    if kind == "percent":
        cands = [(_num(m), m.start(), m.end()) for m in _NUM.finditer(q)
                 if re.match(r"\s*(%|percent\b|pct\b)", q[m.end():])]
    elif kind in ("usd", "usd_per_sqft_yr", "usd_per_sqft"):
        for m in re.finditer(r"\$\s*" + _NUM.pattern + r"\s*(thousand|million|billion|mil|mm|bn|k|m|b)?\b", q):
            v = float(m.group(1).replace(",", "") + (m.group(2) or ""))
            if kind == "usd":
                v *= _MULT.get(m.group(3) or "", 1)
            elif m.group(3):
                continue   # "$2 million" is not a rent per sqft
            cands.append((v, m.start(), m.end()))
    elif kind == "sqft":
        for m in _NUM.finditer(q):
            u = re.match(_SQFT, q[m.end():])
            if u:
                cands.append((_num(m) * (1e6 if u.group(1) else 1), m.start(), m.end()))
    elif kind == "year":
        cands = [(int(m.group(1)), m.start(), m.end()) for m in _NUM.finditer(q)
                 if not m.group(2) and "," not in m.group(1) and 1700 <= int(m.group(1)) <= 2100
                 and not q[max(0, m.start() - 1):m.start()].startswith("$")]
    elif kind == "integer":
        cands = [(int(m.group(1).replace(",", "")), m.start(), m.end()) for m in _NUM.finditer(q)
                 if not m.group(2) and not q[max(0, m.start() - 1):m.start()].startswith("$")
                 and not re.match(r"\s*(%|percent)", q[m.end():])]
        if len({c[0] for c in cands}) > 1:   # drop years ("built in 1960, 29 stories") before anchoring
            cands = [c for c in cands if not 1700 <= c[0] <= 2100 or _anchored(q, c[1], c[2], kw)] or cands
    else:
        raise ValueError(f"unknown parser {kind}")
    v, why = _pick(cands, q, kw)
    if v is None:
        return None, why
    if kind in ("integer", "year"):
        return int(v), ""
    return (int(v) if float(v).is_integer() else round(float(v), 4)), ""


def _as_number(v) -> Optional[float]:
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").replace("$", "").replace("%", "").strip())
    except ValueError:
        return None


def _equal(spec: dict, parsed, claimed, tol: float) -> bool:
    kind = spec["parse"]
    if kind in ("text", "enum"):
        return pages.normalize(str(parsed)) == pages.normalize(str(claimed))
    c = _as_number(claimed)
    if c is None:
        return False
    if kind in ("integer", "year"):
        return float(parsed) == c
    return abs(float(parsed) - c) <= tol * max(abs(float(parsed)), 1.0)


def as_of_year(as_of: Optional[str]) -> Optional[int]:
    years = [int(y) for y in re.findall(r"(?<!\d)((?:19|20)\d\d)(?!\d)", as_of or "")]
    return max(years) if years else None


# ---------------------------------------------------------------- identity
def address_parts(address: Optional[str]) -> Optional[tuple[str, list[str]]]:
    """'1021 Main St, Houston, TX' -> ('1021', ['main']); '3600 WILSHIRE BLVD LOS ANGELES CA' -> ('3600', ['wilshire'])."""
    if not address:
        return None
    toks = re.findall(r"[a-z0-9]+", pages.normalize(address.split(",")[0]))
    if len(toks) < 2 or not re.fullmatch(r"\d+[a-z]?", toks[0]):
        return None
    core: list[str] = []
    for t in toks[1:]:
        if not core and t in _DIRECTIONS:
            continue
        if t in _SUFFIXES and core:
            break
        core.append(t)
        if len(core) == 3:
            break
    return (re.match(r"\d+", toks[0]).group(0), core) if core else None


def _mentions(window: str, ref: BuildingRef) -> bool:
    if ref.name and len(pages.normalize(ref.name)) >= 4 and pages.normalize(ref.name) in window:
        return True
    parts = address_parts(ref.address)
    if parts is None:
        return False
    number, core = parts
    return bool(re.search(rf"(?<!\d){number}(?!\d)", window)) and all(
        re.search(rf"\b{re.escape(t)}\b", window) for t in core)


def _scope_mentioned(window: str, scope: str) -> bool:
    s = pages.normalize(scope)
    toks = [t for t in re.findall(r"[a-z0-9]+", s) if len(t) >= 3]
    return s in window or (bool(toks) and all(re.search(rf"\b{re.escape(t)}\b", window) for t in toks))


# ---------------------------------------------------------------- cross-checks (pure)
def _osm_levels_within_2(value, ref: BuildingRef, f: dict) -> Optional[str]:
    if ref.osm_levels is not None and abs(float(value) - ref.osm_levels) > f["research_osm_levels_max_diff"]:
        return f"{value} stories vs OSM building:levels {ref.osm_levels}"
    return None


def _area_vs_footprint(value, ref: BuildingRef, f: dict) -> Optional[str]:
    if not ref.footprint_sqft or not ref.stories:
        return None
    lo, hi = f["research_area_ratio_range"]
    r = float(value) / (ref.footprint_sqft * ref.stories)
    return None if lo <= r <= hi else (f"rentable / (footprint x stories) = {r:.2f} outside {lo}-{hi} "
                                       f"(footprint {ref.footprint_sqft:,.0f} sqft, {ref.stories:g} stories)")


def _typical_floor_le_footprint(value, ref: BuildingRef, f: dict) -> Optional[str]:
    if not ref.footprint_sqft:
        return None
    cap = ref.footprint_sqft * f["research_footprint_slack"]
    return None if float(value) <= cap else f"typical floor {value:,} sqft > footprint x slack {cap:,.0f}"


CROSS_CHECKS = {"osm_levels_within_2": _osm_levels_within_2, "area_vs_footprint": _area_vs_footprint,
                "typical_floor_le_footprint": _typical_floor_le_footprint}


# ---------------------------------------------------------------- the verifier
def verify_fact(fact: ResearchedFact, spec: Optional[dict], building: Optional[BuildingRef], f: dict, *,
                county_fips: str, scope: Union[str, list[str], None] = None, year: Optional[int] = None) -> Verdict:
    """Accept or reject one fact. `building` is the merged building for building/parcel facts; `scope` the market
    or place scope for factor facts, or a list of its aliases (any one named near the quote passes). One of the two
    is required for the identity check."""
    year = year or date.today().year
    d = fact.model_dump()

    def rej(check: str, detail: str) -> Rejected:
        return Rejected(field=fact.field, check=check, detail=detail, fact=d)

    if spec is None:
        return rej("unknown_field", f"{fact.field} is not in backend/research/fields.yaml")
    # 1. allowed source, fetched through the cache
    if registry.denied(fact.source_url, county_fips):
        return rej("denylisted", f"{registry.domain(fact.source_url)} is on the denylist")
    if fact.field in registry.blocked_fields(county_fips):
        return rej("policy_blocked", f"{fact.field} is blocked by a state or county policy here")
    page = pages.cached_page(fact.source_url)
    if page is None:
        return rej("not_fetched", "the page is not in the HTTP cache (fetch it with fetch_page)")
    # 2. quote present
    if not QUOTE_LEN[0] <= len(fact.quote.strip()) <= QUOTE_LEN[1]:
        return rej("quote_length", f"quote is {len(fact.quote.strip())} chars; must be {QUOTE_LEN[0]}-{QUOTE_LEN[1]}")
    if fact.page is not None and page.kind == "pdf":
        if not 1 <= fact.page <= len(page.pages):
            return rej("quote_missing", f"page {fact.page} not in a {len(page.pages)}-page PDF")
        text = pages.normalize(page.pages[fact.page - 1])
    else:
        text = pages.normalize(page.full)
    nq = pages.normalize(fact.quote)
    at = text.find(nq)
    if at < 0:
        return rej("quote_missing", "the quote is not on the cached page" + (f" {fact.page}" if fact.page else ""))
    # 3. value comes from the quote
    value, why = parse_value(spec, fact.quote, fact.value)
    if value is None:
        return rej("unparseable", why)
    if not _equal(spec, value, fact.value, f["research_value_tolerance_rel"]):
        return rej("value_mismatch", f"quote parses to {value!r}, claimed {fact.value!r}")
    # 4. range
    rng = spec.get("range")
    if rng and not rng[0] <= float(value) <= rng[1]:
        return rej("out_of_range", f"{value} outside {rng[0]}-{rng[1]}")
    # 5. fresh
    asy = as_of_year(fact.as_of)
    if spec.get("max_age_years") is not None and asy is not None and year - asy > spec["max_age_years"]:
        return rej("stale", f"as of {asy}: older than {spec['max_age_years']} years")
    # 6. identity: the page names this building (or the market scope) near the quote; checked before the
    #    cross-checks so a number about another building reports as a wrong building, not a bad value
    w = f["research_identity_window_chars"]
    window = text[max(0, at - w):at + len(nq) + w]
    if scope is not None:
        aliases = [scope] if isinstance(scope, str) else list(scope)
        if not any(_scope_mentioned(window, s) for s in aliases):
            return rej("identity", f"none of {aliases} named within {w} chars of the quote")
    elif building is None or not _mentions(window, building):
        return rej("identity", f"neither the address nor the name of {building.building_id if building else '?'} "
                               f"appears within {w} chars of the quote")
    # 7. cross-checks against the merged building
    for name in spec.get("cross_checks") or []:
        if building is not None and (msg := CROSS_CHECKS[name](value, building, f)):
            return rej(name, msg)
    # confidence and provenance
    table = spec.get("confidence_by_source_type") or {}
    conf = table.get(fact.source_type or "", "low")
    if CONF_ORDER[conf] > CONF_ORDER[MAX_CONFIDENCE]:
        conf = MAX_CONFIDENCE
    if spec.get("max_age_years") is not None and asy is None:
        conf = "low"
    note = (f"\"{fact.quote.strip()}\" ({fact.source_type or 'unknown source type'}, as of {fact.as_of or 'unknown'}"
            f"{f', p.{fact.page}' if fact.page else ''}; agent-found, code-verified)")
    return Accepted(field=fact.field, value=value, source_url=fact.source_url, quote=fact.quote.strip(),
                    confidence=conf, note=note, retrieved_at=pages.http_cache.retrieved_at(fact.source_url),
                    source_type=fact.source_type, as_of=fact.as_of, page=fact.page)
