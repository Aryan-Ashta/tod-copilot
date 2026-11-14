"""7. Funding agent: does each candidate pencil, and which option wins where a parcel has both."""
from backend.agents import common
from backend.agents.context import RunContext
from backend.models import finance
from backend.models.rescore import conversion_pro_forma_for, new_build_stack, parcel_basis
from backend.schemas import CapitalStack

NAME = "funding"
GOAL = "Build a pro forma and capital stack per site; decide new build vs conversion where both exist."


def tools(ctx: RunContext):
    loc, f = ctx.locale, ctx.f

    def pro_forma() -> str:
        """Pro forma per site: new builds use construction cost per unit; conversions use conversion cost per sqft."""
        sites = ctx.plan_parts.get("sites")
        if sites is None or "deals" not in ctx.plan_parts:
            raise ValueError("run land_deal first")
        parcels = ctx.cache["parcels_by_id"]
        bmap = {b.id: b for b in ctx.plan_parts.get("buildings", [])}
        convs = {c.building_id: c for c in ctx.plan_parts.get("conversions", [])}
        res = {}
        for s in sites:
            if s.kind == "new_build":
                r = new_build_stack(s, parcels, f, loc.id)
            else:
                b, c = bmap[s.building_id], convs[s.building_id]
                basis = parcel_basis([parcels[p] for p in s.parcel_ids if p in parcels])
                pf = conversion_pro_forma_for(c.best_use, c.est_units, b.rentable_area_sqft.value,
                                              b.typical_floor_sqft.value, basis, f, loc.id)
                inc = finance.incentive_per_unit(loc.id, f) if c.best_use != "hotel" else 0.0
                r = finance.capital_stack(s.id, pf, f, inc) if pf else None
            res[s.id] = r
        ctx.cache["pro_formas"] = res
        missing = [common.site_label(ctx, k) for k, v in res.items() if v is None]
        lines = [f"{common.site_label(ctx, k)}: cost ${m['total_cost_usd']:,.0f}, stabilized value "
                 f"${m['value_usd']:,.0f} (margin {100 * m['margin']:+.0f}%)" for k, (_, m) in
                 ((k, v) for k, v in res.items() if v is not None)]
        return ("; ".join(lines) or "no pro formas") + \
            (f". Acquisition basis missing for {', '.join(missing)}" if missing else "")

    def capital_stack() -> str:
        """Capital stacks (debt, tax credit equity, incentive, investor equity, gap) and the pencils verdict."""
        res = ctx.cache.get("pro_formas")
        if res is None:
            raise ValueError("run pro_forma first")
        ctx.plan_parts["stacks"] = [r[0] for r in res.values() if r is not None]
        ctx.cache["stack_math"] = {k: r[1] for k, r in res.items() if r is not None}
        yes = sum(1 for s in ctx.plan_parts["stacks"] if s.pencils)
        ctx.step(NAME, f"{yes} of {len(ctx.plan_parts['stacks'])} sites pencil")
        lines = [f"{common.site_label(ctx, s.site_id)}: cost ${s.total_cost_usd:,.0f}, "
                 + ("pencils" if s.pencils else f"gap ${s.gap_usd:,.0f}" + gap_text(s))
                 for s in ctx.plan_parts["stacks"]]
        return f"{yes} of {len(ctx.plan_parts['stacks'])} pencil. " + "; ".join(lines)

    def compare_options() -> str:
        """Where a parcel has both a new build and a conversion, keep the larger value minus cost (ties: conversion);
        then set each site's status: pencils -> pursue, otherwise watch; a 'pass' deal -> watch."""
        if "stacks" not in ctx.plan_parts:
            raise ValueError("run capital_stack first")
        math_ = ctx.cache["stack_math"]
        deals = {d.site_id: d for d in ctx.plan_parts["deals"]}
        stacks = {s.site_id: s for s in ctx.plan_parts["stacks"]}
        sites = ctx.plan_parts["sites"]
        losers, outcomes = set(), []
        for nb in (s for s in sites if s.kind == "new_build"):
            for cv in (s for s in sites if s.kind == "conversion" and set(s.parcel_ids) & set(nb.parcel_ids)):
                if nb.id in math_ and cv.id in math_:
                    win = finance.compare_options(math_[nb.id], math_[cv.id])
                    losers.add(cv.id if win == "new_build" else nb.id)
                    outcomes.append(f"{common.site_label(ctx, nb.id)} new build vs {common.site_label(ctx, cv.id)} "
                                    f"conversion: {win.replace('_', ' ')} wins")
        out = []
        for s in sites:
            if s.id in losers:
                status = "pass"
            elif s.id not in stacks:
                status = "watch"
            elif deals.get(s.id) and deals[s.id].strategy == "pass":
                status = "watch"
            else:
                status = "pursue" if stacks[s.id].pencils else "watch"
            out.append(s.model_copy(update={"status": status}))
        ctx.plan_parts["sites"] = out
        ctx.cache["compare_outcomes"] = outcomes
        st = {k: sum(1 for s in out if s.status == k) for k in ("pursue", "watch", "pass")}
        return ("; ".join(outcomes) or "No parcel has both a new build and a conversion, so each site stands alone") \
            + f". Status: {st['pursue']} pursued (pencil), {st['watch']} on watch (funding gap open)" \
            + (f", {st['pass']} passed" if st["pass"] else "")

    return [pro_forma, capital_stack, compare_options]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def gap_text(s: CapitalStack) -> str:
    """' ($64,000 per home; cost ... vs value ... per home; closes with $64,000 more incentive per home, or rent ...)'."""
    g = s.gap_to_pencil
    if g is None or g.gap_per_home_usd is None:
        return ""
    rent = (f", or rent of ${g.break_even_rent_usd_per_unit_month:,.0f}/mo vs ${g.rent_usd_per_unit_month:,.0f}"
            if g.break_even_rent_usd_per_unit_month is not None else "; rent alone cannot close it (loan-to-cost cap)")
    return (f" (${g.gap_per_home_usd:,.0f} per home; cost ${g.cost_per_home_usd:,.0f} vs value "
            f"${g.value_per_home_usd:,.0f} per home; closes with ${g.gap_per_home_usd:,.0f} more incentive per home"
            f"{rent})")


def explain(ctx: RunContext) -> str:
    stacks = ctx.plan_parts.get("stacks", [])
    sites = ctx.plan_parts.get("sites", [])
    yes = sum(1 for s in stacks if s.pencils)
    pursued = sum(1 for s in sites if s.status == "pursue")
    watched = sum(1 for s in sites if s.status == "watch")
    text = f"{yes} of {len(stacks)} sites pencil; {pursued} pursued and {watched} on watch with a funding gap open."
    open_ = [s for s in stacks if not s.pencils and s.gap_to_pencil and s.gap_to_pencil.gap_per_home_usd is not None]
    if open_:
        best = min(open_, key=lambda s: s.gap_to_pencil.gap_per_home_usd)
        text += f" Closest to pencil: {common.site_label(ctx, best.site_id)}, gap ${best.gap_usd:,.0f}{gap_text(best)}."
    if ctx.locale.id == "houston_downtown":
        text += " Includes the Downtown Living Initiative rebate per home (program status: being shaped, verify)."
    if ctx.cache.get("compare_outcomes"):
        text += " New build vs convert: " + "; ".join(ctx.cache["compare_outcomes"]) + "."
    missing = [s.id for s in sites if s.id not in {x.site_id for x in stacks}]
    if missing:
        text += f" Acquisition basis missing for {len(missing)} sites; they are on watch."
    return text
