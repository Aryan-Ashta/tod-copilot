"""Agent 4: legal corpus builder. Proposes official legal documents (verbatim sections), structured rules with
citations and legal path kinds for one state, city or county. Code drops every item it cannot verify against the
fetched official pages; what survives is STAGED under backend/corpus/proposed/<jurisdiction>/ for a person to
review and approve (scripts/review_corpus.py). The loader never reads proposed/ (ground rule 3)."""
import re
from datetime import date
from typing import Any

import yaml

from backend.corpus.loader import ATTRS, OPS, RULE_KINDS, USES, load_index
from backend.onboard import registry
from backend.onboard.common import check_tool, run_agent
from backend.onboard.zoning import official
from backend.research import pages
from backend.research.registry import domain
from backend.settings import CORPUS_DIR

PROPOSED_DIR = CORPUS_DIR / "proposed"
SECTION_LEN = (40, 8000)
MAX_SEARCHES, MAX_FETCHES = 10, 20
BOOL_RULES = {"eligible", "discretionary"}
NUMBER_RULES = {"max_height_ft", "max_units_per_acre", "max_far", "parking_min_per_unit", "approval_steps", "stop_tier"}
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


def _staged_ids() -> set[str]:
    ids = set()
    for p in PROPOSED_DIR.glob("*/index.yaml"):
        ids |= {d["doc_id"] for d in yaml.safe_load(p.read_text()) or []}
    return ids


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


def verify(proposal, jurisdiction: str) -> dict:
    """{docs: [...], rules: [...], paths: {name: {kind}}, rejected: [(item, reason)], not_covered: [...]}."""
    taken = {d["doc_id"] for d in load_index()} | _staged_ids()
    rejected, docs = [], {}
    for d in proposal.documents:
        if not re.fullmatch(r"[a-z0-9_]+", d.doc_id) or d.doc_id in taken or d.doc_id in docs:
            rejected.append((f"document {d.doc_id}", "doc_id must be new and match [a-z0-9_]+"))
            continue
        if not d.url.startswith("https://") or not official(d.url):
            rejected.append((f"document {d.doc_id}", f"{domain(d.url)} is not an allowed official https host"))
            continue
        page = pages.cached_page(d.url)
        if page is None:
            rejected.append((f"document {d.doc_id}", "page was not fetched"))
            continue
        sections = []
        for s in d.sections:
            text = s.text.strip()
            src = page.pages[s.page - 1] if (s.page and page.kind == "pdf" and 1 <= s.page <= len(page.pages)) \
                else page.full
            if not SECTION_LEN[0] <= len(text) <= SECTION_LEN[1]:
                rejected.append((f"{d.doc_id} / {s.heading}", f"section is {len(text)} chars; must be 40-8000"))
            elif "\n## " in f"\n{text}" or not s.heading.strip():
                rejected.append((f"{d.doc_id} / {s.heading}", "section text holds a '## ' heading line"))
            elif pages.normalize(text) not in pages.normalize(src):
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
    used = {r["path"] for r in rules}
    paths = {p.name: {"kind": p.kind} for p in proposal.paths if p.name in used}
    rejected += [(f"path {p.name}", "no accepted rule") for p in proposal.paths if p.name not in used]
    return {"docs": list(docs.values()), "rules": rules, "paths": paths, "rejected": rejected,
            "not_covered": list(proposal.not_covered)}


def write_staging(jurisdiction: str, name: str, v: dict) -> None:
    d = PROPOSED_DIR / jurisdiction
    d.mkdir(parents=True, exist_ok=True)
    index = [{k: doc[k] for k in ("doc_id", "title", "jurisdiction", "path_name", "url", "retrieved_at")}
             for doc in v["docs"]]
    (d / "index.yaml").write_text(yaml.safe_dump(index, sort_keys=False, allow_unicode=True, width=120))
    for doc in v["docs"]:
        body = [f"# {doc['title']}", "", f"Source: {doc['url']}", f"Retrieved: {doc['retrieved_at']}", ""]
        for s in doc["sections"]:
            body += [f"## {s['heading']}", "", s["text"], ""]
        (d / f"{doc['doc_id']}.md").write_text("\n".join(body))
    (d / "rules.yaml").write_text(f"# Structured rules for {name} (agent-proposed; review before approving).\n"
                                  + yaml.safe_dump(v["rules"], sort_keys=False, allow_unicode=True, width=120))
    (d / "paths.yaml").write_text(yaml.safe_dump(v["paths"], sort_keys=False, allow_unicode=True))
    lines = [f"# Proposed legal corpus: {name} ({jurisdiction})", "",
             "Agent-proposed, code-checked (official host, verbatim sections, verbatim quotes, numbers in quotes). "
             "A person must read every rule against its quote before approving: "
             f"`uv run python scripts/review_corpus.py {jurisdiction} --approve`.", "",
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


def build(target: str, *, model=None, search=None) -> dict:
    """Run the corpus builder for a target and stage what passes. Returns the verification summary."""
    from backend.schemas import CorpusProposal
    jurisdiction, name, fips = resolve_target(target)
    county_fips = fips if len(fips) == 5 else next((f for f in registry.county_fips_list() if f[:2] == fips),
                                                   f"{fips}000")
    key = f"corpus-{jurisdiction}"

    def dry(p: dict) -> list[str]:
        v = verify(CorpusProposal.model_validate(p), jurisdiction)
        return [f"{item}: {why}" for item, why in v["rejected"]] + [f"accepted {len(v['rules'])} rules"]
    check = check_tool("check_corpus", "Dry-run the code checks on a candidate CorpusProposal. Saves nothing; lists "
                       "every item that would be dropped and why.", dry)
    msg = (f"Jurisdiction: {name} (id {jurisdiction})\nFind official text on:\n" + "\n".join(f"- {t}" for t in TOPICS)
           + f"\nRule kinds: {sorted(RULE_KINDS)}\nUses for allows_uses: {sorted(USES)}\n"
           f"applies_if attributes: {sorted(ATTRS)}; ops: {sorted(OPS)}")
    res = run_agent("corpus_builder", key, county_fips, [check], CorpusProposal, msg, model=model, search=search,
                    max_searches=MAX_SEARCHES, max_fetches=MAX_FETCHES, recursion_limit=RECURSION_LIMIT)
    if res is None:
        raise RuntimeError("the corpus builder gave no structured answer")
    v = verify(res, jurisdiction)
    write_staging(jurisdiction, name, v)
    return {"jurisdiction": jurisdiction, "documents": len(v["docs"]), "rules": len(v["rules"]),
            "paths": list(v["paths"]), "rejected": len(v["rejected"]),
            "staged": str(PROPOSED_DIR / jurisdiction)}
