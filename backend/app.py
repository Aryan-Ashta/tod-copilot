"""FastAPI app: plan runs with SSE progress, replay, rescore, and read-only data endpoints (docs/02)."""
import asyncio
import json
import re
from typing import Optional
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from shapely.geometry import box
from sse_starlette.sse import EventSourceResponse

from backend import settings, store
from backend.agents.coordinator import run_plan
from backend.agents.plan_options import parse_prompt, stock_prompts
from backend.corpus.loader import load_index, load_sections
from backend.data.areas import METRO_BACKGROUND_STEPS, AreaError, AreaResolution, record_area, resolve_area
from backend.data.factors import load_factors, resolve
from backend.data.http_cache import OfflineCacheMiss, cached_get
from backend.onboard import geo
from backend.data.locales import LOCALE_IDS, load_locales
from backend.models.rescore import rescore
from backend.models.transit import simulate_count
from backend.schemas import (AgentEvent, Edit, Factor, Locale, Plan, PlanOptions, RescoreResponse, SimulatedCount,
                             StockPrompt)

NOMINATIM = "https://nominatim.openstreetmap.org/search"

app = FastAPI(title="TOD Copilot")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"])


class PlanRequest(BaseModel):
    locale_id: Optional[str] = None
    boundary: Optional[dict] = None
    area_name: Optional[str] = None
    prompt: str
    options: Optional[PlanOptions] = None


class AreaCheckRequest(BaseModel):
    boundary: dict


class PromptRequest(BaseModel):
    prompt: str


class RescoreRequest(BaseModel):
    edits: list[Edit]


class CountRequest(BaseModel):
    stop_id: str


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/locales")
def locales() -> list[Locale]:
    return load_locales()


def _area(locale_id: Optional[str], boundary: Optional[dict]) -> AreaResolution:
    return resolve_area(locale_id, boundary, resolve(LOCALE_IDS[0])["area_max_km2"])


@app.post("/api/plan")
async def start_plan(req: PlanRequest) -> dict:
    try:
        area = _area(req.locale_id, req.boundary)
    except AreaError as e:
        raise HTTPException(422, str(e))
    if area.kind == "metro" and settings.OFFLINE:
        raise HTTPException(409, "areas outside the recorded boxes are recorded live and need the network; with "
                                 "DEMO_OFFLINE=1 draw inside a recorded box")
    hex8 = uuid4().hex[:8]
    plan_id = f"area-{hex8}-plan" if area.kind == "metro" else f"{area.locale_id}-{hex8}"
    options = req.options or parse_prompt(req.prompt)
    run = store.Run()
    store.runs[plan_id] = run
    loop = asyncio.get_running_loop()

    def notify(e: AgentEvent) -> None:
        run.events.append(e)
        if e.agent == "coordinator" and e.status in ("done", "error") and e.step != \
                "LLM coordinator unavailable; deterministic driver used" and not run.research_pending:
            run.finished = True
        run.changed.set()

    def emit(e: AgentEvent) -> None:
        loop.call_soon_threadsafe(notify, e)

    async def go() -> None:
        try:
            locale_id, boundary = area.locale_id, area.boundary
            if area.kind == "metro":
                def step(text: str) -> None:
                    emit(AgentEvent(agent="coordinator", status="running", step=text))
                locale_id = await asyncio.to_thread(record_area, req.area_name or "Drawn area", area, step)
                boundary = None   # the recorded area's locale already carries its boundary
                run.research_pending = "agent_research" in METRO_BACKGROUND_STEPS
            plan = await asyncio.to_thread(run_plan, locale_id, req.prompt, plan_id, emit, boundary=boundary,
                                           area_name=req.area_name, options=options)
            store.put_plan(plan)
        except Exception as ex:  # already emitted as a coordinator error event
            run.research_pending = False
            notify(AgentEvent(agent="coordinator", status="error", step=f"Plan failed: {ex}"[:300]))
            return
        if run.research_pending:
            await _area_research(locale_id, plan, run, emit, notify)

    asyncio.create_task(go())
    return {"plan_id": plan_id}


async def _area_research(locale_id: str, plan: Plan, run: store.Run, emit, notify) -> None:
    """docs/12 §8.2: research a drawn area after its plan is shown; the stream stays open until it finishes, then a
    coordinator `done` event tells the UI to reload the rebuilt plan and re-apply its edits via rescore."""
    from backend.research.area import research_area
    emit(AgentEvent(agent="building_reuse", status="done",
                    step="Agent research started in the background: looking up public facts for the buildings "
                         "where they would change the scores most"))
    try:
        new, report = await asyncio.to_thread(research_area, locale_id, plan, emit)
        if new is not None:
            store.put_plan(new)
        step = (f"Agent research finished: {report.accepted} facts accepted for {report.jobs} buildings; "
                + ("plan updated" if new is not None else "plan unchanged"))
        payload = {"plan_id": plan.id, "research": {"jobs": report.jobs, "accepted": report.accepted,
                                                    "proposed": report.proposed, "rejects": dict(report.rejects)}}
    except Exception as ex:   # research is extra: the plan already stands
        step, payload = f"Agent research failed, plan unchanged: {type(ex).__name__}: {ex}"[:300], {"plan_id": plan.id}
    run.research_pending = False
    notify(AgentEvent(agent="coordinator", status="done", step=step, payload=payload))


@app.post("/api/area_check")
def area_check(req: AreaCheckRequest) -> dict:
    """What a drawn boundary would run as: {kind, locale_id, label, jurisdiction, area_km2, error}. Offline-safe."""
    try:
        a = _area(None, req.boundary)
    except AreaError as e:
        return {"kind": None, "error": str(e)}
    return {"kind": a.kind, "locale_id": a.locale_id, "label": a.label, "jurisdiction": a.jurisdiction,
            "area_km2": a.area_km2, "sources_from": a.sources_from, "error": None}


@app.get("/api/metros")
def metros() -> dict:
    """Onboarded county and city outlines (GeoJSON FeatureCollection, Census TIGERweb)."""
    return geo.outlines()


@app.get("/api/geocode")
def geocode(q: str) -> list[dict]:
    """Recorded locales whose aliases match first, then Nominatim hits in a US county (cached);
    offline: recorded only."""
    ql = " ".join(q.lower().replace(",", " ").split())
    out = []
    for loc in load_locales():   # whole words only: "la" must not match "dallas"
        if ql and any(re.search(rf"\b{re.escape(a)}\b", ql) or re.search(rf"\b{re.escape(ql)}\b", a)
                      for a in loc.aliases):
            c = box(*loc.bbox).centroid
            out.append({"label": loc.name, "lonlat": [c.x, c.y], "bbox": list(loc.bbox), "recorded_locale_id": loc.id,
                        "metro": None})
    try:
        hits = cached_get(NOMINATIM, {"q": q, "format": "json", "limit": 10, "countrycodes": "us"})
    except (OfflineCacheMiss, httpx.HTTPError):
        hits = []
    for h in hits:
        lon, lat = float(h["lon"]), float(h["lat"])
        try:
            c = geo.county_at(lon, lat)
        except (OfflineCacheMiss, httpx.HTTPError):
            c = None
        if c is None:   # outside the US counties (or the county lookup is unreachable)
            continue
        county = c["name"]
        s, n, w, e = (float(v) for v in h["boundingbox"])
        out.append({"label": h["display_name"], "lonlat": [lon, lat], "bbox": [w, s, e, n], "recorded_locale_id": None,
                    "metro": county})
    return out[:6]


@app.get("/api/stock_prompts")
def get_stock_prompts() -> list[StockPrompt]:
    return stock_prompts()


@app.post("/api/parse_prompt")
def post_parse_prompt(req: PromptRequest) -> PlanOptions:
    return parse_prompt(req.prompt)


def _sse(e: AgentEvent | dict) -> dict:
    return {"data": e.model_dump_json() if isinstance(e, AgentEvent) else json.dumps(e)}


@app.get("/api/plan/{plan_id}/stream")
async def stream(plan_id: str, replay: int = 0):
    if replay:
        path = store.events_path(plan_id)
        if not path.exists():
            raise HTTPException(404, f"no recorded run for {plan_id}")

        async def replayer():
            for line in path.read_text().splitlines():
                if line.strip():
                    yield {"data": line}
                    await asyncio.sleep(settings.REPLAY_DELAY_S)
        return EventSourceResponse(replayer())
    run = store.runs.get(plan_id)
    if run is None:
        raise HTTPException(404, f"no live run {plan_id}; use ?replay=1 for a recorded run")

    async def live():
        i = 0
        while True:
            while i < len(run.events):
                yield _sse(run.events[i])
                i += 1
            if run.finished:
                return
            run.changed.clear()
            if i < len(run.events):
                continue
            await run.changed.wait()
    return EventSourceResponse(live())


def _plan(plan_id: str) -> Plan:
    p = store.get_plan(plan_id)
    if p is None:
        raise HTTPException(404, f"plan {plan_id} not found")
    return p


@app.get("/api/plan/{plan_id}")
def get_plan(plan_id: str) -> Plan:
    return _plan(plan_id)


@app.post("/api/plan/{plan_id}/rescore")
def plan_rescore(plan_id: str, req: RescoreRequest) -> RescoreResponse:
    p = _plan(plan_id)
    return rescore(p, req.edits, resolve(p.locale.id))


@app.post("/api/plan/{plan_id}/simulate_count")
def plan_simulate_count(plan_id: str, req: CountRequest) -> SimulatedCount:
    p = _plan(plan_id)
    stop = next((s for s in p.transit.stops if s.id == req.stop_id), None)
    if stop is None:
        raise HTTPException(404, f"stop {req.stop_id} not in plan")
    return simulate_count(stop, resolve(p.locale.id))


@app.get("/api/buildings/{building_id}")
def building(building_id: str, plan_id: str) -> dict:
    p = _plan(plan_id)
    b = next((x for x in p.buildings if x.id == building_id), None)
    if b is None:
        raise HTTPException(404, f"building {building_id} not in plan")
    conv = next((c for c in p.conversions if c.building_id == building_id), None)
    rd = next((r for r in p.readiness if r.target_id == building_id), None)
    env = next((e for e in p.envelopes if e.parcel_id == b.parcel_id), None)
    return {"building": b, "conversion": conv, "readiness": rd, "envelope": env}


@app.get("/api/corpus/{doc_id}")
def corpus(doc_id: str) -> dict:
    doc = next((d for d in load_index() if d["doc_id"] == doc_id), None)
    if doc is None:
        raise HTTPException(404, f"{doc_id} not in corpus")
    return {"doc_id": doc_id, "title": doc.get("title"), "url": doc.get("url"),
            "sections": [{"section": s, "text": t} for s, t in load_sections(doc_id).items()]}


@app.get("/api/factors")
def factors() -> list[Factor]:
    return list(load_factors().values())
