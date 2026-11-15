"""QA: finance on the three demo locales. Pro formas, capital stacks, the goals report and the scoreboard's
affordable homes / funding required, on the agents' plans and after meeting-mode edits.

Assertions are directions and relationships, not pinned values. Failing invariants are marked
xfail(strict=True) with a QA-FIN id; findings are in the QA report (qa-finance.md)."""
import math

import pytest

from backend.data.factors import resolve
from backend.models import finance, goals
from backend.models.rescore import conversion_pro_forma_for, new_build_stack, parcel_basis, rescore
from backend.schemas import CapitalStack, DealStrategy, Edit, GoalReport, PlanGoals, Site

HOU, LA, BRE = "houston_downtown", "la_wilshire_koreatown", "brevard_cocoa"
LOCALES = [HOU, LA, BRE]
CENT = 0.05          # stack fields are rounded to cents; a sum of five rounded fields is off by at most 2.5 cents

# Demo targets (ids from the locales' own data).
EDITS = {   # a mix of edits per locale: tiles on priced parcels/buildings plus the slider
    HOU: [Edit(kind="place_tile", tile="convert_hotel", target_id="osm:510323326"),
          Edit(kind="place_tile", tile="homes", target_id="1372200010001"),
          Edit(kind="slider", value=0.5)],
    LA: [Edit(kind="place_tile", tile="homes", target_id="5094002019"), Edit(kind="slider", value=0.5)],
    BRE: [Edit(kind="place_tile", tile="homes", target_id="24 3620-00-2"),
          Edit(kind="place_tile", tile="convert_residential", target_id="osm:217382160"),
          Edit(kind="slider", value=0.5)],
}
NO_BASIS_PARCEL = {HOU: "1499920010001", LA: "5503025129"}   # homes-eligible, no last sale and no assessed value


def _tile(tile: str, target: str) -> Edit:
    return Edit(kind="place_tile", tile=tile, target_id=target)


def _after(plan, f, edits):
    """rescore, with the patch parsed back into schema objects."""
    r = rescore(plan, edits, f)
    pp = r.plan_patch
    convs = ({c["building_id"]: c["best_use"] for c in pp["conversions"]} if "conversions" in pp
             else {c.building_id: c.best_use for c in plan.conversions})
    return (r, [Site.model_validate(s) for s in pp["sites"]], [CapitalStack.model_validate(x) for x in pp["stacks"]],
            [DealStrategy.model_validate(d) for d in pp["deals"]], convs, GoalReport.model_validate(pp["goals_report"]))


def _math(plan, f, site):
    """A site's (stack, math) the way the funding agent prices it."""
    parcels = {p.id: p for p in plan.parcels}
    lid = plan.locale.id
    if site.kind == "new_build":
        return new_build_stack(site, parcels, f, lid)
    b = next(x for x in plan.buildings if x.id == site.building_id)
    c = next(x for x in plan.conversions if x.building_id == site.building_id)
    basis = parcel_basis([parcels[p] for p in site.parcel_ids if p in parcels])
    pf = conversion_pro_forma_for(c.best_use, c.est_units, b.rentable_area_sqft.value, b.typical_floor_sqft.value,
                                  basis, f, lid)
    if pf is None:
        return None
    return finance.capital_stack(site.id, pf, f, finance.incentive_per_unit(lid, f) if c.best_use != "hotel" else 0.0)


def _land(plan, f, site: Site, stack: CapitalStack, best_use: str) -> float:
    """The acquisition part of a stack's total cost: total minus construction (new build) or conversion cost."""
    if site.kind == "new_build":
        return stack.total_cost_usd - stack.units * f["construction_cost_usd_per_unit"]
    b = next(x for x in plan.buildings if x.id == site.building_id)
    key = "hotel_conversion_cost_usd_per_sqft" if best_use == "hotel" else "conversion_cost_usd_per_sqft"
    return stack.total_cost_usd - b.rentable_area_sqft.value * f[key]


def _basis(parcel) -> float:
    return finance.acquisition_basis(parcel.last_sale_usd.value, parcel.assessed_value_usd.value)


def _check_stack(x: CapitalStack) -> None:
    vals = [x.total_cost_usd, x.debt_usd, x.tax_credit_equity_usd, x.incentive_usd, x.investor_equity_usd,
            x.funding_required_usd]
    assert all(math.isfinite(v) for v in vals), x.site_id
    assert x.total_cost_usd > 0 and min(vals[1:5]) >= 0, x.site_id
    sources = x.debt_usd + x.tax_credit_equity_usd + x.incentive_usd + x.investor_equity_usd
    assert abs(sources + x.funding_required_usd - x.total_cost_usd) <= CENT, x.site_id
    assert x.pencils == (x.funding_required_usd <= 0), x.site_id
    assert (x.gap_to_pencil is not None) == (x.funding_required_usd > 0), x.site_id
    assert 0 <= x.affordable_units <= x.units, x.site_id


# ---------------------------------------------------------------- capital stacks: conservation, bounds, units


@pytest.mark.parametrize("lid", LOCALES)
def test_stack_sources_plus_funding_required_equal_total_cost(plans, lid):
    p, f = plans(lid), resolve(lid)
    assert p.stacks
    for x in p.stacks:
        _check_stack(x)
    _, _, stacks, *_ = _after(p, f, EDITS[lid])
    for x in stacks:
        _check_stack(x)


@pytest.mark.parametrize("lid", LOCALES)
def test_stack_homes_match_site_homes_and_affordable_share(plans, lid):
    """No goals in the demo prompt, so every stack carries floor(units x affordable_share) affordable homes."""
    p, f = plans(lid), resolve(lid)
    sites = {s.id: s for s in p.sites}
    for x in p.stacks:
        assert x.units == sites[x.site_id].homes, x.site_id
        assert x.affordable_units == math.floor(x.units * f["affordable_share"]), x.site_id


@pytest.mark.parametrize("lid", LOCALES)
def test_stack_lines_are_per_unit_and_per_sqft_factors_times_quantities(plans, lid):
    """USD/unit factors x homes, USD/sqft x rentable sqft, USD/affordable unit x affordable homes; land = parcel basis."""
    p, f = plans(lid), resolve(lid)
    parcels = {x.id: x for x in p.parcels}
    buildings = {b.id: b for b in p.buildings}
    convs = {c.building_id: c for c in p.conversions}
    inc = finance.incentive_per_unit(lid, f)
    for x in p.stacks:
        s = next(s for s in p.sites if s.id == x.site_id)
        use = convs[s.building_id].best_use if s.kind == "conversion" else "new_build"
        basis = parcel_basis([parcels[q] for q in s.parcel_ids if q in parcels])
        if s.kind == "new_build":
            hard = x.units * f["construction_cost_usd_per_unit"]
        else:
            key = "hotel_conversion_cost_usd_per_sqft" if use == "hotel" else "conversion_cost_usd_per_sqft"
            hard = buildings[s.building_id].rentable_area_sqft.value * f[key]
        assert x.total_cost_usd == pytest.approx(basis + hard, abs=CENT), x.site_id
        assert x.tax_credit_equity_usd == pytest.approx(x.affordable_units * f["per_unit_credit_equity_usd"], abs=CENT)
        assert x.investor_equity_usd == pytest.approx(f["investor_equity_share"] * x.total_cost_usd, abs=CENT)
        assert x.incentive_usd == pytest.approx(x.units * (0.0 if use == "hotel" else inc), abs=CENT), x.site_id
        assert x.debt_usd <= f["debt_ratio"] * x.total_cost_usd + CENT


@pytest.mark.parametrize("lid", LOCALES)
def test_gap_to_pencil_levers_close_the_gap_on_demo_sites(plans, lid):
    """The per-home figure x homes is the funding required; the quoted break-even rent really closes it."""
    p, f = plans(lid), resolve(lid)
    for s in p.sites:
        res = _math(p, f, s)
        if res is None:
            continue
        x, m = res
        g = x.gap_to_pencil
        if g is None:
            continue
        if x.units:
            assert g.funding_required_per_home_usd * x.units == pytest.approx(x.funding_required_usd, abs=x.units * 0.005 + CENT)
            assert g.cost_per_home_usd * x.units == pytest.approx(x.total_cost_usd, abs=x.units * 0.005 + CENT)
        be = g.break_even_rent_usd_per_unit_month
        if be is None:   # documented reason: the loan-to-cost cap binds before value
            need_debt = m["total_cost_usd"] - m["incentive_usd"] - m["tax_credit_equity_usd"] - m["investor_equity_usd"]
            assert need_debt > f["debt_ratio"] * m["total_cost_usd"], s.id
            continue
        assert be > f["rent_usd_per_unit_month"], s.id
        _, m2 = _math(p, {**f, "rent_usd_per_unit_month": be}, s)
        assert abs(m2["funding_required_usd"]) < 1.0, (s.id, m2["funding_required_usd"])


# ---------------------------------------------------------------- incentive (Houston Downtown Living Initiative)


@pytest.mark.parametrize("lid", LOCALES)
def test_houston_incentive_only_in_houston_and_lowers_the_gap_by_units_times_rebate(plans, lid):
    p, f = plans(lid), resolve(lid)
    inc = finance.incentive_per_unit(lid, f)
    assert (inc > 0) == (lid == HOU)
    for s in p.sites:
        res = _math(p, f, s)
        if res is None:
            continue
        _, m = res
        without = finance.capital_stack(s.id, m, f, 0.0)[1]["funding_required_usd"]
        assert without - m["funding_required_usd"] == pytest.approx(m["units"] * m["incentive_per_unit_usd"], abs=CENT)
        if lid == HOU and m["units"]:
            assert without > m["funding_required_usd"], s.id


def test_hotel_conversion_gets_no_housing_incentive_homes_or_tax_credit(plans):
    p, f = plans(HOU), resolve(HOU)
    site = next(s for s in p.sites if s.id == "conv-osm:510323326")
    before = next(x for x in p.stacks if x.site_id == site.id)
    r, sites, stacks, _, _, gr = _after(p, f, [_tile("convert_hotel", "osm:510323326")])
    hotel = next(x for x in stacks if x.site_id == site.id)
    assert (hotel.units, hotel.affordable_units, hotel.incentive_usd, hotel.tax_credit_equity_usd) == (0, 0, 0.0, 0.0)
    assert next(s for s in sites if s.id == site.id).homes == 0
    assert r.deltas["homes"] == -site.homes
    assert r.deltas["affordable_homes"] == -before.affordable_units
    assert gr.incentive_usd == pytest.approx(p.goals_report.incentive_usd - before.incentive_usd, abs=CENT)


# ---------------------------------------------------------------- scoreboard vs goals report


@pytest.mark.parametrize("lid,case", [(lid, case) for lid in LOCALES for case in ("agents", "edits")]
                         + [(lid, "no_basis_tile") for lid in NO_BASIS_PARCEL])
def test_scoreboard_agrees_with_goals_report(plans, lid, case):
    """Affordable homes and funding: same funded (pursue) sites. Homes: the scoreboard also counts watch sites
    (docs/05), so it exceeds the report's homes by exactly the watch sites' homes."""
    p, f = plans(lid), resolve(lid)
    edits = {"agents": [], "edits": EDITS[lid],
             "no_basis_tile": [_tile("homes", NO_BASIS_PARCEL.get(lid, ""))]}[case]
    r, sites, stacks, _, _, gr = _after(p, f, edits)
    sb = r.scoreboard
    achieved = {g.key: g.achieved for g in gr.goals}
    funded = {s.id for s in sites if s.status == "pursue"}
    fs = [x for x in stacks if x.site_id in funded]
    assert sb.affordable_homes == achieved["affordable_homes"] == sum(x.affordable_units for x in fs)
    assert sb.funding_required_usd == pytest.approx(gr.housing_funding_required_usd, abs=0.01)
    assert sb.funding_required_usd == pytest.approx(sum(max(x.funding_required_usd, 0.0) for x in fs), abs=0.01)
    assert gr.sites_funded == len(fs)
    assert gr.total_cost_usd == pytest.approx(sum(x.total_cost_usd for x in fs), abs=0.01)
    watch_homes = sum(s.homes for s in sites if s.status == "watch")
    assert sb.homes == achieved["total_homes"] + watch_homes
    assert 0 <= sb.affordable_homes <= sb.homes and sb.funding_required_usd >= 0


@pytest.mark.parametrize("lid", LOCALES)
def test_rescore_without_edits_reproduces_the_plans_funding_numbers(plans, lid):
    p, f = plans(lid), resolve(lid)
    r, _, stacks, _, _, gr = _after(p, f, [])
    base = p.goals_report.model_dump(exclude={"notes"})
    assert gr.model_dump(exclude={"notes"}) == base
    assert [x.model_dump() for x in stacks] == [x.model_dump() for x in p.stacks]
    assert all(v == 0 for v in r.deltas.values())


@pytest.mark.parametrize("lid", [HOU, BRE])
@pytest.mark.xfail(strict=True, reason="QA-FIN-6: rescore's goals report drops the plan's HUD 'no low-income unit "
                                       "count' note")
def test_rescore_without_edits_keeps_the_goals_report_notes(plans, lid):
    p, f = plans(lid), resolve(lid)
    *_, gr = _after(p, f, [])
    assert gr.notes == p.goals_report.notes


@pytest.mark.parametrize("lid", ["houston_downtown", "la_wilshire_koreatown"])
def test_site_without_acquisition_basis_is_watch_counted_in_homes_not_in_funding(plans, lid):
    """docs/05: watch sites count toward homes ('if all N candidate sites proceed'), not toward funding."""
    p, f = plans(lid), resolve(lid)
    parcel = next(x for x in p.parcels if x.id == NO_BASIS_PARCEL[lid])
    assert _basis(parcel) is None
    r, sites, stacks, *_ = _after(p, f, [_tile("homes", parcel.id)])
    site = next(s for s in sites if s.id == f"tile-{parcel.id}")
    assert site.status == "watch" and site.homes > 0
    assert all(x.site_id != site.id for x in stacks)
    assert r.deltas["homes"] == site.homes
    assert r.deltas["affordable_homes"] == 0 and r.deltas["funding_required_usd"] == 0


# ---------------------------------------------------------------- edits move funding the expected way


@pytest.mark.parametrize("lid", LOCALES)
def test_slider_trades_homes_for_green_space_and_funding_never_rises(plans, lid):
    p, f = plans(lid), resolve(lid)
    base = rescore(p, [], f).scoreboard
    boards = [rescore(p, [Edit(kind="slider", value=v)], f).scoreboard for v in (0.0, 0.25, 0.5, 0.75, 1.0)]
    assert boards[0].homes == base.homes and boards[0].funding_required_usd == base.funding_required_usd
    for a, b in zip(boards, boards[1:]):
        assert b.homes <= a.homes
        assert b.funding_required_usd <= a.funding_required_usd + 0.01
    assert boards[-1].homes < boards[0].homes
    assert boards[-1].funding_required_usd < boards[0].funding_required_usd
    for b in boards:
        assert 0 <= b.affordable_homes <= b.homes and b.funding_required_usd >= 0
    _, _, stacks, *_ = _after(p, f, [Edit(kind="slider", value=1.0)])
    for x in stacks:
        _check_stack(x)


@pytest.mark.parametrize("lid,parcel", [(HOU, "1372200010001"), (LA, "5094002019"), (BRE, "24 3620-00-2")])
def test_homes_tile_on_priced_parcel_adds_its_stack_and_remove_restores(plans, lid, parcel):
    p, f = plans(lid), resolve(lid)
    r, sites, stacks, *_ = _after(p, f, [_tile("homes", parcel)])
    site = next(s for s in sites if s.id == f"tile-{parcel}")
    x = next(x for x in stacks if x.site_id == site.id)
    assert site.status == "pursue" and x.units == site.homes > 0
    assert r.deltas["homes"] == site.homes
    assert r.deltas["affordable_homes"] == x.affordable_units
    assert r.deltas["funding_required_usd"] == pytest.approx(max(x.funding_required_usd, 0.0), abs=0.01)
    undone = rescore(p, [_tile("homes", parcel), Edit(kind="remove_tile", target_id=parcel)], f)
    assert all(v == 0 for v in undone.deltas.values())


@pytest.mark.parametrize("lid,edit", [
    (HOU, _tile("homes", "0010950000001")),                 # the agents' own new build parcel
    (HOU, _tile("convert_residential", "osm:510323326")),   # the agents' own residential conversion
    (LA, _tile("convert_residential", "osm:427462762")),
    (BRE, _tile("homes", "24 3618-00-765")),
])
def test_placing_the_agents_own_choice_changes_no_number(plans, lid, edit):
    p, f = plans(lid), resolve(lid)
    r = rescore(p, [edit], f)
    assert r.rejected is None
    assert all(v == 0 for v in r.deltas.values()), r.deltas


@pytest.mark.parametrize("lid,parcel", [(HOU, "0010180000001"), (BRE, "24 3630-00-256")])
def test_homes_tile_in_flood_zone_is_rejected_and_funding_unchanged(plans, lid, parcel):
    p, f = plans(lid), resolve(lid)
    assert p.precomputed.in_flood.get(parcel)
    r = rescore(p, [_tile("homes", parcel)], f)
    assert r.rejected is not None
    assert r.scoreboard == rescore(p, [], f).scoreboard


# ---------------------------------------------------------------- status, deals, acquisition basis


@pytest.mark.parametrize("lid", LOCALES)
def test_agents_site_status_follows_price_and_deal(plans, lid):
    """Agents' rule (funding.compare_options): priced and not a 'pass' deal -> pursue; otherwise watch."""
    p = plans(lid)
    priced = {x.site_id for x in p.stacks}
    deals = {d.site_id: d.strategy for d in p.deals}
    for s in p.sites:
        if s.status == "pursue":
            assert s.id in priced and deals.get(s.id) != "pass", s.id
        elif s.status == "watch":
            assert s.id not in priced or deals.get(s.id) == "pass", s.id


@pytest.mark.parametrize("lid,edit", [(HOU, _tile("convert_residential", "osm:470281208")),
                                      (HOU, _tile("homes", "0020380000001"))])
@pytest.mark.xfail(strict=True, reason="QA-FIN-2: meeting-mode tiles pursue and fund a site whose deal is 'pass' "
                                       "(active lease); the agents put such sites on watch")
def test_tile_on_a_pass_deal_is_not_funded(plans, lid, edit):
    p, f = plans(lid), resolve(lid)
    r, sites, _, deals, _, _ = _after(p, f, [edit])
    strategy = {d.site_id: d.strategy for d in deals}
    assert all(strategy.get(s.id) != "pass" for s in sites if s.status == "pursue")
    if edit.tile == "convert_residential":   # the agents' own use for this building: nothing should move
        assert r.deltas["funding_required_usd"] == 0 and r.deltas["affordable_homes"] == 0


def test_acquisition_basis_prefers_sale_then_assessed_and_missing_is_none():
    assert finance.acquisition_basis(None, None) is None
    assert finance.acquisition_basis(None, 5.0) == 5.0
    assert finance.acquisition_basis(7.0, 5.0) == 7.0


@pytest.mark.xfail(strict=True, reason="QA-FIN-1: a $0 assessed value (exempt/unvalued parcel) is used as a $0 "
                                       "acquisition basis instead of missing")
def test_zero_assessed_value_is_missing_not_free_land():
    assert finance.acquisition_basis(None, 0.0) is None


@pytest.mark.parametrize("lid,parcel", [(HOU, None), (HOU, "0300920000010"), (BRE, "24 3618-00-10")])
@pytest.mark.xfail(strict=True, reason="QA-FIN-1: pursued new builds priced with $0 land (HCAD/Brevard $0 "
                                       "assessed value read as a price)")
def test_pursued_new_build_never_gets_free_land(plans, lid, parcel):
    p, f = plans(lid), resolve(lid)
    _, sites, stacks, *_ = _after(p, f, [_tile("homes", parcel)] if parcel else [])
    by = {x.site_id: x for x in stacks}
    checked = [s for s in sites if s.kind == "new_build" and (parcel is None or s.id == f"tile-{parcel}")]
    assert checked
    for s in checked:
        if s.status == "pursue":   # a parcel without a basis goes on watch instead
            assert _land(p, f, s, by[s.id], "new_build") > 0, s.id


@pytest.mark.parametrize("lid", LOCALES)
def test_agents_plan_pays_for_each_parcel_once(plans, lid):
    p, f = plans(lid), resolve(lid)
    _assert_parcels_paid_once(p, f, [])


@pytest.mark.parametrize("lid,building", [(HOU, "osm:54358538"),    # 2nd building on the parcel of conv-osm:510323326
                                          (LA, "osm:427462795"),     # 2nd building on the parcel of conv-osm:427462762
                                          (LA, "osm:402036180")])    # building on the agents' new build site-5093026038
@pytest.mark.xfail(strict=True, reason="QA-FIN-3: a conversion tile on a parcel that already holds a pursued site "
                                       "charges the parcel's full acquisition basis a second time")
def test_conversion_tile_does_not_buy_the_same_parcel_twice(plans, lid, building):
    p, f = plans(lid), resolve(lid)
    _assert_parcels_paid_once(p, f, [_tile("convert_residential", building)])


def _assert_parcels_paid_once(p, f, edits):
    _, sites, stacks, _, convs, _ = _after(p, f, edits)
    parcels = {x.id: x for x in p.parcels}
    by = {x.site_id: x for x in stacks}
    pursued = [s for s in sites if s.status == "pursue" and s.id in by]
    charged = sum(_land(p, f, s, by[s.id], convs.get(s.building_id, "new_build")) for s in pursued)
    covered = {q for s in pursued for q in s.parcel_ids}
    worth = sum(_basis(parcels[q]) or 0.0 for q in covered if q in parcels)
    assert charged <= worth + CENT * len(pursued), (charged, worth)


# ---------------------------------------------------------------- conversions: hotel keys, zero-home conversions


@pytest.mark.xfail(strict=True, reason="QA-FIN-4: hotel keys apply the residential net/gross efficiency to "
                                       "hotel_key_sqft, which is already gross sqft per key (25% fewer keys)")
def test_hotel_keys_use_gross_sqft_per_key(plans):
    p, f = plans(HOU), resolve(HOU)
    b = next(x for x in p.buildings if x.id == "osm:510323326")
    parcel = next(x for x in p.parcels if x.id == b.parcel_id)
    rentable = b.rentable_area_sqft.value
    pf = conversion_pro_forma_for("hotel", 501, rentable, b.typical_floor_sqft.value, _basis(parcel), f, HOU)
    assert pf["value_usd"] == pytest.approx(rentable / f["hotel_key_sqft"] * f["hotel_value_usd_per_key"], rel=1e-9)


@pytest.mark.xfail(strict=True, reason="QA-FIN-5: a residential conversion that yields 0 homes is accepted and its "
                                       "cost added to funding required")
def test_residential_conversion_with_no_homes_adds_no_funding(plans):
    p, f = plans(BRE), resolve(BRE)
    c = next(x for x in p.conversions if x.building_id == "osm:909804874")
    assert c.est_units == 0 and c.scores_by_use["residential"].legal > 0
    r = rescore(p, [_tile("convert_residential", c.building_id)], f)
    assert r.rejected is not None or (r.deltas["homes"] == 0 and r.deltas["funding_required_usd"] == 0)


# ---------------------------------------------------------------- goals


def _goal_plan(p, f, g: PlanGoals):
    """The funding agent's fund_goals on the agents' priced sites: select, restack raised sites, reserve the rest."""
    cands = [(s, _math(p, f, s)[1]) for s in p.sites if s.status == "pursue"]
    sel = goals.select_sites(cands, g, f)
    stacks = [sel.restacked[x.site_id][0] if x.site_id in sel.restacked else x for x in p.stacks]
    chosen = set(sel.selected)
    sites = [s.model_copy(update={"status": "reserve"}) if s.status == "pursue" and s.id not in chosen else s
             for s in p.sites]
    return sel, cands, p.model_copy(update={"sites": sites, "stacks": stacks,
                                             "options": p.options.model_copy(update={"goals": g})})


def _all_affordable(p, f):
    """Goal: every home on the agents' priced (pursued) sites affordable."""
    units = sum(x.units for x in p.stacks if next(s for s in p.sites if s.id == x.site_id).status == "pursue")
    _, _, gp = _goal_plan(p, f, PlanGoals(affordable_homes=units))
    return units, _after(gp, f, [])


@pytest.mark.parametrize("lid", LOCALES)
def test_raised_affordable_gaps_clamp_the_same_way_in_scoreboard_and_report(plans, lid):
    """Raising homes to affordable can make sites pencil (Brevard's 40-home site does): the scoreboard and the goals
    report must both count a negative funding required as 0, never as an offset to other sites."""
    p, f = plans(lid), resolve(lid)
    _, (r, sites, stacks, _, _, gr) = _all_affordable(p, f)
    funded = {s.id for s in sites if s.status == "pursue"}
    fs = [x for x in stacks if x.site_id in funded]
    for x in fs:
        _check_stack(x)
    clamped = sum(max(x.funding_required_usd, 0.0) for x in fs)
    assert r.scoreboard.funding_required_usd == pytest.approx(clamped, abs=0.01)
    assert gr.housing_funding_required_usd == pytest.approx(clamped, abs=0.01)
    assert r.scoreboard.affordable_homes == sum(x.affordable_units for x in fs) <= r.scoreboard.homes


@pytest.mark.parametrize("lid", [HOU, LA, pytest.param(BRE, marks=pytest.mark.xfail(strict=True, reason=(
    "QA-FIN-7: a priced site whose default affordable count rounds to 0 (Brevard's 4-home site) is never selected "
    "for an affordable goal, so the goal falls short while the report says every priced site was used")))])
def test_affordable_goal_equal_to_every_priced_home_is_met(plans, lid):
    p, f = plans(lid), resolve(lid)
    units, (r, sites, stacks, _, _, gr) = _all_affordable(p, f)
    assert r.scoreboard.affordable_homes == units
    assert next(g for g in gr.goals if g.key == "affordable_homes").met is True


@pytest.mark.parametrize("lid", LOCALES)
def test_homes_goal_selection_is_minimal_and_cheaper_than_the_full_plan(plans, lid):
    p, f = plans(lid), resolve(lid)
    pursued = [s for s in p.sites if s.status == "pursue" and s.homes > 0]
    goal = max(1, sum(s.homes for s in pursued) // 2)
    sel, cands, gp = _goal_plan(p, f, PlanGoals(total_homes=goal))
    homes = {s.id: s.homes for s, _ in cands}
    assert sum(homes[i] for i in sel.selected) >= goal
    assert sum(homes[i] for i in sel.selected[:-1]) < goal
    full = rescore(p, [], f).scoreboard
    part = rescore(gp, [], f).scoreboard
    assert part.funding_required_usd <= full.funding_required_usd
    assert part.homes <= full.homes
