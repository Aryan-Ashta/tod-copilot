"""3. Zoning and legislation agent: which legal paths apply to each candidate parcel and what each allows."""
from datetime import date

from backend.agents import common
from backend.agents.context import RunContext
from backend.corpus.loader import load_index, load_rules
from backend.corpus.loader import search_corpus as corpus_search
from backend.models import zoning
from backend.models.reuse import units_for
from backend.schemas import ZoningEnvelope
from backend.settings import CORPUS_DIR

NAME = "zoning_legislation"
GOAL = "For each candidate parcel, which legal paths apply and what each allows, with verbatim citations."
ARO = "LA Citywide Adaptive Reuse"
NEW_BUILD_EXCLUDE = {ARO}
NOT_COVERED = "No legal corpus for this area: every legal question is not covered."


def path_names(jurisdiction: str, rules: list[dict]) -> list[str]:
    if jurisdiction == "houston":
        return ["Houston development rules"]
    if jurisdiction == "los_angeles":
        return ["SB 79 new construction", ARO]
    return list(dict.fromkeys(r["path"] for r in rules))


def conversion_paths(jurisdiction: str, paths):
    """Paths that govern converting an existing building (SB 79 is new construction only)."""
    return [p for p in paths if p.name == ARO] if jurisdiction == "los_angeles" else list(paths)


def tools(ctx: RunContext):
    loc, f = ctx.locale, ctx.f

    def search_corpus(query: str) -> str:
        """Search the curated legal corpus for this jurisdiction (BM25). Returns doc ids and sections."""
        hits = corpus_search(loc.jurisdiction, query, k=5)
        return "; ".join(f"{h['doc_id']} {h['section']}" for h in hits) or "not covered"

    def apply_rules() -> str:
        """Evaluate every legal path's structured rules for each candidate parcel and building host parcel;
        compute homes per path and the recommended path. Returns eligibility counts per path."""
        if "readiness" not in ctx.plan_parts:
            raise ValueError("run infrastructure first")
        if not (CORPUS_DIR / "rules" / f"{loc.jurisdiction}.yaml").exists():
            ctx.cache["path_names"] = []
            ctx.plan_parts["envelopes"] = []
            ctx.pre["homes_by_parcel"] = {}
            ctx.cache["zoning_attrs"] = {}
            ctx.step(NAME, NOT_COVERED)
            return NOT_COVERED
        rules = load_rules(loc.jurisdiction)
        names = path_names(loc.jurisdiction, rules)
        urls = {d["doc_id"]: d.get("url") for d in load_index()}
        ctx.cache["path_names"] = names
        year = date.today().year
        plan_parcels = ctx.cache["plan_parcels"]
        cand_b = common.candidate_buildings(ctx)
        biggest: dict[str, object] = {}
        for b in cand_b:
            cur = biggest.get(b.parcel_id)
            if cur is None or (b.rentable_area_sqft.value or 0) > (cur.rentable_area_sqft.value or 0):
                biggest[b.parcel_id] = b
        flood = ctx.pre["in_flood"]
        envelope_ids = {p.id for p in common.underused_parcels(ctx)} | set(biggest)
        ctx.step(NAME, f"Evaluating {', '.join(names)} for {len(plan_parcels)} parcels")
        envelopes, homes_by_parcel, attrs_by_parcel = [], {}, {}
        for p in plan_parcels:
            d_m, station = common.euclid_to_stations(ctx, common.centroid_lonlat(p.geometry))
            b = biggest.get(p.id)
            attrs = {"land_use": p.land_use.value, "area_acres": p.area_acres.value, "zoning_code": p.zoning_code.value,
                     "in_flood_zone": flood.get(p.id), "distance_to_stop_mi": common.miles(d_m) if d_m is not None else None,
                     "station_mode": station.mode if station else None, "property_type": None,
                     "building_age_years": None, "stories": None, "est_units": None}
            if b is not None:
                attrs.update(property_type=b.property_type.value, stories=b.stories.value,
                             building_age_years=(year - b.year_built.value) if b.year_built.value else None,
                             est_units=units_for(b.rentable_area_sqft.value, f))
            paths = zoning.apply_rules(attrs, rules, names, urls)
            homes = {pth.name: (attrs["est_units"] if pth.name == ARO and pth.eligible else
                                zoning.homes_for(p.area_acres.value, pth, f)) for pth in paths}
            nb = [h for n, h in homes.items() if n not in NEW_BUILD_EXCLUDE and h]
            homes_by_parcel[p.id] = max(nb) if nb else None
            attrs_by_parcel[p.id] = attrs
            if p.id in envelope_ids:
                envelopes.append(ZoningEnvelope(parcel_id=p.id, paths=paths, recommended_path=zoning.recommend(paths, homes),
                                                covered=any(x.eligible is not None for x in paths)))
        ctx.plan_parts["envelopes"] = envelopes
        ctx.pre["homes_by_parcel"] = homes_by_parcel
        ctx.cache["zoning_attrs"] = attrs_by_parcel
        counts = {n: sum(1 for e in envelopes for x in e.paths if x.name == n and x.eligible) for n in names}
        ctx.step(NAME, f"{len(envelopes)} envelopes", {"eligible_by_path": counts})
        return f"{len(envelopes)} envelopes; eligible parcels by path: {counts}; " \
               f"not covered: {sum(1 for e in envelopes if not e.covered)}"

    return [search_corpus, apply_rules]


def run(ctx: RunContext) -> None:
    _, apply_rules = tools(ctx)
    apply_rules()


def explain(ctx: RunContext) -> str:
    envs = ctx.plan_parts.get("envelopes", [])
    if not (CORPUS_DIR / "rules" / f"{ctx.locale.jurisdiction}.yaml").exists():
        return NOT_COVERED
    names = ctx.cache.get("path_names", [])
    rec = {}
    for e in envs:
        if e.recommended_path:
            rec[e.recommended_path] = rec.get(e.recommended_path, 0) + 1
    base = (f"Evaluated {', '.join(names)} for {len(envs)} candidate parcels; recommended: "
            f"{rec or 'none'}; {sum(1 for e in envs if not e.covered)} not covered by the corpus.")
    if ctx.locale.jurisdiction == "houston":
        base += " Houston has no zoning; development rules apply and deed restrictions need a title check."
    return base
