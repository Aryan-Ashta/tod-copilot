"""Onboarding driver (docs/12 §14): bring one county's registry entry up to what plan-time recording needs, running
each agent once. Called by areas.record_area the first time someone draws in a county, and by scripts/onboard.py.

Order: transit (deterministic) -> parcels -> land_use -> zoning (county, then each city in the area) -> utilities
(same targets) -> corpus (legal corpus builder for each of `corpus_targets`) -> factors. A section already present
(any status) is skipped unless `force`; `force` never replaces a `reviewed` section. One failing section never stops
the others."""
import threading
from typing import Callable, Optional, Sequence

from backend import settings
from backend.onboard import geo, registry
from backend.onboard.common import forget, llm_ready, sample_box, thresholds

SECTIONS = ("transit", "parcels", "land_use", "zoning", "utilities", "corpus", "factors")   # assessor: run elsewhere
LLM_SECTIONS = {"parcels", "land_use", "zoning", "utilities", "corpus", "factors"}
_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _lock(fips: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(fips, threading.Lock())


def ensure_county_file(fips: str) -> dict:
    c = registry.county(fips)
    if c.get("name") and c.get("sample_lonlat"):
        return c
    info = geo.county_info(fips)
    c = {"fips": fips, "name": info["name"], "state": info["state"],
         "jurisdiction": registry.county_jurisdiction({"name": info["name"], "state": info["state"]}),
         "sample_lonlat": [round(v, 7) for v in info["sample_lonlat"]], **c}
    registry.save_county(fips, c)
    return c


def ensure_place(p: dict, county_fips: str) -> dict:
    """The minimal registry place file for a TIGER place (geo.places_in entry), written once."""
    existing = registry.place(p["geoid"])
    if existing:
        return existing
    data = {"fips": p["geoid"], "name": p["name"], "basename": p["basename"], "state": p["state"],
            "county": county_fips, "jurisdiction": p["jurisdiction"]}
    registry.save_place(p["geoid"], data)
    return data


def _skip(section: Optional[dict], force: bool) -> bool:
    status = registry.section_status(section)
    return status is not None and (not force or status == "reviewed")


def onboard_county(fips5: str, area_bbox: Optional[tuple] = None, *, only: Optional[set[str]] = None,
                   force: bool = False, step: Callable[[str], None] = print, model=None, search=None,
                   corpus_targets: Sequence[str] = ()) -> dict:
    """{"done": [...], "skipped": [...], "errors": [...]} for one county. `corpus_targets` ("state:08",
    "place:0820000", "county:08031") get a legal corpus built when they have none."""
    from backend.onboard import corpus, land_use, parcels, transit, utilities, zoning
    from backend.onboard import factors as local_factors
    out = {"done": [], "skipped": [], "errors": []}
    want = [s for s in SECTIONS if only is None or s in only]
    llm = llm_ready() or model is not None
    with _lock(fips5):
        if settings.OFFLINE:
            out["skipped"] = [f"{s}: offline" for s in want]
            return out
        c = ensure_county_file(fips5)
        center = (((area_bbox[0] + area_bbox[2]) / 2, (area_bbox[1] + area_bbox[3]) / 2) if area_bbox
                  else tuple(c["sample_lonlat"]))
        box = sample_box(*center, thresholds()["onboard_sample_box_m"])
        area = tuple(area_bbox) if area_bbox else box

        def reset(kind: str, gid: str, section: str, agent: Optional[str]) -> None:
            """force: drop a non-reviewed section and the agent's checkpoint so it is proposed and verified afresh."""
            data = registry.county(gid) if kind == "county" else registry.place(gid)
            if data.pop(section, None) is not None:
                (registry.save_county if kind == "county" else registry.save_place)(gid, data)
            if agent:
                forget(agent, f"{section}-{gid}")

        def run(name: str, section: Optional[dict], fn: Callable[[], object],
                on_force: Optional[Callable[[], None]] = None) -> None:
            if _skip(section, force):
                out["skipped"].append(f"{name}: present")
                return
            if name.split(" ")[0] in LLM_SECTIONS and not llm:
                out["skipped"].append(f"{name}: needs ANTHROPIC_API_KEY")
                return
            step(f"Onboarding {c['name']}: {name}")
            try:
                if section is not None and on_force is not None:
                    on_force()
                if fn():
                    out["done"].append(name)
                else:
                    out["errors"].append(f"{name}: proposal rejected by the code checks (cache/onboard rejects.jsonl)")
            except Exception as e:   # one section must not sink the rest; it is retried next time
                msg = f"{name}: {type(e).__name__}: {e}"[:300]
                step(f"onboarding failed: {msg}")
                out["errors"].append(msg)

        kw = {"model": model, "search": search}
        if "transit" in want:
            run("transit", registry.county(fips5).get("transit_feeds"), lambda: transit.ensure_transit(fips5),
                lambda: reset("county", fips5, "transit_feeds", None))
        if "parcels" in want:
            run("parcels", registry.county(fips5).get("parcels"), lambda: parcels.ensure_parcels(fips5, box, **kw),
                lambda: reset("county", fips5, "parcels", "parcel_scout"))
        found = registry.section_status(registry.county(fips5).get("parcels")) in ("reviewed", "agent_verified")
        if "land_use" in want:
            if found:
                run("land_use", registry.county(fips5).get("land_use"),
                    lambda: land_use.ensure_land_use(fips5, box, **kw),
                    lambda: reset("county", fips5, "land_use", "use_code_mapper"))
            else:
                out["skipped"].append("land_use: no parcel source")
        places = []
        if "zoning" in want or "utilities" in want:
            try:
                places = [ensure_place(p, fips5) for p in geo.places_in(area)]
            except Exception as e:
                out["errors"].append(f"places: {type(e).__name__}: {e}"[:300])
        targets = [("county", fips5, c["name"])] + [("place", p["fips"], p["name"]) for p in places]
        for section, mod, agent in (("zoning", zoning.ensure_zoning, "zoning_scout"),
                                    ("utilities", utilities.ensure_utilities, "utilities_scout")):
            if section not in want:
                continue
            for kind, gid, name in targets:
                data = registry.county(gid) if kind == "county" else registry.place(gid)
                run(f"{section} {kind} {gid}", data.get(section),
                    lambda kind=kind, gid=gid, name=name, mod=mod: mod(kind, gid, name, fips5, area, **kw),
                    lambda kind=kind, gid=gid, section=section, agent=agent: reset(kind, gid, section, agent))
        if "corpus" in want:
            for t in corpus_targets:
                run(f"corpus {t}", corpus.corpus_section(t),
                    lambda t=t: corpus.build(t, bbox=area, **kw)["rules"] > 0,
                    lambda t=t: corpus.forget_corpus(t))
        if "factors" in want:
            have = (local_factors.scoped_exists(f"state-{fips5[:2]}") and
                    local_factors.scoped_exists(f"county-{fips5}"))
            run("factors", {"status": "agent_verified"} if have else None,
                lambda: local_factors.ensure_factors(fips5, **kw) or True,
                lambda: local_factors.forget_scopes(fips5))
    return out
