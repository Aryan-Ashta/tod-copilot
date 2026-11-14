"""Finance (docs/05 formulas, exactly). Pure; every intermediate number is returned."""
import math
from typing import Literal, Optional

from backend.schemas import CapitalStack

NOI_KEYS = ["rent_usd_per_unit_month", "vacancy_rate", "opex_ratio", "cap_rate"]


def acquisition_basis(last_sale_usd: Optional[float], assessed_value_usd: Optional[float]) -> Optional[float]:
    """Last sale if known, else assessed value; None when both are missing."""
    if last_sale_usd is not None:
        return float(last_sale_usd)
    if assessed_value_usd is not None:
        return float(assessed_value_usd)
    return None


def _noi_value(units: int, f: dict) -> tuple[float, float]:
    noi = units * f["rent_usd_per_unit_month"] * 12 * (1 - f["vacancy_rate"] - f["opex_ratio"])
    return noi, noi / f["cap_rate"]


def new_build_pro_forma(homes: int, land_cost: Optional[float], f: dict, incentive_per_unit: float = 0.0) -> Optional[dict]:
    if land_cost is None:
        return None
    total_cost = land_cost + homes * f["construction_cost_usd_per_unit"]
    noi, value = _noi_value(homes, f)
    return {"kind": "new_build", "units": homes, "land_cost_usd": land_cost, "total_cost_usd": total_cost,
            "noi_usd": noi, "value_usd": value, "margin": (value - total_cost) / total_cost if total_cost else 0.0,
            "incentive_per_unit_usd": incentive_per_unit,
            "factor_keys": ["construction_cost_usd_per_unit", *NOI_KEYS]}


def conversion_pro_forma(units: int, acquisition: Optional[float], rentable_area_sqft: float, f: dict,
                         incentive_per_unit: float = 0.0, cost_key: str = "conversion_cost_usd_per_sqft",
                         extra_value_usd: float = 0.0, extra_noi_usd: float = 0.0) -> Optional[dict]:
    if acquisition is None:
        return None
    total_cost = acquisition + rentable_area_sqft * f[cost_key]
    noi, value = _noi_value(units, f)
    noi += extra_noi_usd
    value += extra_noi_usd / f["cap_rate"] + extra_value_usd
    return {"kind": "conversion", "units": units, "acquisition_usd": acquisition,
            "rentable_area_sqft": rentable_area_sqft, "total_cost_usd": total_cost, "noi_usd": noi,
            "value_usd": value, "margin": (value - total_cost) / total_cost if total_cost else 0.0,
            "incentive_per_unit_usd": incentive_per_unit, "factor_keys": [cost_key, *NOI_KEYS]}


def capital_stack(site_id: str, pf: dict, f: dict, incentive_per_unit: float = 0.0) -> tuple[CapitalStack, dict]:
    units = pf["units"]
    total = pf["total_cost_usd"]
    debt = min(f["debt_ratio"] * total, pf["value_usd"] * f["max_ltv"])
    incentive = units * incentive_per_unit
    affordable_units = math.floor(units * f["affordable_share"])
    tax_credit = affordable_units * f["per_unit_credit_equity_usd"]
    investor = f["investor_equity_share"] * total
    gap = total - debt - incentive - tax_credit - investor
    keys = [*pf["factor_keys"], "debt_ratio", "max_ltv", "affordable_share", "per_unit_credit_equity_usd",
            "investor_equity_share"]
    if incentive_per_unit:
        keys.append("houston_downtown_per_unit_incentive_usd")
    stack = CapitalStack(site_id=site_id, total_cost_usd=round(total, 2), debt_usd=round(debt, 2),
                         tax_credit_equity_usd=round(tax_credit, 2), incentive_usd=round(incentive, 2),
                         investor_equity_usd=round(investor, 2), gap_usd=round(gap, 2), pencils=gap <= 0,
                         assumptions=keys)
    math_ = {**pf, "debt_usd": debt, "incentive_usd": incentive, "affordable_units": affordable_units,
             "tax_credit_equity_usd": tax_credit, "investor_equity_usd": investor, "gap_usd": gap}
    return stack, math_


def compare_options(nb: dict, conv: dict) -> Literal["new_build", "conversion"]:
    """Larger (value - total_cost) wins; ties -> conversion (less embodied carbon)."""
    nb_gain = nb["value_usd"] - nb["total_cost_usd"]
    cv_gain = conv["value_usd"] - conv["total_cost_usd"]
    return "new_build" if nb_gain > cv_gain else "conversion"


def incentive_per_unit(locale_id: str, f: dict) -> float:
    return float(f["houston_downtown_per_unit_incentive_usd"]) if locale_id == "houston_downtown" else 0.0
