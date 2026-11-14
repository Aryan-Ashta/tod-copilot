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
        return f"{hh} households near frequent transit -> {tg.transport_co2(hh, f):.1f} t CO2/yr. {scope_text(ctx)}"

    def embodied_co2_saved() -> str:
        """Embodied carbon saved by converting instead of demolishing and rebuilding, per conversion in the plan
        (pursued or on watch)."""
        convs = {c.building_id: c for c in ctx.plan_parts.get("conversions", [])}
        total = sum(convs[s.building_id].embodied_co2_saved_tonnes or 0 for s in ctx.plan_parts["sites"]
                    if rs.in_plan(s) and s.kind == "conversion" and s.building_id in convs)
        n = sum(1 for s in ctx.plan_parts["sites"] if rs.in_plan(s) and s.kind == "conversion")
        if not n:
            return "The plan has no conversion sites, so reuse saves no embodied carbon (0 t CO2e)."
        return f"{total:.0f} t CO2e saved by {n} conversion sites in the plan. {scope_text(ctx)}"

    def _score() -> list:
        bmap = {b.id: b for b in ctx.plan_parts.get("buildings", [])}
        targets, _ = rs.score_plan(ctx.plan_parts["sites"], ctx.plan_parts["stacks"],
                                   {c.building_id: c for c in ctx.plan_parts.get("conversions", [])},
                                   {k: b.rentable_area_sqft.value for k, b in bmap.items()},
                                   {k: b.roof_area_sqft.value for k, b in bmap.items()},
                                   {p.id: p.area_acres.value for p in ctx.plan_parts["parcels"]},
                                   ctx.pre["walk_m"], ctx.pre["in_flood"], ctx.pre["solar_kwh_per_kw_year"], f)
        return targets

    def rooftop_solar() -> str:
        """Annual rooftop solar (MWh/yr) on the plan's sites from usable roof area and PVWatts output per kW."""
        sol = ctx.resolver.get(loc, Capability.SOLAR)
        kwh = sol.value["annual_kwh_per_kw"] if sol.value else f["solar_kwh_per_kw_year"]
        ctx.pre["solar_kwh_per_kw_year"] = kwh
        mwh = next((t.value for t in _score() if t.key == "rooftop_solar"), None)
        return (f"{mwh:,.1f} MWh/yr of rooftop solar on the plan's sites" if mwh is not None else "solar not scored") \
            + f" ({kwh:,.0f} kWh per kW per year from {'NREL PVWatts' if sol.value else 'the factor fallback'})"

    def walk_access() -> str:
        """Share of new homes within a 10-minute walk of a park, clinic and grocery, and which one is missing most."""
        homes = _homes()
        lacking = tg.walk_gaps(homes, ctx.pre["walk_m"], f)
        return (f"{100 * tg.walk_access(homes, ctx.pre['walk_m'], f):.0f}% of {sum(homes.values()):,} new homes have a "
                f"park, clinic and grocery within a {f['walk_minutes_target']:g}-minute walk; homes beyond that walk "
                f"from a " + ", ".join(f"{k}: {n:,}" for k, n in lacking.items()))

    def flood_exposure() -> str:
        """Share of new homes inside FEMA high-risk flood zones (target 0) and the final target scores."""
        if "solar_kwh_per_kw_year" not in ctx.pre:
            rooftop_solar()
        targets = _score()
        ctx.plan_parts["targets"] = targets
        ctx.step(NAME, "Targets scored", {"targets": {t.key: t.value for t in targets}})
        return f"{100 * tg.flood_exposure(_homes(), ctx.pre['in_flood']):.0f}% of new homes in flood zones (target 0)"

    return [transport_co2, embodied_co2_saved, rooftop_solar, walk_access, flood_exposure]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


LABELS = {"transport_co2": "from transport", "embodied_co2_saved": "embodied carbon saved",
          "rooftop_solar": "rooftop solar", "walk_access": "have a park, clinic and grocery within a {m:g}-minute walk",
          "flood_exposure": "in FEMA high-risk flood zones"}


def scope_text(ctx: RunContext) -> str:
    """Targets count every site in the plan: funded (priced) and on watch; reserve and passed sites are out."""
    sites = [s for s in ctx.plan_parts.get("sites", []) if rs.in_plan(s)]
    watch = sum(1 for s in sites if s.status == "watch")
    return (f"Targets count the {len(sites)} sites in the plan ({watch} on watch: no price, or the owner will not "
            f"sell).")


def explain(ctx: RunContext) -> str:
    t = ctx.plan_parts.get("targets", [])
    if not t:
        return "Targets not scored."
    parts = [f"{x.value:,.1f}".rstrip("0").rstrip(".") + f"{'' if x.unit.startswith('%') else ' '}{x.unit} "
             + LABELS[x.key].format(m=ctx.f["walk_minutes_target"])
             + (f" (target {x.target:g})" if x.target is not None else "") for x in t]
    return f"{scope_text(ctx)} " + "; ".join(parts) + ". Each target lists the factors behind it."
