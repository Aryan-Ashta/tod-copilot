"""Sustainability and health targets (docs/05). Pure."""
from typing import Optional

from backend.schemas import TargetScore

M2_PER_SQFT = 1 / 10.7639


def transport_co2(households_near_frequent: float, f: dict) -> float:
    """Tonnes CO2 avoided per year = households x VMT reduction x g/mile / 1e6."""
    return households_near_frequent * f["vmt_reduction_per_household_near_transit"] * f["co2_g_per_vehicle_mile"] / 1e6


def embodied_co2_saved(area_sqft: float, f: dict) -> float:
    """Tonnes CO2e = area x (new - reuse) kg/sqft / 1000."""
    return area_sqft * (f["embodied_co2_kg_per_sqft_new"] - f["embodied_co2_kg_per_sqft_reuse"]) / 1000


def rooftop_solar(roof_sqft_list: list[float], kwh_per_kw_year: float, f: dict) -> float:
    """MWh/yr = area_m2 x usable share x kW/m2 x kWh/kW/yr / 1000."""
    area_m2 = sum(roof_sqft_list) * M2_PER_SQFT
    return area_m2 * f["usable_roof_share"] * f["solar_kw_per_m2"] * kwh_per_kw_year / 1000


def walk_threshold_m(f: dict) -> float:
    return f["walk_speed_m_per_s"] * 60 * f["walk_minutes_target"]


def has_walk_access(walk: dict, f: dict) -> bool:
    thr = walk_threshold_m(f)
    return all(walk.get(k) is not None and walk[k] <= thr for k in ("park", "clinic", "grocery"))


def walk_gaps(homes_by_target: dict[str, int], walk_m: dict[str, dict], f: dict) -> dict[str, int]:
    """New homes beyond the walk threshold of each amenity (missing distance counts as beyond)."""
    thr = walk_threshold_m(f)
    return {k: sum(h for t, h in homes_by_target.items()
                   if walk_m.get(t, {}).get(k) is None or walk_m[t][k] > thr) for k in ("park", "clinic", "grocery")}


def walk_access(homes_by_target: dict[str, int], walk_m: dict[str, dict], f: dict) -> float:
    """Share (0-1) of new homes with a park, clinic and grocery all within the walk threshold."""
    total = sum(homes_by_target.values())
    if not total:
        return 0.0
    ok = sum(h for t, h in homes_by_target.items() if has_walk_access(walk_m.get(t, {}), f))
    return ok / total


def flood_exposure(homes_by_target: dict[str, int], in_flood: dict[str, bool]) -> float:
    total = sum(homes_by_target.values())
    if not total:
        return 0.0
    return sum(h for t, h in homes_by_target.items() if in_flood.get(t)) / total


def households_near_frequent(homes_by_target: dict[str, int], walk_m: dict[str, dict], f: dict) -> int:
    thr = walk_threshold_m(f)
    return sum(h for t, h in homes_by_target.items()
               if walk_m.get(t, {}).get("frequent_stop") is not None and walk_m[t]["frequent_stop"] <= thr)


def build_targets(homes_by_target: dict[str, int], walk_m: dict[str, dict], in_flood: dict[str, bool],
                  conversion_area_sqft: list[float], roof_sqft: list[float], kwh_per_kw_year: Optional[float],
                  f: dict) -> list[TargetScore]:
    walk_keys = ["walk_speed_m_per_s", "walk_minutes_target"]
    out = [
        TargetScore(key="transport_co2", value=round(transport_co2(households_near_frequent(homes_by_target, walk_m, f), f), 2),
                    unit="t CO2/yr avoided", target=None,
                    factor_keys=["vmt_reduction_per_household_near_transit", "co2_g_per_vehicle_mile", *walk_keys]),
        TargetScore(key="embodied_co2_saved", value=round(sum(embodied_co2_saved(a, f) for a in conversion_area_sqft), 1),
                    unit="t CO2e", target=None,
                    factor_keys=["embodied_co2_kg_per_sqft_new", "embodied_co2_kg_per_sqft_reuse"]),
        TargetScore(key="walk_access", value=round(100 * walk_access(homes_by_target, walk_m, f), 1),
                    unit="% of new homes", target=None, factor_keys=walk_keys),
        TargetScore(key="flood_exposure", value=round(100 * flood_exposure(homes_by_target, in_flood), 1),
                    unit="% of new homes", target=0.0, factor_keys=[]),
    ]
    if kwh_per_kw_year is not None:
        out.insert(2, TargetScore(key="rooftop_solar", value=round(rooftop_solar(roof_sqft, kwh_per_kw_year, f), 1),
                                  unit="MWh/yr", target=None,
                                  factor_keys=["usable_roof_share", "solar_kw_per_m2", "solar_kwh_per_kw_year"]))
    return out
