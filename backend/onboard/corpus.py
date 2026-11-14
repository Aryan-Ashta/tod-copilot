"""Agent 4: legal corpus builder. Proposes official legal documents (verbatim sections), structured rules with
citations and legal path kinds for one state, city or county. Code drops every item it cannot verify against the
fetched official pages; what survives is written to backend/corpus/agent/<jurisdiction>/, which the loader uses in
plans with status agent_verified until a person approves it (scripts/review_corpus.py, AGENTS.md ground rule 3)."""
import re
import shutil
from collections import Counter
from datetime import date
from typing import Any, Optional

import yaml

from backend.corpus.loader import (ATTRS, OPS, RULE_KINDS, USES, agent_dir, clear_cache, load_index,
                                   rules_file)
from backend.onboard import registry
from backend.onboard.arcgis import arcgis_query
from backend.onboard.common import check_tool, forget, run_agent
from backend.onboard.zoning import official
from backend.research import pages
from backend.research.registry import domain

SECTION_LEN = (40, 8000)
MAX_SEARCHES, MAX_FETCHES = 10, 20
BOOL_RULES = {"eligible", "discretionary"}
NUMBER_RULES = {"max_height_ft", "max_units_per_acre", "max_far", "parking_min_per_unit", "approval_steps", "stop_tier"}
MIN_RULE_KINDS = {"eligible", "allows_uses", "approval_steps"}   # every path needs these (test_corpus enforces too)
MAX_ZONING_CODES = 40
RECURSION_LIMIT = 400   # 30 web calls plus grep/read_file rounds over long legal pages
TOPICS = ("residential use in commercial and office zones", "office-to-residential conversion and adaptive reuse",
          "housing near transit / transit-oriented development", "density bonus",
          "parking minimums near transit", "height, FAR and density limits of the main commercial and mixed-use zones",
          "by-right vs discretionary approval")


def resolve_target(target: str) -> tuple[str, str, str]:
    """'state:08' | 'place:0820000' | 'county:08031' -> (jurisdiction id, display name, county or state FIPS)."""
    kind, _, gid = target.partition(":")
    if kind == "state":
        s = registry.state(gid)
        return s["jurisdiction"], s["name"], gid
    if kind == "place":
        p = registry.place(gid)
        if not p:
            raise ValueError(f"place {gid} is not in backend/registry/places; onboard its county first")
        return registry.place_jurisdiction(p), f"City of {p['basename']}, {registry.state(p['state'])['name']}", \
            p.get("county") or gid[:2]
    if kind == "county":
        c = registry.county(gid)
        if not c:
            raise ValueError(f"county {gid} is not in backend/registry/counties; onboard it first")
        return registry.county_jurisdiction(c), f"{c['name']}, {registry.state(gid[:2])['name']}", gid
    raise ValueError("target must be state:<fips2>, place:<geoid7> or county:<fips5>")


def _zoning_layers(target: str) -> list[dict]:
    """Zoning layers of a place/county target's registry entry, when that section passed its checks."""
    kind, _, gid = target.partition(":")
    data = registry.place(gid) if kind == "place" else registry.county(gid) if kind == "county" else None
    z = (data or {}).get("zoning") or {}
    if registry.section_status(z) not in ("reviewed", "agent_verified"):
        return []
    return z.get("layers") or []


def official_hosts(target: str) -> set[str]:
    """Hosts of the target's own registry zoning layers: its government publishes its code there too."""
    return {domain(lyr["url"]) for lyr in _zoning_layers(target)}


def zoning_codes(target: str, bbox) -> list[tuple[str, int]]:
    """(zoning_code, polygon count) in the bbox, most common first, spelled as parcels get them (record.zoning_layers:
    layer prefix + stripped value). [] for states, targets without zoning layers, and failed queries."""
    if bbox is None:
        return []
    counts: Counter = Counter()
    for lyr in _zoning_layers(target):
        try:
            feats = arcgis_query(lyr["url"], bbox, out_fields=lyr["field"], geometry=False, max_features=2000,
                                 order_by=lyr.get("oid_field", "OBJECTID"))
        except Exception:   # a GIS outage only costs the hint; the builder still runs
            return []
        for f in feats:
            v = str((f.get("properties") or {}).get(lyr["field"]) or "").strip()
            if v:
                counts[f"{lyr.get('prefix') or ''}{v}"] += 1
    return counts.most_common(MAX_ZONING_CODES)


def number_in_quote(n: float, quote: str) -> bool:
    if float(n).is_integer():
        digits = str(int(n))
        body = re.sub(r"(?<=\d)(?=(\d{3})+$)", ",?", digits)   # 1500 -> 1,?500
    else:
        body = re.escape(repr(float(n)).rstrip("0"))
    return bool(re.search(rf"(?<![\d.]){body}(?!\d)", quote))


def _value_ok(rule: str, value: Any) -> bool:
    if value == "TODO":
        return True
    if rule in BOOL_RULES:
        return isinstance(value, bool)
    if rule == "allows_uses":
        return isinstance(value, list) and set(value) <= USES
    if rule in NUMBER_RULES:
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, str)   # note


def page_texts(page) -> tuple[str, ...]:
    """Normalized texts a section may be copied from: the whole page and, for PDFs, the page without its running
    headers and footers (lines repeated, digits aside, on at least half the pages, e.g. "PAGE 28-HOUSE BILL 24-1313"),
    which otherwise break every section that crosses a page end."""
    out = [pages.normalize(page.full)]
    if page.kind == "pdf" and len(page.pages) >= 3:
        def key(line: str) -> str:
            return re.sub(r"\d+", "#", pages.normalize(line))
        counts = Counter(k for p in page.pages for k in {key(ln) for ln in p.splitlines()} if len(k) >= 8)
        running = {k for k, n in counts.items() if n >= len(page.pages) / 2}
        if running:
            out.append(pages.normalize("\n".join(ln for p in page.pages for ln in p.splitlines()
                                                 if key(ln) not in running)))
    return tuple(out)


def verify(proposal, jurisdiction: str, extra_hosts: set[str] | frozenset[str] = frozenset()) -> dict:
    """{docs: [...], rules: [...], paths: {name: {kind}}, rejected: [(item, reason)], not_covered: [...]}.
    `extra_hosts` are also official (the jurisdiction's registry zoning-layer hosts, official_hosts)."""
    taken = {d["doc_id"] for d in load_index()
             if not (d["status"] == "agent_verified" and d["jurisdiction"] == jurisdiction)}   # rebuilds reuse ids
    rejected, docs = [], {}
    for d in proposal.documents:
        if not re.fullmatch(r"[a-z0-9_]+", d.doc_id) or d.doc_id in taken or d.doc_id in docs:
            rejected.append((f"document {d.doc_id}", "doc_id must be new and match [a-z0-9_]+"))
            continue
        if not d.url.startswith("https://") or not official(d.url, extra_hosts):
            rejected.append((f"document {d.doc_id}", f"{domain(d.url)} is not an allowed official https host"))
            continue
        page = pages.cached_page(d.url)
        if page is None:
            rejected.append((f"document {d.doc_id}", "page was not fetched"))
            continue
        sources = page_texts(page)
        sections = []
        for s in d.sections:
            text = s.text.strip()   # s.page is only a hint for the agent; check the whole document
            if not SECTION_LEN[0] <= len(text) <= SECTION_LEN[1]:
                rejected.append((f"{d.doc_id} / {s.heading}", f"section is {len(text)} chars; must be 40-8000"))
            elif "\n## " in f"\n{text}" or not s.heading.strip():
                rejected.append((f"{d.doc_id} / {s.heading}", "section text holds a '## ' heading line"))
            elif not any(pages.normalize(text) in src for src in sources):
                rejected.append((f"{d.doc_id} / {s.heading}", "section text is not verbatim on the fetched page"))
            else:
                sections.append({"heading": s.heading.strip(), "text": text})
        if sections:
            docs[d.doc_id] = {"doc_id": d.doc_id, "title": d.title, "jurisdiction": jurisdiction,
                              "path_name": d.path_name, "url": d.url, "retrieved_at": date.today().isoformat(),
                              "sections": sections}
        else:
            rejected.append((f"document {d.doc_id}", "no verified section"))
    path_names = {p.name for p in proposal.paths}
    rules = []
    for r in proposal.rules:
        label = f"rule {r.path} / {r.rule}"
        sec = next((s for s in docs.get(r.cite.doc_id, {}).get("sections", []) if s["heading"] == r.cite.section), None)
        why = None
        if r.rule not in RULE_KINDS:
            why = f"rule kind must be one of {sorted(RULE_KINDS)}"
        elif not set(r.applies_if) <= ATTRS or not all(isinstance(c, dict) and set(c) <= OPS
                                                       for c in r.applies_if.values()):
            why = f"applies_if attributes must be in {sorted(ATTRS)} with ops {sorted(OPS)}"
        elif r.path not in path_names:
            why = "path is not in paths"
        elif r.cite.doc_id not in docs:
            why = "cited document was not accepted"
        elif sec is None:
            why = "cited section is not a heading of the document"
        elif not r.cite.quote.strip() or r.cite.quote not in sec["text"]:
            why = "quote is not verbatim in the cited section"
        elif not _value_ok(r.rule, r.value):
            why = f"value {r.value!r} has the wrong type for {r.rule}"
        elif isinstance(r.value, (int, float)) and not isinstance(r.value, bool) and \
                not number_in_quote(r.value, r.cite.quote):
            why = f"{r.value} does not appear in the quote"
        if why:
            rejected.append((label, why))
        else:
            rules.append({"path": r.path, "rule": r.rule, "applies_if": r.applies_if, "value": r.value,
                          "cite": {"doc_id": r.cite.doc_id, "section": r.cite.section, "quote": r.cite.quote}})
    kinds: dict[str, set[str]] = {}
    for r in rules:
        kinds.setdefault(r["path"], set()).add(r["rule"])
    short = {p for p, k in kinds.items() if not MIN_RULE_KINDS <= k}
    rules = [r for r in rules if r["path"] not in short]
    used = {r["path"] for r in rules}
    paths = {p.name: {"kind": p.kind} for p in proposal.paths if p.name in used}
    rejected += [(f"path {p.name}", "path lacks eligible/allows_uses/approval_steps rules" if p.name in short
                  else "no accepted rule") for p in proposal.paths if p.name not in used]
    return {"docs": list(docs.values()), "rules": rules, "paths": paths, "rejected": rejected,
            "not_covered": list(proposal.not_covered)}


def write_agent_corpus(jurisdiction: str, name: str, v: dict) -> None:
    """Replace backend/corpus/agent/<jurisdiction>/ with a verified proposal. rules.yaml only when a rule passed, so
    a run with no accepted rule never makes the loader report rules for the jurisdiction."""
    d = agent_dir() / jurisdiction
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    index = [{k: doc[k] for k in ("doc_id", "title", "jurisdiction", "path_name", "url", "retrieved_at")}
             for doc in v["docs"]]
    (d / "index.yaml").write_text(yaml.safe_dump(index, sort_keys=False, allow_unicode=True, width=120))
    for doc in v["docs"]:
        body = [f"# {doc['title']}", "", f"Source: {doc['url']}", f"Retrieved: {doc['retrieved_at']}", ""]
        for s in doc["sections"]:
            body += [f"## {s['heading']}", "", s["text"], ""]
        (d / f"{doc['doc_id']}.md").write_text("\n".join(body))
    if v["rules"]:
        (d / "rules.yaml").write_text(f"# Structured rules for {name} (agent-built, code-checked, not reviewed).\n"
                                      + yaml.safe_dump(v["rules"], sort_keys=False, allow_unicode=True, width=120))
    (d / "paths.yaml").write_text(yaml.safe_dump(v["paths"], sort_keys=False, allow_unicode=True))
    lines = [f"# Agent-built legal corpus: {name} ({jurisdiction})", "",
             "Agent-built, code-checked (official host, verbatim sections, verbatim quotes, numbers in quotes). "
             "Used in plans now, labeled agent-verified. A person reviews every rule against its quote and approves "
             f"with `uv run python scripts/review_corpus.py {jurisdiction} --approve`.", "",
             f"## Accepted rules ({len(v['rules'])})", ""]
    for r in v["rules"]:
        lines += [f"- **{r['path']}** `{r['rule']}` = `{r['value']}`"
                  + (f" if `{r['applies_if']}`" if r["applies_if"] else ""),
                  f"  - {r['cite']['doc_id']} / {r['cite']['section']}: “{r['cite']['quote']}”"]
    lines += ["", f"## Documents ({len(v['docs'])})", ""]
    lines += [f"- {doc['doc_id']}: {doc['title']} ({doc['url']}), {len(doc['sections'])} sections" for doc in v["docs"]]
    lines += ["", f"## Rejected by the code checks ({len(v['rejected'])})", ""]
    lines += [f"- {item}: {why}" for item, why in v["rejected"]]
    lines += ["", "## Not covered", ""] + [f"- {t}" for t in v["not_covered"]]
    (d / "review.md").write_text("\n".join(lines) + "\n")
    clear_cache()


def corpus_section(target: str) -> Optional[dict]:
    """Onboarding status of a target's corpus: reviewed (curated rules file), agent_verified (the builder ran, whatever
    it accepted), or None (never built, or the target cannot be resolved yet)."""
    try:
        j = resolve_target(target)[0]
    except ValueError:
        return None
    if rules_file(j).exists():
        return {"status": "reviewed"}
    if (agent_dir() / j / "review.md").exists():
        return {"status": "agent_verified"}
    return None


def forget_corpus(target: str) -> None:
    """Drop a target's agent-built corpus and the builder's checkpoint so the next build starts afresh."""
    j = resolve_target(target)[0]
    shutil.rmtree(agent_dir() / j, ignore_errors=True)
    forget("corpus_builder", f"corpus-{j}")
    clear_cache()


def build(target: str, *, bbox=None, model=None, search=None) -> dict:
    """Run the corpus builder for a target and write what passes to the agent corpus. `bbox` (the planned area) lists
    its zoning codes to the agent so rules key on them. Returns the verification summary."""
    from backend.schemas import CorpusProposal
    jurisdiction, name, fips = resolve_target(target)
    county_fips = fips if len(fips) == 5 else next((f for f in registry.county_fips_list() if f[:2] == fips),
                                                   f"{fips}000")
    key = f"corpus-{jurisdiction}"
    hosts = official_hosts(target)

    def dry(p: dict) -> list[str]:
        v = verify(CorpusProposal.model_validate(p), jurisdiction, hosts)
        return [f"{item}: {why}" for item, why in v["rejected"]] + [f"accepted {len(v['rules'])} rules"]
    check = check_tool("check_corpus", "Dry-run the code checks on a candidate CorpusProposal. Saves nothing; lists "
                       "every item that would be dropped and why.", dry)
    msg = (f"Jurisdiction: {name} (id {jurisdiction})\nFind official text on:\n" + "\n".join(f"- {t}" for t in TOPICS)
           + f"\nRule kinds: {sorted(RULE_KINDS)}\nUses for allows_uses: {sorted(USES)}\n"
           f"applies_if attributes: {sorted(ATTRS)}; ops: {sorted(OPS)}")
    if hosts:
        msg += f"\nAlso official for this jurisdiction: {', '.join(sorted(hosts))}"
    if codes := zoning_codes(target, bbox):
        msg += ("\nZoning codes in the planned area (zoning layer values with polygon counts). Key zoning_code rules "
                "to these exact strings: " + ", ".join(f"{c} ({n})" for c, n in codes))
    res = run_agent("corpus_builder", key, county_fips, [check], CorpusProposal, msg, model=model, search=search,
                    max_searches=MAX_SEARCHES, max_fetches=MAX_FETCHES, recursion_limit=RECURSION_LIMIT)
    if res is None:
        raise RuntimeError("the corpus builder gave no structured answer")
    v = verify(res, jurisdiction, hosts)
    write_agent_corpus(jurisdiction, name, v)
    return {"jurisdiction": jurisdiction, "documents": len(v["docs"]), "rules": len(v["rules"]),
            "paths": list(v["paths"]), "rejected": len(v["rejected"]),
            "written": str(agent_dir() / jurisdiction)}
