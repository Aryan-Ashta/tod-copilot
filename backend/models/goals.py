"""Goal-driven site selection and the funding report. Pure: priced sites + goals -> which sites and what funding.

Sites are added in order of cheapest funding required per goal unit. A site's surplus never offsets the funding another
site requires (no cross-subsidy). If every affordable-capable site is in and the affordable goal is still short, the
affordable count per site is raised (up to all its homes) in order of cheapest marginal funding required.
"""
from typing import NamedTuple, Optional

from backend.models import finance
from backend.schemas import CapitalStack, ExistingAffordable, GoalProgress, GoalReport, PlanGoals, Site, TransitPlan


def need(m: dict) -> float:
    """Funding a site requires: its positive funding_required_usd."""
    return max(m["funding_required_usd"], 0.0)


class Selection(NamedTuple):
    selected: list[str]                                  # site ids in pick order
    restacked: dict[str, tuple[CapitalStack, dict]]     # sites whose affordable count was raised
    raised: dict[str, tuple[int, int]]                   # site id -> (old, new) affordable count


def select_sites(cands: list[tuple[Site, dict]], goals: PlanGoals, f: dict) -> Selection:
    """cands: (site, stack math from finance.capital_stack)."""
    if not goals.housing():
        return Selection([s.id for s, _ in cands], {}, {})
    selected: list[str] = []
    chosen: dict[str, tuple[Site, dict]] = {}

    def take(s: Site, m: dict) -> None:
        selected.append(s.id)
        chosen[s.id] = (s, m)

    def remaining():
        return [(s, m) for s, m in cands if s.id not in chosen]

    def aff_sum() -> int:
        return sum(m["affordable_units"] for _, m in chosen.values())

    if goals.conversions is not None:
        for s, m in sorted((c for c in remaining() if c[0].kind == "conversion"), key=lambda c: (need(c[1]), c[0].id)):
            if sum(1 for x, _ in chosen.values() if x.kind == "conversion") >= goals.conversions:
                break
            take(s, m)
    if goals.affordable_homes is not None:
        pool = [c for c in remaining() if c[1]["affordable_units"] > 0]
        pool.sort(key=lambda c: (need(c[1]) / c[1]["affordable_units"], -c[1]["affordable_units"], c[0].id))
        for s, m in pool:
            if aff_sum() >= goals.affordable_homes:
                break
            take(s, m)
    if goals.total_homes is not None:
        pool = [c for c in remaining() if c[0].homes > 0]
        pool.sort(key=lambda c: (need(c[1]) / c[0].homes, c[0].id))
        for s, m in pool:
            if sum(x.homes for x, _ in chosen.values()) >= goals.total_homes:
                break
            take(s, m)
    restacked: dict[str, tuple[CapitalStack, dict]] = {}
    raised: dict[str, tuple[int, int]] = {}
    if goals.affordable_homes is not None and aff_sum() < goals.affordable_homes:
        short = goals.affordable_homes - aff_sum()
        ranked = []
        for sid in selected:
            m = chosen[sid][1]
            aff = m["affordable_units"]
            if m["units"] <= aff:
                continue
            full = finance.capital_stack(sid, finance.with_affordable(m, m["units"], f), f,
                                         m["incentive_per_unit_usd"])[1]
            ranked.append(((need(full) - need(m)) / (m["units"] - aff), sid))
        for _, sid in sorted(ranked):
            if short <= 0:
                break
            m = chosen[sid][1]
            aff = m["affordable_units"]
            add = min(short, m["units"] - aff)
            restacked[sid] = finance.capital_stack(sid, finance.with_affordable(m, aff + add, f), f,
                                                   m["incentive_per_unit_usd"])
            raised[sid] = (aff, aff + add)
            short -= add
    return Selection(selected, restacked, raised)


LABELS = {"affordable_homes": "affordable homes", "total_homes": "homes", "conversions": "building conversions",
          "transit_coverage": "frequent-transit coverage"}


def report(sites: list[Site], stacks: list[CapitalStack], goals: PlanGoals, transit: Optional[TransitPlan],
           existing: Optional[ExistingAffordable]) -> GoalReport:
    by_id = {x.site_id: x for x in stacks}
    funded = [(s, by_id[s.id]) for s in sites if s.status == "pursue" and s.id in by_id]
    rows = [("affordable_homes", goals.affordable_homes, sum(x.affordable_units for _, x in funded), "homes"),
            ("total_homes", goals.total_homes, sum(s.homes for s, _ in funded), "homes"),
            ("conversions", goals.conversions, sum(1 for s, _ in funded if s.kind == "conversion"), "buildings")]
    if transit is not None:
        rows.append(("transit_coverage", transit.coverage_goal_pct, transit.coverage_pct, "% of demand"))
    progress, notes = [], []
    for key, goal, achieved, unit in rows:
        met = None if goal is None else achieved >= goal
        progress.append(GoalProgress(key=key, goal=None if goal is None else float(goal), achieved=float(achieved),
                                     unit=unit, met=met))
        if met is False:
            if key == "transit_coverage":
                notes.append(f"{LABELS[key]} goal {goal:,g}% of demand: {achieved:,g}% reached with every candidate route")
            else:
                notes.append(f"{LABELS[key]} goal {goal:,g}: {achieved:,g} reached with every priced candidate site")
    return GoalReport(
        goals=progress, sites_funded=len(funded),
        total_cost_usd=round(sum(x.total_cost_usd for _, x in funded), 2),
        housing_funding_required_usd=round(sum(max(x.funding_required_usd, 0.0) for _, x in funded), 2),
        tax_credit_equity_usd=round(sum(x.tax_credit_equity_usd for _, x in funded), 2),
        incentive_usd=round(sum(x.incentive_usd for _, x in funded), 2),
        transit_operating_usd_per_year=round(transit.annual_operating_cost_usd, 2) if transit else 0.0,
        existing_affordable=existing, notes=notes)
