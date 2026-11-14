"""What the research pipeline needs from a plan: candidate buildings scored exactly as `run_plan` scores them, the gap
queue, and per-building references for the verifier. Deterministic; no LLM."""
import json
from functools import cached_property
from typing import Optional

from shapely.geometry import shape

from backend.agents import building_reuse, common
from backend.agents.context import RunContext
from backend.agents.coordinator import AGENTS
from backend.data.factors import resolve
from backend.data.geo import area_sqft
from backend.data.locales import get_locale, locale_dir
from backend.data.resolver import default_resolver
from backend.models.research import research_queue
from backend.research import registry
from backend.research.verify import BuildingRef
from backend.schemas import Building, ResearchJob

REQUIRED = ("osm", "county")   # docs/12 §8.1; `research` too when hand research exists (a drawn area has none)


class PlanContext:
    """Runs the deterministic agents up to building reuse for one locale (recorded or drawn area)."""

    def __init__(self, locale_id: str):
        d = locale_dir(locale_id)
        missing = [s for s in REQUIRED if not (d / s / "_meta.json").exists()]
        if (d / "research" / "buildings_source.yaml").exists() and not (d / "research" / "_meta.json").exists():
            missing.append("research")
        if missing:
            raise RuntimeError(f"agent_research needs the {', '.join(missing)} step(s) recorded first: "
                               f"record_fixtures.py --locale {locale_id} --only {','.join(missing)}")
        self.locale = get_locale(locale_id)
        # The queue is computed without agent_research's own earlier output, so a re-run asks for the same jobs and
        # reuses their cached results (docs/12 §8.1: resumable).
        r = default_resolver()
        r.providers = [p for p in r.providers if p.name != "agent_research"]
        self.ctx = RunContext(locale=self.locale, prompt="agent research gap queue", resolver=r,
                              f=resolve(locale_id), emit=lambda e: None)
        for mod in AGENTS:
            mod.run(self.ctx)
            if mod is building_reuse:
                break
        self.score = building_reuse.scorer(self.ctx)

    @property
    def f(self) -> dict:
        return self.ctx.f

    @property
    def buildings(self) -> list[Building]:
        return self.ctx.plan_parts["buildings"]

    @cached_property
    def by_id(self) -> dict[str, Building]:
        return {b.id: b for b in self.buildings}

    @cached_property
    def _osm(self) -> dict[str, dict]:
        p = locale_dir(self.locale.id) / "osm" / "buildings.geojson"
        return {f["properties"]["id"]: f["properties"] for f in json.loads(p.read_text())["features"]} if p.exists() else {}

    def queue(self) -> list[ResearchJob]:
        conv = {c.building_id: c for c in self.ctx.plan_parts["conversions"]}
        labels = {b.id: common.building_label(self.ctx, b) for b in self.buildings}
        dist = {b.id: common.euclid_to_stations(self.ctx, common.centroid_lonlat(b.footprint))[0] for b in self.buildings}
        return research_queue(self.buildings, self.ctx.cache["parcels_by_id"], conv, self.f,
                              specs=registry.field_specs(),
                              score=lambda b, p: self.score(b, p).overall, labels=labels, station_m=dist,
                              blocked=registry.blocked_fields(self.locale.county_fips), locale_id=self.locale.id)

    def ref(self, building_id: str) -> Optional[BuildingRef]:
        b = self.by_id.get(building_id)
        if b is None:
            return None
        osm = self._osm.get(building_id, {})
        p = self.ctx.cache["parcels_by_id"].get(b.parcel_id)
        levels = osm.get("levels")
        try:
            levels = int(round(float(levels))) if levels not in (None, "") else None
        except ValueError:
            levels = None

        def real(sv):   # derived values are what research replaces; don't cross-check against them
            return sv.value if sv.value is not None and sv.prov.source != "derived" else None
        return BuildingRef(building_id=b.id, name=b.name.value or osm.get("name"),
                           address=(p.address.value if p is not None else None) or osm.get("addr"),
                           osm_levels=levels, footprint_sqft=area_sqft(shape(b.footprint), self.locale.utm_epsg),
                           stories=real(b.stories), rentable_area_sqft=real(b.rentable_area_sqft),
                           typical_floor_sqft=real(b.typical_floor_sqft))

    def known(self, job: ResearchJob) -> dict[str, str]:
        """Researchable fields this building or parcel already has from another source: field -> "value (source)".
        The verifier rejects agent facts for them (agent research only fills gaps)."""
        b = self.by_id.get(job.building_id)
        p = self.ctx.cache["parcels_by_id"].get(job.parcel_id) if job.parcel_id else None
        ref = self.ref(job.building_id)
        out: dict[str, str] = {}
        specs = {**registry.field_specs(), **registry.identity_specs()}
        for field, spec in specs.items():
            if field in job.fields:
                continue
            if field == "name":
                if ref is not None and ref.name:
                    out[field] = f"{ref.name!r} (osm or another source)" if b is None or b.name.value is None \
                        else f"{b.name.value!r} ({b.name.prov.source})"
                continue
            obj = b if spec["target"] == "building" else p
            if obj is None:
                out[field] = "no parcel to hold it"
                continue
            sv = getattr(obj, field)
            if sv.value is not None and sv.prov.source != "derived":
                out[field] = f"{str(sv.value).strip()!r} ({sv.prov.source})"
        return out
