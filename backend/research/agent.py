"""Agent research pipeline (docs/12 §3, §8): gap queue -> deepagents researchers -> code verifier -> fixtures.

Runs only while recording (`record_fixtures.py --only agent_research`, or a drawn area with AREA_RESEARCH=1), never
at plan time. The queue (models/research.py) decides what to research, so the Python driver below plays the
coordinator: it hands each job to its own building-researcher deep agent (isolated context, one LangGraph thread
per job) instead of paying an LLM to dispatch a list it cannot change. Results are cached per job id under
cache/research/<locale>/results/ and agent state is checkpointed to SQLite, so a crash or re-run never pays twice.

Nothing an LLM writes becomes a value: `verify.verify_fact` re-derives every number from a quote found on the
cached page."""
import json
import threading
from collections import Counter
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Callable, Optional

import yaml

from backend import settings
from backend.data.factors import resolve
from backend.data.locales import locale_dir
from backend.research import harness, registry
from backend.research.context import PlanContext
from backend.research.tools import SearchProvider, make_tools, search_provider
from backend.research.verify import Accepted, BuildingRef, Rejected, verify_fact
from backend.schemas import (Locale, ResearchedBuilding, ResearchedFact, ResearchedMarket, ResearchJob)

FOLDER = "agent_research"
# Facts that later cross-checks read are verified first (rentable area is checked against stories).
VERIFY_ORDER = ("stories", "typical_floor_sqft", "rentable_area_sqft")


@dataclass
class JobOutcome:
    job: ResearchJob
    result: Optional[ResearchedBuilding]
    accepted: list[Accepted] = field(default_factory=list)
    rejected: list[Rejected] = field(default_factory=list)
    tokens: dict = field(default_factory=dict)
    error: Optional[str] = None
    cached: bool = False


@dataclass
class Report:
    locale_id: str
    jobs: int = 0
    run: int = 0
    cached: int = 0
    proposed: int = 0
    accepted: int = 0
    rejects: Counter = field(default_factory=Counter)
    tokens: Counter = field(default_factory=Counter)
    errors: list[str] = field(default_factory=list)
    outcomes: list[JobOutcome] = field(default_factory=list)

    def text(self) -> str:
        rj = ", ".join(f"{k} {n}" for k, n in self.rejects.most_common()) or "none"
        return (f"agent_research {self.locale_id}: {self.jobs} jobs ({self.run} run, {self.cached} cached); "
                f"{self.proposed} facts proposed, {self.accepted} accepted; rejects by check: {rj}; tokens in "
                f"{self.tokens['input_tokens']:,} / out {self.tokens['output_tokens']:,}"
                + (f"; {len(self.errors)} job errors" if self.errors else ""))


def work_dir(locale_id: str) -> Path:
    return settings.CACHE_DIR / "research" / locale_id


# ---------------------------------------------------------------- verification of one job
def _merge_ref(ref: BuildingRef, a: Accepted) -> None:
    if a.field in ("stories", "rentable_area_sqft", "typical_floor_sqft"):
        setattr(ref, a.field, a.value)


def verify_job(result: ResearchedBuilding, job: ResearchJob, ref: Optional[BuildingRef], f: dict,
               county_fips: str, known: Optional[dict[str, str]] = None) -> tuple[list[Accepted], list[Rejected]]:
    """Verify every fact of one researched building. Facts about any other building id are rejected outright, and
    so are facts for fields another source already has (`known`: field -> "value (source)"): agent research only
    fills gaps, so it never contradicts CoStar, hand research, the county or OSM. Each such clash is logged."""
    known = known or {}
    facts = list(result.facts) + [x.model_copy(update={"field": k}) for k, x in
                                  (("name", result.name), ("address", result.address)) if x is not None]
    if result.building_id != job.building_id:
        return [], [Rejected(field=x.field, check="wrong_building", detail=f"answer is for {result.building_id}, "
                             f"job is {job.building_id}", fact=x.model_dump()) for x in facts]
    if ref is None:
        return [], [Rejected(field=x.field, check="identity", detail="building not in this locale's plan",
                             fact=x.model_dump()) for x in facts]
    ref = BuildingRef(**vars(ref))
    facts.sort(key=lambda x: VERIFY_ORDER.index(x.field) if x.field in VERIFY_ORDER else len(VERIFY_ORDER))
    accepted: list[Accepted] = []
    rejected: list[Rejected] = []
    seen: set[str] = set()
    for x in facts:
        if x.field in known:
            rejected.append(Rejected(field=x.field, check="already_known", detail=f"{known[x.field]} already; "
                                     f"agent research only fills gaps (claimed {x.value!r})", fact=x.model_dump()))
            continue
        if x.field in seen:
            rejected.append(Rejected(field=x.field, check="duplicate", detail="a fact for this field was already "
                                     "accepted", fact=x.model_dump()))
            continue
        v = verify_fact(x, registry.spec_for(x.field), ref, f, county_fips=county_fips)
        if isinstance(v, Accepted):
            accepted.append(v)
            seen.add(x.field)
            _merge_ref(ref, v)
        else:
            rejected.append(v)
    return accepted, rejected


def _city(loc: Locale, address: Optional[str]) -> str:
    if address and "," in address:
        return address.split(",")[1].strip().title()
    return loc.jurisdiction.replace("_", " ").title()


def job_message(job: ResearchJob, loc: Locale, known: Optional[dict[str, str]] = None) -> str:
    src = registry.sources_for(loc.county_fips)
    specs = registry.field_specs()
    city = _city(loc, job.address)
    queries = []
    for t in src["search_query_templates"]["building"]:
        if ("{address}" in t and not job.address) or ("{name}" in t and job.label == job.address):
            continue
        queries.append(t.format(address=(job.address or "").split(",")[0].title(), name=job.label, city=city))
    fields = ", ".join(f"{k} ({specs[k].get('unit') or specs[k]['parse']})" for k in job.fields)
    lines = [f"Job id: {job.job_id}", f"Building id: {job.building_id}", f"Label: {job.label}",
             f"Address: {job.address or 'unknown'}", f"City: {city} ({loc.name})",
             f"Location (lon, lat): {job.lonlat[0]}, {job.lonlat[1]}", f"Fields to research, best first: {fields}",
             "Suggested searches: " + "; ".join(queries), f"Today: {date.today().isoformat()}"]
    if known:
        lines.append("Already known from other sources (do not submit these; they are rejected): "
                     + "; ".join(f"{k} = {v}" for k, v in known.items()))
    unknown = [k for k in ("name", "address") if k not in (known or {})]
    if unknown:
        lines.append(f"Unknown, answer if a fetched page states it: {', '.join(unknown)}")
    if src.get("preferred_domains"):
        lines.append("Preferred sources: " + ", ".join(src["preferred_domains"]))
    if src.get("notes"):
        lines.append(f"Notes: {src['notes']}")
    return "\n".join(lines)


def _check_fn(job: ResearchJob, ref: Optional[BuildingRef], f: dict, county: str, known: dict[str, str]) -> Callable:
    def check(facts: list[ResearchedFact]) -> list[str]:
        facts = [x if isinstance(x, ResearchedFact) else ResearchedFact(**x) for x in facts]
        acc, rej = verify_job(ResearchedBuilding(job_id=job.job_id, building_id=job.building_id, facts=facts,
                                                 not_found=[]), job, ref, f, county, known)
        return ([f"accepted: {a.field} = {a.value!r} ({a.confidence})" for a in acc]
                + [f"rejected ({r.check}): {r.field}: {r.detail}" for r in rej])
    return check


# ---------------------------------------------------------------- output files
def _source_entry(job: ResearchJob, accepted: list[Accepted]) -> dict:
    specs = {**registry.field_specs(), **registry.identity_specs()}
    fields = {a.field: a.record() for a in accepted if specs[a.field]["target"] == "building"}
    pfields = {a.field: a.record() for a in accepted if specs[a.field]["target"] == "parcel"}
    e: dict = {"label": job.label, "building_id": job.building_id, "parcel_id": job.parcel_id,
               "lonlat": list(job.lonlat), "job": {"id": job.job_id, "swing": job.swing, "fields": job.fields},
               "fields": fields}
    if pfields and job.parcel_id:
        e["parcel_fields"] = pfields
    return e


def write_outputs(locale_id: str, outcomes: list[JobOutcome]) -> Optional[dict]:
    """agent_research/buildings_source.yaml (the reviewable artifact) + rejects.jsonl + linked JSON."""
    from backend.data import record
    from backend.data.providers import _base
    d = locale_dir(locale_id) / FOLDER
    d.mkdir(parents=True, exist_ok=True)
    entries = [_source_entry(o.job, o.accepted) for o in outcomes if o.accepted]
    header = ("# Agent research (docs/12): facts found by deepagents researchers and verified in code (quote on the\n"
              "# cached page, value parsed from the quote, range, freshness, cross-checks, identity). Generated by\n"
              "# `record_fixtures.py --only agent_research`; a person reviews this diff before it is committed.\n"
              "# Rejected facts and the failed check: rejects.jsonl next to this file.\n")
    (d / "buildings_source.yaml").write_text(header + yaml.safe_dump(entries, sort_keys=False, allow_unicode=True,
                                                                     width=120))
    with (d / "rejects.jsonl").open("w") as fh:
        for o in outcomes:
            for r in o.rejected:
                fh.write(json.dumps({"job_id": o.job.job_id, "building_id": o.job.building_id, "label": o.job.label,
                                     **r.as_dict()}) + "\n")
            if o.error:
                fh.write(json.dumps({"job_id": o.job.job_id, "building_id": o.job.building_id, "label": o.job.label,
                                     "field": None, "check": "job_error", "detail": o.error, "fact": {}}) + "\n")
    n = record.link_research(locale_id, FOLDER, "agent_research",
                             "agent-found, code-verified public facts (docs/12); each field carries its quote, "
                             "confidence and retrieval time")
    _base.load_json.cache_clear()   # providers read the new JSON in this process (drawn-area re-plan)
    _base.meta.cache_clear()
    return n


# ---------------------------------------------------------------- driver
def run_locale(locale_id: str, *, model: Any = None, search: Optional[SearchProvider] = None,
               max_jobs: Optional[int] = None, workers: int = 4,
               on_fact: Optional[Callable[[ResearchJob, Accepted], None]] = None, quiet: bool = False) -> Report:
    """Research one recorded locale or drawn area and write <locale_dir>/agent_research/. Resumable."""
    pc = PlanContext(locale_id)
    loc, f = pc.locale, pc.f
    if model is None:   # real runs: find the county's property-card host once (agent 7), so jobs can prefer it
        from backend.onboard.assessor import ensure_if_missing
        ensure_if_missing(loc.county_fips)
    jobs = pc.queue()[:max_jobs] if max_jobs else pc.queue()
    model = model if model is not None else settings.RESEARCH_MODEL
    search = search or search_provider()
    wd = work_dir(locale_id)
    results = wd / "results"
    results.mkdir(parents=True, exist_ok=True)
    report = Report(locale_id=locale_id, jobs=len(jobs))
    say = (lambda s: None) if quiet else print
    say(f"agent_research {locale_id}: {len(jobs)} jobs from the gap queue")
    lock = threading.Lock()
    cp = harness.checkpointer(wd / "checkpoints.sqlite")

    def one(job: ResearchJob) -> JobOutcome:
        ref = pc.ref(job.building_id)
        known = pc.known(job)
        path = results / f"{job.job_id}.json"
        if path.exists():
            saved = json.loads(path.read_text())
            res = ResearchedBuilding.model_validate(saved["result"]) if saved.get("result") else None
            o = JobOutcome(job, res, tokens=saved.get("tokens") or {}, error=saved.get("error"), cached=True)
        else:
            tools = make_tools(loc.county_fips, wd, search, _check_fn(job, ref, f, loc.county_fips, known))
            try:
                agent = harness.build_agent(model, tools, registry.PROMPTS_DIR / "building_researcher.md",
                                            ResearchedBuilding, wd, cp)
                res, tokens = harness.invoke(agent, job_message(job, loc, known), job.job_id)
                res = res if isinstance(res, ResearchedBuilding) or res is None else ResearchedBuilding.model_validate(res)
                o = JobOutcome(job, res, tokens=tokens, error=None if res else "no structured response")
            except Exception as e:   # one failed job must not sink the run; it is retried, from scratch, next run
                cp.delete_thread(job.job_id)   # a crash (process killed) still resumes from its checkpoint
                return JobOutcome(job, None, error=f"{type(e).__name__}: {e}"[:300])
            path.write_text(json.dumps({"job": job.model_dump(), "result": res.model_dump() if res else None,
                                        "tokens": o.tokens, "error": o.error, "model": str(model)}, indent=1))
        if o.result is not None:
            o.accepted, o.rejected = verify_job(o.result, job, ref, f, loc.county_fips, known)
        with lock:
            say(f"  {job.label}: {len(o.accepted)} accepted, {len(o.rejected)} rejected"
                + (" (cached)" if o.cached else "") + (f" ERROR {o.error}" if o.error else ""))
            for a in o.accepted:
                if on_fact is not None:
                    on_fact(job, a)
        return o

    if workers > 1 and len(jobs) > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as pool:
            outcomes = list(pool.map(one, jobs))
    else:
        outcomes = [one(j) for j in jobs]
    write_outputs(locale_id, outcomes)
    for o in outcomes:
        report.outcomes.append(o)
        report.cached += o.cached
        report.run += not o.cached and o.error is None
        report.proposed += len(o.accepted) + len(o.rejected)
        report.accepted += len(o.accepted)
        report.rejects.update(r.check for r in o.rejected)
        report.tokens.update(o.tokens)
        if o.error:
            report.errors.append(f"{o.job.label}: {o.error}")
    if hasattr(search, "usage"):
        report.tokens.update({k: v for k, v in search.usage.items() if k.endswith("tokens")})
    say(report.text())
    return report


# ---------------------------------------------------------------- factor researchers (market, local factors)
def run_factor_research(scope_name: str, aliases: list[str], specs: dict[str, dict], county_fips: str, wd: Path, *,
                        f: dict, prompt: Path, suggested: list[str], thread_id: str, model: Any = None,
                        search: Optional[SearchProvider] = None) -> list[Accepted | Rejected]:
    """One factor-researcher run for one scope (a submarket, state or county): the agent proposes values for
    `specs`' keys; every value is re-derived by the code verifier from a quote on a fetched page naming one of
    `aliases`. Cached under wd/results/<thread_id>.json; returns every verdict."""
    model = model if model is not None else settings.RESEARCH_MODEL
    search = search or search_provider()

    def verify(fs: list[ResearchedFact]) -> list[Accepted | Rejected]:
        return [verify_fact(x, specs.get(x.field), None, f, county_fips=county_fips, scope=aliases) for x in fs]

    def check(fs) -> list[str]:
        fs = [x if isinstance(x, ResearchedFact) else ResearchedFact(**x) for x in fs]
        return [f"accepted: {v.field} = {v.value!r}" if isinstance(v, Accepted) else
                f"rejected ({v.check}): {v.field}: {v.detail}" for v in verify(fs)]

    path = wd / "results" / f"{thread_id}.json"
    if path.exists():
        res = ResearchedMarket.model_validate(json.loads(path.read_text())["result"])
    else:
        agent = harness.build_agent(model, make_tools(county_fips, wd, search, check), prompt, ResearchedMarket, wd,
                                    harness.checkpointer(wd / "checkpoints.sqlite"))
        msg = (f"Scope: {scope_name}\nFactor keys: " + ", ".join(f"{k} ({v['unit']})" for k, v in specs.items())
               + f"\nCurrent year: {date.today().year}\nSuggested searches: " + "; ".join(suggested))
        res, tokens = harness.invoke(agent, msg, thread_id)
        res = res if isinstance(res, ResearchedMarket) else ResearchedMarket.model_validate(res)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"result": res.model_dump(), "tokens": tokens}, indent=1))
    for rf in res.factors:
        rf.fact.field = rf.factor_key
    return verify([rf.fact for rf in res.factors if rf.scope == scope_name])


def run_market(locale_id: str, *, model: Any = None, search: Optional[SearchProvider] = None,
               scope: Optional[str] = None, quiet: bool = False) -> list[Accepted]:
    """Submarket vacancy / asking rent for a locale -> <locale_dir>/agent_research/factor_proposals.yaml, every value
    `verified: false` for a person to check before it is copied into backend/data/factors.yaml (ground rule 2)."""
    from backend.data.locales import get_locale
    loc = get_locale(locale_id)
    raw = yaml.safe_load((locale_dir(locale_id) / "locale.yaml").read_text())
    scope = scope or raw.get("market_scope") or loc.name.split(":")[0].strip()
    specs = registry.market_specs()
    tmpl = registry.sources_for(loc.county_fips)["search_query_templates"]["market"]
    verdicts = run_factor_research(scope, [scope], specs, loc.county_fips, work_dir(locale_id), f=resolve(locale_id),
                                   prompt=registry.PROMPTS_DIR / "market_researcher.md",
                                   suggested=[t.format(submarket=scope, year=date.today().year) for t in tmpl],
                                   thread_id=f"market-{locale_id}", model=model, search=search)
    accepted = [v for v in verdicts if isinstance(v, Accepted)]
    d = locale_dir(locale_id) / FOLDER
    d.mkdir(parents=True, exist_ok=True)
    proposals = {a.field: {"label": a.field.replace("_", " "), "value": a.value, "unit": specs[a.field]["unit"],
                           "source_url": a.source_url, "verified": False, "scope": scope,
                           "note": f"agent-found market proposal for {scope}: {a.note}"} for a in accepted}
    (d / "factor_proposals.yaml").write_text(
        "# Market factor PROPOSALS (docs/12 §5.3): verified: false. A person checks each one before copying it into\n"
        "# backend/data/factors.yaml; nothing reads this file at plan time.\n"
        + yaml.safe_dump(proposals, sort_keys=False, allow_unicode=True, width=120))
    with (d / "market_rejects.jsonl").open("w") as fh:
        for v in verdicts:
            if isinstance(v, Rejected):
                fh.write(json.dumps(v.as_dict()) + "\n")
    if not quiet:
        print(f"agent_market {locale_id}: {len(accepted)}/{len(verdicts)} market facts accepted as proposals "
              f"({scope})")
    return accepted
