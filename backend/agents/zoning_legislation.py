"""3. Zoning and legislation agent: which legal paths apply to each candidate parcel and what each allows."""
from datetime import date

from backend.agents import common
from backend.agents.context import RunContext
from backend.corpus.loader import has_rules, load_index, load_rules, path_info
from backend.corpus.loader import search_corpus as corpus_search
from backend.models import zoning
from backend.models.reuse import units_for
from backend.schemas import ZoningEnvelope

NAME = "zoning_legislation"
GOAL = "For each candidate parcel, which legal paths apply and what each allows, with verbatim citations."
NOT_COVERED = "No legal corpus for this area: every legal question is not covered."


def is_conversion_only(name: str) -> bool:
    return path_info(name)["kind"] == "conversion"


def is_new_construction_only(name: str) -> bool:
    return path_info(name)["kind"] == "new_construction"


def snippet(text: str, words: int = 25) -> str:
    """The first `words` words of a verbatim quote, with an ellipsis when cut."""
    w = text.split()
    return " ".join(w[:words]) + ("…" if len(w) > words else "")


def path_names(rules: list[dict]) -> list[str]:
    return list(dict.fromkeys(r["path"] for r in rules))


def conversion_paths(paths):
    """Paths that govern converting an existing building (backend/corpus/paths.yaml kind conversion or both); a
    conversion-only ordinance, where one exists, is the conversion path."""
    conv = [p for p in paths if is_conversion_only(p.name)]
    return conv or [p for p in paths if not is_new_construction_only(p.name)] or list(paths)


def tools(ctx: RunContext):
    loc, f = ctx.locale, ctx.f

    def search_corpus(query: str) -> str:
        """Search the curated legal corpus for this jurisdiction (BM25). Returns sections with a short verbatim quote."""
        hits = corpus_search(loc.jurisdiction, query, k=5)
        return "; ".join(f"{h['doc_id']} {h['section']}: “{snippet(h['text'])}”" for h in hits) or "not covered"

    def apply_rules() -> str:
        """Evaluate every legal path's structured rules for each candidate parcel and building host parcel;
        compute homes per path and the recommended path. Returns eligibility counts per path."""
        if "readiness" not in ctx.plan_parts:
            raise ValueError("run infrastructure first")
        if not has_rules(loc.jurisdiction):
            ctx.cache["path_names"] = []
            ctx.plan_parts["envelopes"] = []
            ctx.pre["homes_by_parcel"] = {}
            ctx.cache["zoning_attrs"] = {}
            ctx.step(NAME, NOT_COVERED)
            return NOT_COVERED
        rules = load_rules(loc.jurisdiction)
        names = path_names(rules)
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
            homes = {pth.name: (attrs["est_units"] if is_conversion_only(pth.name) and pth.eligible else
                                zoning.homes_for(p.area_acres.value, pth, f)) for pth in paths}
            paths = [pth.model_copy(update={"homes": homes[pth.name] if pth.eligible else None}) for pth in paths]
            nb = [h for n, h in homes.items() if not is_conversion_only(n) and h]
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
        rec = {n: sum(1 for e in envelopes if e.recommended_path == n) for n in names}
        both = sum(1 for e in envelopes if sum(1 for x in e.paths if x.eligible) > 1)
        per_path = []
        for n in names:
            ex = next((x for e in envelopes for x in e.paths if x.name == n and x.eligible), None)
            cites = list({(c.doc_id, c.section): c for c in (ex.citations if ex else [])}.values())[:2]
            per_path.append(f"{n}: eligible on {counts[n]}, recommended on {rec[n]}"
                            + "".join(f"; {c.section}: “{snippet(c.quote)}”" for c in cites))
        return (f"{len(envelopes)} candidate parcels (underused land and parcels with a convertible building) "
                f"evaluated in the plan area around the {len(loc.stations)} station(s); " + " | ".join(per_path)
                + (f" | {both} parcels qualify under more than one path" if len(names) > 1 else "")
                + f" | not covered by the corpus: {sum(1 for e in envelopes if not e.covered)}")

    return [search_corpus, apply_rules]


def run(ctx: RunContext) -> None:
    _, apply_rules = tools(ctx)
    apply_rules()


def explain(ctx: RunContext) -> str:
    envs = ctx.plan_parts.get("envelopes", [])
    if not has_rules(ctx.locale.jurisdiction):
        return NOT_COVERED
    names = ctx.cache.get("path_names", [])
    rec: dict[str, int] = {}
    for e in envs:
        if e.recommended_path:
            rec[e.recommended_path] = rec.get(e.recommended_path, 0) + 1
    uncovered = sum(1 for e in envs if not e.covered)
    base = f"Evaluated {common.join_and(names)} for {len(envs)} candidate parcels. "
    base += (f"Recommended path: {common.counts_text(rec, '{k} on {n} parcels')}. " if rec
             else "No parcel has an eligible path. ")
    if len(names) > 1:
        both = sum(1 for e in envs if sum(1 for x in e.paths if x.eligible) > 1)
        base += f"{both} parcels qualify under more than one path; each shows the paths side by side. "
    base += f"{uncovered} parcels are not covered by the corpus." if uncovered else "Every parcel is covered by the corpus."
    for n in names:
        if note := path_info(n).get("explain_note"):
            base += f" {note}"
    return base
