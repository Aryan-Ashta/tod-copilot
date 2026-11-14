"""8. Sustainability and health agent: transport CO2, embodied carbon saved, solar, walk access, flood exposure."""
from backend.agents.context import RunContext
from backend.data.resolver import Capability
from backend.models import rescore as rs
from backend.models import targets as tg

NAME = "sustainability_health"
GOAL = "Score the plan on transport CO2, embodied carbon saved by reuse, rooftop solar, walk access and flood exposure."


def tools(ctx: RunContext):
    loc, f = ctx.locale, ctx.f

    def _homes() -> dict:
        sites = ctx.plan_parts.get("sites")
        if sites is None or "stacks" not in ctx.plan_parts:
            raise ValueError("run funding first")
        out: dict[str, int] = {}
        for s in sites:
            if rs.in_plan(s) and s.homes:
                out[rs.site_target(s)] = out.get(rs.site_target(s), 0) + s.homes
        return out

    def transport_co2() -> str:
        """Tonnes CO2/yr avoided by new households within a 10-minute walk of frequent transit."""
        hh = tg.households_near_frequent(_homes(), ctx.pre["walk_m"], f)
        return f"{hh} households near frequent transit -> {tg.transport_co2(hh, f):.1f} t CO2/yr"

    def embodied_co2_saved() -> str:
        """Embodied carbon saved by converting instead of demolishing and rebuilding, per pursued conversion."""
        convs = {c.building_id: c for c in ctx.plan_parts.get("conversions", [])}
        total = sum(convs[s.building_id].embodied_co2_saved_tonnes or 0 for s in ctx.plan_parts["sites"]
                    if rs.in_plan(s) and s.kind == "conversion" and s.building_id in convs)
        return f"{total:.0f} t CO2e saved by pursued conversions"

    def rooftop_solar() -> str:
        """Annual rooftop solar (MWh) from usable roof area and PVWatts output per kW (factor fallback)."""
        sol = ctx.resolver.get(loc, Capability.SOLAR)
        kwh = sol.value["annual_kwh_per_kw"] if sol.value else f["solar_kwh_per_kw_year"]
        ctx.pre["solar_kwh_per_kw_year"] = kwh
        return f"{kwh:.0f} kWh/kW/yr ({'PVWatts' if sol.value else 'factor solar_kwh_per_kw_year'})"

    def walk_access() -> str:
        """Share of new homes within a 10-minute walk of a park, clinic and grocery."""
        return f"{100 * tg.walk_access(_homes(), ctx.pre['walk_m'], f):.0f}% of new homes"

    def flood_exposure() -> str:
        """Share of new homes inside FEMA high-risk flood zones (target 0) and the final target scores."""
        if "solar_kwh_per_kw_year" not in ctx.pre:
            rooftop_solar()
        bmap = {b.id: b for b in ctx.plan_parts.get("buildings", [])}
        targets, _ = rs.score_plan(ctx.plan_parts["sites"], ctx.plan_parts["stacks"],
                                   {c.building_id: c for c in ctx.plan_parts.get("conversions", [])},
                                   {k: b.rentable_area_sqft.value for k, b in bmap.items()},
                                   {k: b.roof_area_sqft.value for k, b in bmap.items()},
                                   {p.id: p.area_acres.value for p in ctx.plan_parts["parcels"]},
                                   ctx.pre["walk_m"], ctx.pre["in_flood"], ctx.pre["solar_kwh_per_kw_year"], f)
        ctx.plan_parts["targets"] = targets
        ctx.step(NAME, "Targets scored", {"targets": {t.key: t.value for t in targets}})
        return f"{100 * tg.flood_exposure(_homes(), ctx.pre['in_flood']):.0f}% of new homes in flood zones"

    return [transport_co2, embodied_co2_saved, rooftop_solar, walk_access, flood_exposure]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def explain(ctx: RunContext) -> str:
    t = {x.key: x for x in ctx.plan_parts.get("targets", [])}
    if not t:
        return "Targets not scored."
    parts = [f"{x.value:g} {x.unit} {k.replace('_', ' ')}" for k, x in t.items()]
    return "; ".join(parts) + ". Each target lists the factors behind it."
