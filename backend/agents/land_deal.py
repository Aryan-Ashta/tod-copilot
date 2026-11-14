"""6. Land deal agent: a strategy per pursued site or conversion, with draft letters (nothing is sent)."""
import re
from datetime import date

from backend.agents import common
from backend.agents.context import RunContext
from backend.models.deal import deal_strategy

NAME = "land_deal"
GOAL = "Pick buy, ground lease, joint development with the transit agency, owner partnership or pass for each site."


def tools(ctx: RunContext):
    f = ctx.f

    def deal_strategies() -> str:
        """Apply the land deal decision rules to every site and draft owner letters. Returns strategies by site."""
        sites = ctx.plan_parts.get("sites")
        if sites is None:
            raise ValueError("run site first")
        parcels = ctx.cache["parcels_by_id"]
        bmap = {b.id: b for b in ctx.plan_parts.get("buildings", [])}
        year = date.today().year
        deals = []
        for s in sites:
            p = parcels.get(s.parcel_ids[0]) if s.parcel_ids else None
            b = bmap.get(s.building_id) if s.building_id else None
            deals.append(deal_strategy(s.id, s.kind, p.owner.value if p else None,
                                       p.lease_expiry_year.value if p else None,
                                       b.vacancy_pct.value if b else None,
                                       p.last_sale_year.value if p else None, year, f,
                                       (b.name.value if b and b.name.value else None) or (p.address.value if p else None),
                                       s.homes))
        ctx.plan_parts["deals"] = deals
        ctx.step(NAME, f"{len(deals)} deal strategies drafted")
        factor_ref = re.compile(r"\s*\(factor `[^`]+`\)")
        return "; ".join(f"{common.site_label(ctx, d.site_id)}: {d.strategy.replace('_', ' ')} "
                         f"({factor_ref.sub('', '; '.join(d.reasons))})" for d in deals)

    return [deal_strategies]


def run(ctx: RunContext) -> None:
    tools(ctx)[0]()


def explain(ctx: RunContext) -> str:
    deals = ctx.plan_parts.get("deals", [])
    by: dict[str, int] = {}
    for d in deals:
        by[d.strategy] = by.get(d.strategy, 0) + 1
    unknown = sum(1 for d in deals if "lease status unknown, verify before outreach" in d.reasons)
    return (f"Strategies: {common.counts_text(by)}. Lease status unknown for {unknown} of {len(deals)} sites "
            f"(verify before outreach). Letters are drafts; nothing is sent.")
