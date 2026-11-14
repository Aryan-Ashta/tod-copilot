"""Gap queue for agent research (docs/12 §5.1). Pure and deterministic: code, not the LLM, chooses what to research.

For every candidate building, each researchable field that is missing (or only derived) gets a score swing: the
largest change in the building's overall reuse score when the field is set to the low or high end of its plausible
range (fields.yaml), against the plan's own score (which used `reuse_missing_input_score` for missing inputs). The
same value-of-information idea as `transit.suggest_measurements`."""
import hashlib
import math
from datetime import datetime, timezone
from typing import Callable, Optional

from shapely.geometry import shape

from backend.schemas import Building, ConversionCandidate, Parcel, Provenance, ResearchJob, Sourced

_PROBE = Provenance(source="research_probe", confidence="low", retrieved_at=datetime(2026, 11, 14, tzinfo=timezone.utc),
                    note="gap-queue probe value; never stored")


def needs_research(sv: Sourced) -> bool:
    return sv.value is None or sv.prov.source == "derived"


def job_id(locale_id: str, building_id: str, fields: list[str]) -> str:
    return hashlib.sha1(f"{locale_id}|{building_id}|{','.join(fields)}".encode()).hexdigest()[:12]


def _with(obj, field: str, value):
    return obj.model_copy(update={field: Sourced(value=value, prov=_PROBE)})


def field_swing(b: Building, p: Optional[Parcel], field: str, spec: dict, base: float,
                score: Callable[[Building, Optional[Parcel]], float]) -> float:
    """Largest |overall - base| with the field at the low and high end of its plausible range (0 without one)."""
    lo_hi = spec.get("plausible")
    if not lo_hi:
        return 0.0
    out = 0.0
    for v in lo_hi:
        v = int(v) if spec["parse"] in ("integer", "year") else float(v)
        if spec["target"] == "building":
            s = score(_with(b, field, v), p)
        else:
            s = score(b, _with(p, field, v))
        out = max(out, abs(s - base))
    return round(out, 4)


def research_queue(buildings: list[Building], parcels: dict[str, Parcel], conversions: dict[str, ConversionCandidate],
                   f: dict, *, specs: dict[str, dict], score: Callable[[Building, Optional[Parcel]], float],
                   labels: dict[str, str], station_m: dict[str, Optional[float]], blocked: set[str],
                   locale_id: str) -> list[ResearchJob]:
    """Top `research_max_buildings` jobs with swing >= `research_min_swing`, by swing then distance to a station.

    `specs`: fields.yaml `fields`; `score(building, parcel)` -> ConversionCandidate.overall with the plan's legal
    paths, readiness, walk and acquisition rules; `blocked`: fields a state/county policy removes."""
    jobs: list[ResearchJob] = []
    for b in buildings:
        conv = conversions.get(b.id)
        if conv is None:
            continue
        p = parcels.get(b.parcel_id) if b.parcel_id else None
        swings: dict[str, float] = {}
        for field, spec in specs.items():
            if field in blocked:
                continue
            if spec["target"] == "building":
                if not needs_research(getattr(b, field)):
                    continue
            elif p is None or not needs_research(getattr(p, field)):
                continue   # no parcel: a parcel fact would have nowhere to land
            swings[field] = field_swing(b, p, field, spec, conv.overall, score)
        if not swings:
            continue
        order = list(specs)
        fields = sorted(swings, key=lambda k: (-swings[k], order.index(k)))
        c = shape(b.footprint).representative_point()
        addr = ((p.address.value or "").strip() or None) if p else None
        jobs.append(ResearchJob(job_id=job_id(locale_id, b.id, fields), building_id=b.id, parcel_id=p.id if p else None,
                                label=(labels.get(b.id) or b.id).strip(), address=addr,
                                lonlat=(round(c.x, 6), round(c.y, 6)), fields=fields, swing=max(swings.values())))
    jobs = [j for j in jobs if j.swing >= f["research_min_swing"]]
    jobs.sort(key=lambda j: (-j.swing, station_m.get(j.building_id) if station_m.get(j.building_id) is not None
                             else math.inf, j.building_id))
    return jobs[: int(f["research_max_buildings"])]
