"""4. Site agent (new construction): the best underused land near stops."""
import math

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from backend.agents import common
from backend.agents.context import RunContext
from backend.data.geo import to_utm
from backend.schemas import Site

NAME = "site"
GOAL = "Find the best underused land (surface parking, one-story retail, vacant lots) near stops for new homes."
SKIPPED = "new-build sites skipped: the prompt focuses on conversions"


def tools(ctx: RunContext):
    loc, f = ctx.locale, ctx.f
    w = f["site_rank_weights"]
    max_d = w["max_distance_to_station_m"]

    def get_parcels() -> str:
        """Load county parcels (and CoStar parcels where available) merged per parcel. Returns the count."""
        if "plan_parcels" not in ctx.cache:
            raise ValueError("run infrastructure first")
        ctx.plan_parts["parcels"] = ctx.cache["plan_parcels"]
        return f"{len(ctx.plan_parts['parcels'])} parcels in the plan area (residential lots excluded)"

    def classify_land_use() -> str:
        """Count underused parcels by kind (surface parking from imagery flags, one-story retail, vacant)."""
        under = common.underused_parcels(ctx)
        counts = {k: sum(1 for p in under if p.land_use.value == k) for k in common.UNDERUSE}
        ctx.step(NAME, f"{len(under)} underused parcels", {"counts": counts})
        return f"underused parcels: {counts}"

    def find_combinable() -> str:
        """Union touching underused parcels with the same owner into one site. Returns the site-candidate count."""
        if "envelopes" not in ctx.plan_parts:
            raise ValueError("run zoning_legislation first")
        sw = ctx.cache["station_walk_m"]
        flood = ctx.pre["in_flood"]
        near = [p for p in common.underused_parcels(ctx)
                if sw.get(p.id) is not None and sw[p.id] <= max_d and not flood.get(p.id)]
        epsg = loc.utm_epsg
        groups: list[list] = []
        geoms = {p.id: to_utm(p.geometry, epsg).buffer(0.5) for p in near}
        assigned: dict[str, int] = {}
        for p in near:
            owner = (p.owner.value or "").strip().upper()
            gi = None
            if owner:
                for q in near:
                    if q.id in assigned and (q.owner.value or "").strip().upper() == owner and geoms[p.id].intersects(geoms[q.id]):
                        gi = assigned[q.id]
                        break
            if gi is None:
                groups.append([p])
                assigned[p.id] = len(groups) - 1
            else:
                groups[gi].append(p)
                assigned[p.id] = gi
        ctx.cache["site_groups"] = groups
        combined = sum(1 for g in groups if len(g) > 1)
        ctx.step(NAME, f"{len(near)} underused parcels within {max_d} m walk of a station; {combined} combined sites")
        return f"{len(groups)} candidate sites ({combined} combine same-owner touching parcels)"

    def homes_for() -> str:
        """Homes per candidate site from its zoning envelope, then rank by homes x distance weight x underuse
        x readiness and keep the top sites. Returns the chosen sites."""
        groups = ctx.cache.get("site_groups")
        if groups is None:
            raise ValueError("run find_combinable first")
        hb = ctx.pre["homes_by_parcel"]
        sw = ctx.cache["station_walk_m"]
        rd = {x.target_id: x.score for x in ctx.plan_parts["readiness"]}
        envs = {e.parcel_id: e for e in ctx.plan_parts["envelopes"]}
        ranked = []
        for g in groups:
            homes = sum(hb.get(p.id) or 0 for p in g)
            if homes <= 0:
                continue
            d = min(sw[p.id] for p in g)
            under = max(w["underuse"][p.land_use.value] for p in g)
            ready = sum(rd.get(p.id, 0) for p in g) / len(g)
            score = homes * max(0.0, 1 - d / max_d) * under * ready
            ranked.append((score, g, homes))
        ranked.sort(key=lambda x: -x[0])
        skip = ctx.options.focus == "conversions"
        sites = []
        for score, g, homes in ([] if skip else ranked[: f["sites_top_n"]]):
            env = envs.get(g[0].id)
            max_h = next((x.allows.get("max_height_ft") for x in env.paths if x.eligible and x.allows.get("max_height_ft")),
                         None) if env else None
            stories = math.floor(max_h / f["story_height_ft"]) if max_h else f["newbuild_assumed_stories"]
            geom = g[0].geometry if len(g) == 1 else mapping(unary_union([shape(p.geometry) for p in g]))
            sites.append(Site(id=f"site-{g[0].id}", kind="new_build", parcel_ids=[p.id for p in g], building_id=None,
                              geometry=geom, homes=homes, height_ft=stories * f["story_height_ft"], status="pursue"))
        ctx.plan_parts.setdefault("sites", [])
        ctx.plan_parts["sites"] = [s for s in ctx.plan_parts["sites"] if s.kind != "new_build"] + sites
        if skip:
            ctx.step(NAME, SKIPPED)
            return SKIPPED
        ctx.step(NAME, f"Top {len(sites)} new-build sites: {sum(s.homes for s in sites)} homes")
        return "; ".join(f"{s.id}: {s.homes} homes" for s in sites) or "no eligible underused land near stations"

    return [get_parcels, classify_land_use, find_combinable, homes_for]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def explain(ctx: RunContext) -> str:
    sites = [s for s in ctx.plan_parts.get("sites", []) if s.kind == "new_build"]
    n_under = len(common.underused_parcels(ctx)) if "parcels" in ctx.cache else 0
    text = (f"{n_under} underused parcels found; the top {len(sites)} new-build sites near stations hold "
            f"{sum(s.homes for s in sites)} homes. Parcels in FEMA high-risk flood zones were excluded.")
    if ctx.options.focus == "conversions":
        text += f" {SKIPPED[0].upper()}{SKIPPED[1:]}."
    return text
