"""Finance (docs/05 formulas, exactly). Pure; every intermediate number is returned."""
import math
from typing import Literal, Optional

from backend.schemas import CapitalStack, GapToPencil

NOI_KEYS = ["rent_usd_per_unit_month", "affordable_rent_usd_per_unit_month", "affordable_share", "vacancy_rate",
            "opex_ratio", "cap_rate"]


def acquisition_basis(last_sale_usd: Optional[float], assessed_value_usd: Optional[float]) -> Optional[float]:
    """Last sale if known, else assessed value; None when both are missing."""
    if last_sale_usd is not None:
        return float(last_sale_usd)
    if assessed_value_usd is not None:
        return float(assessed_value_usd)
    return None


def affordable_units(units: int, f: dict) -> int:
    return math.floor(units * f["affordable_share"])


def _noi_value(units: int, affordable: int, f: dict) -> tuple[float, float]:
    """`affordable` homes (the same ones that earn tax credit equity) rent at the 60% AMI limit."""
    rent = (units - affordable) * f["rent_usd_per_unit_month"] + affordable * f["affordable_rent_usd_per_unit_month"]
    noi = rent * 12 * (1 - f["vacancy_rate"] - f["opex_ratio"])
    return noi, noi / f["cap_rate"]


def new_build_pro_forma(homes: int, land_cost: Optional[float], f: dict, incentive_per_unit: float = 0.0) -> Optional[dict]:
    if land_cost is None:
        return None
    total_cost = land_cost + homes * f["construction_cost_usd_per_unit"]
    aff = affordable_units(homes, f)
    noi, value = _noi_value(homes, aff, f)
    return {"kind": "new_build", "units": homes, "affordable_units": aff, "land_cost_usd": land_cost,
            "total_cost_usd": total_cost,
            "noi_usd": noi, "value_usd": value, "margin": (value - total_cost) / total_cost if total_cost else 0.0,
            "incentive_per_unit_usd": incentive_per_unit,
            "factor_keys": ["construction_cost_usd_per_unit", *NOI_KEYS]}


def conversion_pro_forma(units: int, acquisition: Optional[float], rentable_area_sqft: float, f: dict,
                         incentive_per_unit: float = 0.0, cost_key: str = "conversion_cost_usd_per_sqft",
                         extra_value_usd: float = 0.0, extra_noi_usd: float = 0.0) -> Optional[dict]:
    if acquisition is None:
        return None
    total_cost = acquisition + rentable_area_sqft * f[cost_key]
    aff = affordable_units(units, f)
    noi, value = _noi_value(units, aff, f)
    noi += extra_noi_usd
    value += extra_noi_usd / f["cap_rate"] + extra_value_usd
    return {"kind": "conversion", "units": units, "affordable_units": aff, "acquisition_usd": acquisition,
            "rentable_area_sqft": rentable_area_sqft, "total_cost_usd": total_cost, "noi_usd": noi,
            "value_usd": value, "margin": (value - total_cost) / total_cost if total_cost else 0.0,
            "incentive_per_unit_usd": incentive_per_unit, "factor_keys": [cost_key, *NOI_KEYS]}


def with_affordable(pf: dict, affordable: int, f: dict) -> dict:
    """Same pro forma with `affordable` homes at the affordable rent (NOI is linear in the count)."""
    k = max(0, min(affordable, pf["units"]))
    d_noi = (k - pf["affordable_units"]) * (f["rent_usd_per_unit_month"] - f["affordable_rent_usd_per_unit_month"]) \
        * 12 * (1 - f["vacancy_rate"] - f["opex_ratio"])
    value = pf["value_usd"] - d_noi / f["cap_rate"]
    total = pf["total_cost_usd"]
    return {**pf, "affordable_units": k, "noi_usd": pf["noi_usd"] - d_noi, "value_usd": value,
            "margin": (value - total) / total if total else 0.0}



def capital_stack(site_id: str, pf: dict, f: dict, incentive_per_unit: float = 0.0) -> tuple[CapitalStack, dict]:
    units = pf["units"]
    total = pf["total_cost_usd"]
    debt = min(f["debt_ratio"] * total, pf["value_usd"] * f["max_ltv"])
    incentive = units * incentive_per_unit
    affordable = pf["affordable_units"]
    tax_credit = affordable * f["per_unit_credit_equity_usd"]
    investor = f["investor_equity_share"] * total
    required = total - debt - incentive - tax_credit - investor
    keys = [*pf["factor_keys"], "debt_ratio", "max_ltv", "affordable_share", "per_unit_credit_equity_usd",
            "investor_equity_share"]
    if incentive_per_unit:
        keys.append("houston_downtown_per_unit_incentive_usd")
    stack = CapitalStack(site_id=site_id, units=units, affordable_units=affordable, total_cost_usd=round(total, 2),
                         debt_usd=round(debt, 2),
                         tax_credit_equity_usd=round(tax_credit, 2), incentive_usd=round(incentive, 2),
                         investor_equity_usd=round(investor, 2), funding_required_usd=round(required, 2),
                         pencils=required <= 0, assumptions=keys)
    math_ = {**pf, "debt_usd": debt, "incentive_usd": incentive, "tax_credit_equity_usd": tax_credit,
             "investor_equity_usd": investor, "funding_required_usd": required}
    if required > 0:
        stack.gap_to_pencil = gap_to_pencil(math_, f)
    return stack, math_


def gap_to_pencil(m: dict, f: dict) -> GapToPencil:
    """What would cover the funding still required, holding every other factor fixed: an extra per-home incentive of
    funding required / homes,
    or the monthly rent at which loan-to-value debt covers what other sources leave. Rent cannot close it when the
    loan-to-cost cap (debt_ratio) binds before value does."""
    units, total = m["units"], m["total_cost_usd"]
    ltc_debt = f["debt_ratio"] * total
    debt_limit = "loan_to_cost" if ltc_debt <= m["value_usd"] * f["max_ltv"] else "loan_to_value"
    need_debt = total - m["incentive_usd"] - m["tax_credit_equity_usd"] - m["investor_equity_usd"]
    rent = f["rent_usd_per_unit_month"]
    market_units = units - m["affordable_units"]  # only market-rate homes move with the market rent
    value_per_rent = market_units * 12 * (1 - f["vacancy_rate"] - f["opex_ratio"]) / f["cap_rate"]  # per $1/mo
    break_even = None
    if value_per_rent and need_debt <= ltc_debt:
        other_value = m["value_usd"] - value_per_rent * rent        # affordable rents, hotel keys, retail NOI
        break_even = (need_debt / f["max_ltv"] - other_value) / value_per_rent
    return GapToPencil(
        funding_required_per_home_usd=round(m["funding_required_usd"] / units, 2) if units else None,
        cost_per_home_usd=round(total / units, 2) if units else None,
        value_per_home_usd=round(m["value_usd"] / units, 2) if units else None,
        rent_usd_per_unit_month=rent, break_even_rent_usd_per_unit_month=break_even, debt_limit=debt_limit,
        factor_keys=["rent_usd_per_unit_month", "cap_rate", "max_ltv", "debt_ratio", *m["factor_keys"][:1]])


def compare_options(nb: dict, conv: dict) -> Literal["new_build", "conversion"]:
    """Larger (value - total_cost) wins; ties -> conversion (less embodied carbon)."""
    nb_gain = nb["value_usd"] - nb["total_cost_usd"]
    cv_gain = conv["value_usd"] - conv["total_cost_usd"]
    return "new_build" if nb_gain > cv_gain else "conversion"


def incentive_per_unit(locale_id: str, f: dict) -> float:
    return float(f["houston_downtown_per_unit_incentive_usd"]) if locale_id == "houston_downtown" else 0.0
