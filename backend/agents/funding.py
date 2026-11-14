"""7. Funding agent: does each candidate pencil, and which option wins where a parcel has both."""
from backend.agents.context import RunContext
from backend.models import finance
from backend.models.rescore import conversion_pro_forma_for, new_build_stack, parcel_basis

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
        missing = [k for k, v in res.items() if v is None]
        return f"{len(res) - len(missing)} pro formas; acquisition basis missing for {missing or 'none'}"

    def capital_stack() -> str:
        """Capital stacks (debt, tax credit equity, incentive, investor equity, gap) and the pencils verdict."""
        res = ctx.cache.get("pro_formas")
        if res is None:
            raise ValueError("run pro_forma first")
        ctx.plan_parts["stacks"] = [r[0] for r in res.values() if r is not None]
        ctx.cache["stack_math"] = {k: r[1] for k, r in res.items() if r is not None}
        yes = sum(1 for s in ctx.plan_parts["stacks"] if s.pencils)
        ctx.step(NAME, f"{yes} of {len(ctx.plan_parts['stacks'])} sites pencil")
        return f"{yes} of {len(ctx.plan_parts['stacks'])} pencil"

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
                    outcomes.append(f"{nb.id} vs {cv.id}: {win}")
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
        return "; ".join(outcomes) or "no parcel has both options"

    return [pro_forma, capital_stack, compare_options]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def explain(ctx: RunContext) -> str:
    stacks = ctx.plan_parts.get("stacks", [])
    sites = ctx.plan_parts.get("sites", [])
    yes = sum(1 for s in stacks if s.pencils)
    text = (f"{yes} of {len(stacks)} sites pencil; {sum(1 for s in sites if s.status == 'pursue')} pursued. "
            f"Conversions use conversion cost per sqft.")
    if ctx.locale.id == "houston_downtown":
        text += " Includes the downtown per-unit incentive factor (program status: being shaped, verify)."
    if ctx.cache.get("compare_outcomes"):
        text += " New build vs convert: " + "; ".join(ctx.cache["compare_outcomes"]) + "."
    missing = [s.id for s in sites if s.id not in {x.site_id for x in stacks}]
    if missing:
        text += f" Acquisition basis missing for {len(missing)} sites; they are on watch."
    return text
