"""7. Funding agent: price each candidate, pick the sites that reach the goals, and total the funding they need."""
from backend.agents import common
from backend.agents.context import RunContext
from backend.data.resolver import Capability
from backend.models import finance, goals
from backend.models.rescore import conversion_pro_forma_for, new_build_stack, parcel_basis
from backend.schemas import CapitalStack, ExistingAffordable

NAME = "funding"
GOAL = ("Build a pro forma and capital stack per site, decide new build vs conversion where both exist, and pick the "
        "sites that reach the goals at the smallest funding required.")


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
        """Capital stacks (debt, tax credit equity, incentive, investor equity, funding required) and whether each
        pencils."""
        res = ctx.cache.get("pro_formas")
        if res is None:
            raise ValueError("run pro_forma first")
        ctx.plan_parts["stacks"] = [r[0] for r in res.values() if r is not None]
        ctx.cache["stack_math"] = {k: r[1] for k, r in res.items() if r is not None}
        yes = sum(1 for s in ctx.plan_parts["stacks"] if s.pencils)
        ctx.step(NAME, f"{yes} of {len(ctx.plan_parts['stacks'])} sites pencil")
        lines = [f"{common.site_label(ctx, s.site_id)}: cost ${s.total_cost_usd:,.0f}, "
                 + ("pencils" if s.pencils else f"funding required ${s.funding_required_usd:,.0f}" + gap_text(s))
                 for s in ctx.plan_parts["stacks"]]
        return f"{yes} of {len(ctx.plan_parts['stacks'])} pencil. " + "; ".join(lines)

    def compare_options() -> str:
        """Where a parcel has both a new build and a conversion, keep the larger value minus cost (ties: conversion);
        then set each site's status: priced -> pursue; no price or a 'pass' deal -> watch."""
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
                status = "pursue"
            out.append(s.model_copy(update={"status": status}))
        ctx.plan_parts["sites"] = out
        ctx.cache["compare_outcomes"] = outcomes
        st = {k: sum(1 for s in out if s.status == k) for k in ("pursue", "watch", "pass")}
        return ("; ".join(outcomes) or "No parcel has both a new build and a conversion, so each site stands alone") \
            + f". Status: {st['pursue']} priced, {st['watch']} on watch (no price, or owner will not sell)" \
            + (f", {st['pass']} passed" if st["pass"] else "")

    def fund_goals() -> str:
        """Pick the priced sites that reach the housing goals at the smallest funding required (raising affordable homes
        per site only if every site is in and the goal is still short), then total the funding the goals need."""
        if "stack_math" not in ctx.cache or "sites" not in ctx.plan_parts:
            raise ValueError("run compare_options first")
        g = ctx.options.goals
        sites = ctx.plan_parts["sites"]
        math_ = ctx.cache["stack_math"]
        cands = [(s, math_[s.id]) for s in sites if s.status == "pursue" and s.id in math_]
        sel = goals.select_sites(cands, g, f)
        if sel.restacked:
            ctx.plan_parts["stacks"] = [sel.restacked[x.site_id][0] if x.site_id in sel.restacked else x
                                        for x in ctx.plan_parts["stacks"]]
            math_.update({k: v[1] for k, v in sel.restacked.items()})
        chosen = set(sel.selected)
        sites = [s.model_copy(update={"status": "reserve"}) if s.status == "pursue" and s.id not in chosen else s
                 for s in sites]
        ctx.plan_parts["sites"] = sites
        inv = ctx.cache.get("layers", {}).get(Capability.AFFORDABLE_INVENTORY)
        existing, no_li = None, 0
        if inv is not None and inv.prov.confidence != "missing":
            hud = [x for x in ctx.plan_parts.get("infrastructure", []) if x.kind == "affordable_housing"]
            no_li = sum(1 for x in hud if x.attrs.get("li_units") is None)
            existing = ExistingAffordable(properties=len(hud),
                                          affordable_homes=sum(int(x.attrs.get("li_units") or 0) for x in hud),
                                          total_homes=sum(int(x.attrs.get("units") or 0) for x in hud), prov=inv.prov)
        rep = goals.report(sites, ctx.plan_parts["stacks"], g, ctx.plan_parts.get("transit"), existing)
        units = {x.site_id: x.units for x in ctx.plan_parts["stacks"]}
        rep.notes += [f"{common.site_label(ctx, sid)}: affordable homes raised from {old} to {new} of {units[sid]}"
                      for sid, (old, new) in sel.raised.items()]
        if no_li:
            rep.notes.append(f"{no_li} HUD LIHTC properties report no low-income unit count")
        ctx.plan_parts["goals_report"] = rep
        ctx.step(NAME, f"{rep.sites_funded} sites funded; housing funding required "
                       f"${rep.housing_funding_required_usd:,.0f}")
        rows = [f"{r.key.replace('_', ' ')}: {r.achieved:,g} {r.unit}"
                + ("" if r.goal is None else f" of a {r.goal:,g} goal ({'met' if r.met else 'short'})")
                for r in rep.goals]
        return ("; ".join(rows) + f". {rep.sites_funded} sites funded: one-time housing funding required "
                f"${rep.housing_funding_required_usd:,.0f} after ${rep.tax_credit_equity_usd:,.0f} tax credit equity and "
                f"${rep.incentive_usd:,.0f} incentives (total cost ${rep.total_cost_usd:,.0f}); transit operating "
                f"funding ${rep.transit_operating_usd_per_year:,.0f}/yr. " + " ".join(rep.notes)).strip()

    return [pro_forma, capital_stack, compare_options, fund_goals]


def run(ctx: RunContext) -> None:
    for t in tools(ctx):
        t()


def gap_text(s: CapitalStack) -> str:
    """' ($64,000 per home; cost ... vs value ... per home; covered by $64,000 more incentive per home, or rent ...)'."""
    g = s.gap_to_pencil
    if g is None or g.funding_required_per_home_usd is None:
        return ""
    rent = (f", or rent of ${g.break_even_rent_usd_per_unit_month:,.0f}/mo vs ${g.rent_usd_per_unit_month:,.0f}"
            if g.break_even_rent_usd_per_unit_month is not None else "; rent alone cannot cover it (loan-to-cost cap)")
    return (f" (${g.funding_required_per_home_usd:,.0f} per home; cost ${g.cost_per_home_usd:,.0f} vs value "
            f"${g.value_per_home_usd:,.0f} per home; covered by ${g.funding_required_per_home_usd:,.0f} more incentive "
            f"per home"
            f"{rent})")


def explain(ctx: RunContext) -> str:
    stacks = ctx.plan_parts.get("stacks", [])
    sites = ctx.plan_parts.get("sites", [])
    rep = ctx.plan_parts.get("goals_report")
    funded = {s.id for s in sites if s.status == "pursue"}
    fs = [x for x in stacks if x.site_id in funded]
    homes = sum(x.units for x in fs)
    aff = sum(x.affordable_units for x in fs)
    required = sum(max(x.funding_required_usd, 0.0) for x in fs)
    tc = sum(x.tax_credit_equity_usd for x in fs)
    text = (f"{len(fs)} sites funded: {homes:,} homes, {aff:,} affordable; one-time funding required ${required:,.0f} "
            f"after ${tc:,.0f} tax credit equity.")
    if rep is not None:
        unmet = sum(1 for r in rep.goals if r.met is False)
        text += "".join(f" {n[0].upper() + n[1:]}." for n in rep.notes[:unmet])
    if ctx.locale.id == "houston_downtown":
        text += " Includes the Downtown Living Initiative rebate per home (program status: being shaped, verify)."
    if ctx.cache.get("compare_outcomes"):
        text += " New build vs convert: " + "; ".join(ctx.cache["compare_outcomes"]) + "."
    watched = sum(1 for s in sites if s.status == "watch")
    if watched:
        text += f" {watched} sites on watch (no price, or owner will not sell)."
    reserve = sum(1 for s in sites if s.status == "reserve")
    if reserve:
        text += f" {reserve} more priced sites held in reserve."
    return text
