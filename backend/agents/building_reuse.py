"""5. Building reuse agent: which use each existing building could become, and what stops it."""
import re
from typing import Callable, Optional

from backend.agents import common
from backend.agents.context import RunContext
from backend.agents.zoning_legislation import conversion_paths
from backend.models import reuse
from backend.models.finance import acquisition_basis
from backend.models.rescore import conversion_homes
from backend.schemas import Building, ConversionCandidate, Parcel, Site, Sourced

NAME = "building_reuse"
GOAL = "For each existing building, score which use it could become (housing, hotel, mixed use, keep) and list blockers."
SKIPPED = "conversion sites skipped: the prompt focuses on new construction"


def scorer(ctx: RunContext) -> Callable[[Building, Optional[Parcel]], ConversionCandidate]:
    """score(building, parcel=None): one building's reuse score with the plan's legal paths, readiness, walk and
    acquisition basis. `parcel` overrides the plan's parcel record (the research gap queue probes parcel values)."""
    loc, f = ctx.locale, ctx.f
    envs = {e.parcel_id: e for e in ctx.plan_parts["envelopes"]}
    rd = {x.target_id: x for x in ctx.plan_parts["readiness"]}
    parcels = ctx.cache["parcels_by_id"]
    walk = ctx.pre["walk_m"]

    def score(b: Building, parcel: Optional[Parcel] = None) -> ConversionCandidate:
        env = envs.get(b.parcel_id)
        p = parcel if parcel is not None else parcels.get(b.parcel_id)
        acq = None
        if p is not None:
            basis = acquisition_basis(p.last_sale_usd.value, p.assessed_value_usd.value)
            src = p.last_sale_usd if p.last_sale_usd.value is not None else p.assessed_value_usd
            acq = Sourced(value=basis, prov=src.prov) if basis is not None else None
        return reuse.score_reuse(b, conversion_paths(env.paths) if env else None, rd.get(b.id),
                                 walk.get(b.id, {}), acq, f, locale_id=loc.id, data_tier=loc.data_tier)
    return score


def tools(ctx: RunContext):
    loc, f = ctx.locale, ctx.f

    def get_buildings() -> str:
        """Merge building attributes, interiors and footprints from every provider. Returns candidate counts."""
        if "envelopes" not in ctx.plan_parts:
            raise ValueError("run zoning_legislation first")
        cand = common.candidate_buildings(ctx)
        ctx.plan_parts["buildings"] = cand
        derived = sum(1 for b in cand if b.floor_depth_ft.prov.source == "derived")
        ctx.step(NAME, f"{len(cand)} existing commercial buildings; interiors derived from footprints for {derived}")
        by_type: dict[str, int] = {}
        for b in cand:
            by_type[b.property_type.value] = by_type.get(b.property_type.value, 0) + 1
        return (f"{len(cand)} candidate buildings by type: {common.counts_text(by_type)}; {derived} with "
                f"footprint-derived interiors")

    def score_reuse() -> str:
        """Score every candidate building for residential, hotel, mixed use and keep on physical, legal, market,
        financial and location fit. Returns the top candidates."""
        cand = ctx.plan_parts.get("buildings")
        if cand is None:
            raise ValueError("run get_buildings first")
        ctx.step(NAME, f"Scoring {len(cand)} buildings on five fits")
        score = scorer(ctx)
        out = [score(b) for b in cand]
        # conversion prospects first (by overall), then buildings whose best use is to keep their current use
        out.sort(key=lambda c: (c.best_use == "keep_current", -c.overall))
        ctx.plan_parts["conversions"] = out
        top = [c for c in out if c.best_use != "keep_current"][:5]
        names = {b.id: common.building_label(ctx, b) for b in cand}

        def brief(c) -> str:
            bl = [re.sub(r"\s*\(factor `[^`]+`\)", "", x) for x in c.blockers[:2]]
            return (f"{names[c.building_id]}: {c.best_use.replace('_', ' ')} {c.overall:.2f}"
                    + (f" (top blockers: {'; '.join(bl)})" if bl else " (no blockers)"))
        if top:
            return f"{len(top)} top conversion prospects: " + "; ".join(brief(c) for c in top)
        if not out:
            return "no candidate buildings"
        return "no building scores better converted than kept; closest: " + "; ".join(brief(c) for c in out[:2])

    def estimate_units() -> str:
        """Turn the top feasible conversions into conversion sites with unit estimates. Returns the sites."""
        convs = ctx.plan_parts.get("conversions")
        if convs is None:
            raise ValueError("run score_reuse first")
        bmap = {b.id: b for b in ctx.plan_parts["buildings"]}
        picked = [c for c in convs if c.best_use != "keep_current" and c.overall >= f["reuse_feasible_threshold"]]
        if ctx.options.focus == "new_build":
            picked = []
        sites = []
        n = f["goal_sites_top_n"] if ctx.options.goals.housing() else f["sites_top_n"]
        for c in picked[:n]:
            b = bmap[c.building_id]
            sites.append(Site(id=f"conv-{b.id}", kind="conversion", parcel_ids=[b.parcel_id] if b.parcel_id else [],
                              building_id=b.id, geometry=b.footprint, homes=conversion_homes(c.best_use, c.est_units, f),
                              height_ft=(b.stories.value or 1) * f["story_height_ft"], status="pursue"))
        ctx.plan_parts["sites"] = [s for s in ctx.plan_parts.get("sites", []) if s.kind != "conversion"] + sites
        if ctx.options.focus == "new_build":
            ctx.step(NAME, SKIPPED)
            return SKIPPED
        ctx.step(NAME, f"{len(sites)} conversion sites, {sum(s.homes for s in sites)} homes")
        return "; ".join(f"{common.site_label(ctx, s.id)}: {s.homes} homes" for s in sites) or "no feasible conversion"

    return [get_buildings, score_reuse, estimate_units]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def explain(ctx: RunContext) -> str:
    convs = ctx.plan_parts.get("conversions", [])
    conv_sites = [s for s in ctx.plan_parts.get("sites", []) if s.kind == "conversion"]
    derived = sum(1 for b in ctx.plan_parts.get("buildings", []) if b.floor_depth_ft.prov.source == "derived")
    text = (f"Scored {len(convs)} buildings; {sum(1 for c in convs if c.best_use != 'keep_current')} could change use and "
            f"{len(conv_sites)} became conversion sites. Floor depths for {derived} buildings are derived from "
            f"footprints, not measured, so confidence is capped at low.")
    blds = ctx.plan_parts.get("buildings", [])
    gone = [k.replace("_", " ").replace(" usd sqft yr", "").replace(" pct", "").replace(" sqft", "").replace(" ft", "")
            for k in common.BUILDING_FIELDS if k != "name" and blds
            and all(getattr(b, k).prov.confidence == "missing" for b in blds)]
    if gone:
        text += f" Missing for every building here (no source covers it): {', '.join(gone)}."
    if ctx.locale.data_tier == "public_only":
        text += " Screening only: county records carry little beyond use and area."
    if ctx.options.focus == "new_build":
        text += f" {SKIPPED[0].upper()}{SKIPPED[1:]}."
    return text
