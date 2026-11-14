"""Building reuse scoring (docs/05). Pure: Building + legal paths + readiness + market -> ConversionCandidate."""
import math
from datetime import date, datetime, timezone
from typing import Optional

from backend.models import finance
from backend.models.infrastructure import distance_score
from backend.models.targets import embodied_co2_saved, walk_threshold_m
from backend.schemas import (Building, ConversionCandidate, FitScores, InfraReadiness, LegalPath, Provenance,
                             ScoreInput, Sourced)

USES = ("residential", "hotel", "mixed_use", "keep_current")
CONVERT_USES = ("residential", "hotel", "mixed_use")
CONF_ORDER = {"missing": 0, "low": 1, "medium": 2, "high": 3}
DEPTH_KEY = {u: f"reuse_max_floor_depth_ft_{u}" for u in CONVERT_USES}
_CODE = Provenance(source="model", confidence="high", retrieved_at=datetime(2026, 11, 13, tzinfo=timezone.utc),
                   note="computed in backend/models/reuse.py")


def clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def ramp(x: float, lo: Optional[float], hi: Optional[float], tol: float) -> float:
    """1 inside [lo, hi]; falls linearly to 0 over tol x |bound| outside."""
    if lo is not None and x < lo:
        band = tol * abs(lo) or 1.0
        return clamp(1 - (lo - x) / band)
    if hi is not None and x > hi:
        band = tol * abs(hi) or 1.0
        return clamp(1 - (x - hi) / band)
    return 1.0


def _gmean(scores: dict[str, float], weights: dict[str, float]) -> float:
    tw = sum(weights[k] for k in scores)
    return math.exp(sum(weights[k] * math.log(max(scores[k], 1e-9)) for k in scores) / tw)


def _wmean(scores: dict[str, float], weights: dict[str, float]) -> float:
    return sum(weights[k] * scores[k] for k in weights) / sum(weights.values())


def units_for(rentable_sqft: Optional[float], f: dict) -> Optional[int]:
    if rentable_sqft is None:
        return None
    return int(math.floor(rentable_sqft * f["reuse_efficiency_factor"] / f["avg_unit_sqft_residential"]))


def physical_inputs(b: Building, use: str, f: dict, year: int) -> list[tuple[str, Sourced, Optional[float], Optional[float], str, str, Optional[str]]]:
    """(weight key, sourced value, lo, hi, unit, threshold text, factor key) per physical input."""
    smin, smax = f["reuse_floor_sqft_range_residential"]
    age = (Sourced(value=year - b.year_built.value, prov=b.year_built.prov) if b.year_built.value is not None
           else b.year_built)
    depth_key = DEPTH_KEY[use]
    return [
        ("floor_depth", b.floor_depth_ft, None, f[depth_key], "ft", f"<= {f[depth_key]:.0f} ft", depth_key),
        ("floor_plate", b.typical_floor_sqft, smin, smax, "sqft", f"{smin:,.0f}-{smax:,.0f} sqft",
         "reuse_floor_sqft_range_residential"),
        ("ceiling", b.ceiling_height_ft, f["reuse_min_ceiling_height_ft"], None, "ft",
         f">= {f['reuse_min_ceiling_height_ft']} ft", "reuse_min_ceiling_height_ft"),
        ("window", b.window_wall_pct, f["reuse_min_window_wall_pct"], None, "%",
         f">= {f['reuse_min_window_wall_pct']}%", "reuse_min_window_wall_pct"),
        ("stories", b.stories, f["reuse_min_stories"], None, "stories", f">= {f['reuse_min_stories']}",
         "reuse_min_stories"),
        ("age", age, f["reuse_min_building_age_years"], None, "years", f">= {f['reuse_min_building_age_years']} years",
         "reuse_min_building_age_years"),
    ]


LABELS = {"floor_depth": "floor depth", "floor_plate": "typical floor", "ceiling": "ceiling height",
          "window": "window-wall", "stories": "stories", "age": "building age"}


def score_reuse(building: Building, legal_paths: Optional[list[LegalPath]], readiness: Optional[InfraReadiness],
                walk: dict, acquisition: Optional[Sourced], f: dict, *, locale_id: str, data_tier: str,
                year: Optional[int] = None) -> ConversionCandidate:
    year = year or date.today().year
    tol = f["reuse_ramp_tolerance_pct"]
    miss = f["reuse_missing_input_score"]
    details: list[ScoreInput] = []
    fits: dict[str, dict[str, float]] = {}
    phys_blockers: dict[str, list[str]] = {}

    # ---- physical
    for use in USES:
        if use == "keep_current":
            fits[use] = {"physical": 1.0}
            continue
        scores, blockers = {}, []
        for key, sv, lo, hi, unit, thr, fkey in physical_inputs(building, use, f, year):
            if sv.value is None:
                s = miss
                blockers.append(f"{LABELS[key]} missing (no source covers it here); scored {miss} "
                                f"(factor `reuse_missing_input_score`)")
            else:
                s = ramp(float(sv.value), lo, hi, tol)
                if s < 1:
                    if key == "floor_depth":
                        blockers.append(f"floor depth {sv.value:.0f} ft ({sv.prov.source}) > {hi:.0f} ft {use} limit "
                                        f"(factor `{fkey}`)")
                    else:
                        blockers.append(f"{LABELS[key]} {float(sv.value):,.0f} {unit} ({sv.prov.source}) outside "
                                        f"{thr} (factor `{fkey}`)")
            scores[key] = s
            details.append(ScoreInput(use=use, fit="physical", name=LABELS[key], value=sv.value, unit=unit,
                                      threshold=thr, factor_key=fkey, score=round(s, 4), prov=sv.prov))
        fits[use] = {"physical": _gmean(scores, f["reuse_physical_weights"])}
        phys_blockers[use] = blockers

    # ---- legal
    paths = legal_paths or []
    covered = [p for p in paths if p.eligible is not None]
    legal_blockers: list[str] = []
    deciding: dict[str, Optional[LegalPath]] = {}
    for use in USES:
        if use == "keep_current":
            fits[use]["legal"] = 1.0
            deciding[use] = None
            continue
        if not covered:
            s, why, dp = 0.3, "legal status not covered by corpus", None
        else:
            s, why, dp = 0.0, "no eligible legal path allows this use", covered[0]
            for p in covered:
                if p.eligible and use in (p.allows.get("allows_uses") or []):
                    cand = 0.5 if p.allows.get("discretionary") else 1.0
                    if cand > s:
                        s, dp = cand, p
                        why = "allowed, needs discretionary approval" if cand == 0.5 else "allowed by right"
        fits[use]["legal"] = s
        deciding[use] = dp
        details.append(ScoreInput(use=use, fit="legal", name="legal path", value=dp.name if dp else None, unit="",
                                  threshold=why, factor_key=None, score=s, prov=_CODE))
    if not covered:
        legal_blockers.append("legal status not covered by corpus")

    # ---- market
    vac, rent = building.vacancy_pct, building.asking_rent_usd_sqft_yr
    res_psf = f["rent_usd_per_unit_month"] * 12 / f["avg_unit_sqft_residential"]
    vac_s = clamp(vac.value / f["reuse_vacancy_threshold_pct"]) if vac.value is not None else miss
    ratio = rent.value / res_psf if rent.value is not None else None
    rent_s = clamp(1.5 - ratio) if ratio is not None else miss
    for use in USES:
        if use == "keep_current":
            fits[use]["market"] = 1 - vac_s if vac.value is not None else miss
        else:
            fits[use]["market"] = (vac_s + rent_s) / 2
        details.append(ScoreInput(use=use, fit="market", name="vacancy", value=vac.value, unit="%",
                                  threshold=f"{f['reuse_vacancy_threshold_pct']}% scores 1", factor_key="reuse_vacancy_threshold_pct",
                                  score=round(vac_s, 4), prov=vac.prov))
        if use != "keep_current":
            details.append(ScoreInput(use=use, fit="market", name="office rent / residential rent", value=
                                      round(ratio, 3) if ratio is not None else None, unit="ratio",
                                      threshold=f"residential ${res_psf:.2f}/sqft/yr; score = 1.5 - ratio",
                                      factor_key="rent_usd_per_unit_month", score=round(rent_s, 4), prov=rent.prov))

    # ---- financial
    rentable = building.rentable_area_sqft.value
    units = units_for(rentable, f)
    acq = acquisition.value if acquisition is not None else None
    fin_blockers: list[str] = []
    inc = finance.incentive_per_unit(locale_id, f)
    margins: dict[str, Optional[float]] = {}
    for use in CONVERT_USES:
        pf = None
        if acq is not None and rentable is not None:
            if use == "residential":
                pf = finance.conversion_pro_forma(units, acq, rentable, f, inc)
            elif use == "hotel":
                keys = rentable * f["reuse_efficiency_factor"] / f["hotel_key_sqft"]
                pf = finance.conversion_pro_forma(0, acq, rentable, f, 0.0, "hotel_conversion_cost_usd_per_sqft",
                                                  extra_value_usd=keys * f["hotel_value_usd_per_key"])
            else:
                retail_noi = ((building.typical_floor_sqft.value or 0) * f["retail_rent_usd_sqft_yr"]
                              * (1 - f["vacancy_rate"] - f["opex_ratio"]))
                pf = finance.conversion_pro_forma(math.floor(units * f["mixed_use_residential_share"]), acq, rentable,
                                                  f, inc, extra_noi_usd=retail_noi)
        if pf is None:
            s = miss
            margins[use] = None
        else:
            m = pf["margin"]
            margins[use] = m
            s = clamp((m - f["reuse_fin_margin_floor"]) / (f["reuse_fin_margin_ceiling"] - f["reuse_fin_margin_floor"]))
        fits[use]["financial"] = s
        details.append(ScoreInput(use=use, fit="financial", name="pro forma margin",
                                  value=round(margins[use], 4) if margins[use] is not None else None, unit="fraction",
                                  threshold=f"{f['reuse_fin_margin_floor']} -> 0, {f['reuse_fin_margin_ceiling']} -> 1",
                                  factor_key="reuse_fin_margin_ceiling", score=round(s, 4),
                                  prov=acquisition.prov if acquisition is not None else _CODE))
    fits["keep_current"]["financial"] = 0.5
    if acq is None:
        fin_blockers.append("acquisition basis missing (no last sale or assessed value)")
    if rentable is None:
        fin_blockers.append("rentable area missing; units and pro forma not computed")

    # ---- location
    thr = walk_threshold_m(f)
    ready = readiness.score if readiness is not None else miss
    walk_share = sum(1 for k in ("park", "clinic", "grocery") if walk.get(k) is not None and walk[k] <= thr) / 3
    freq = distance_score(walk.get("frequent_stop"), f)
    loc = _wmean({"readiness": ready, "walk_access": walk_share, "frequent_transit": freq}, f["reuse_location_weights"])
    for use in USES:
        fits[use]["location"] = loc
    details.append(ScoreInput(use="keep_current", fit="location", name="readiness / walk / transit",
                              value=round(loc, 4), unit="score", threshold=None, factor_key="reuse_location_weights",
                              score=round(loc, 4), prov=_CODE))

    # ---- overall, best use
    scores_by_use = {u: FitScores(**{k: round(v, 4) for k, v in fits[u].items()}) for u in USES}
    overall = {u: _wmean(fits[u], f["reuse_weights"]) for u in USES}
    best_conv = max(CONVERT_USES, key=lambda u: overall[u])
    best = best_conv if overall[best_conv] >= overall["keep_current"] + f["reuse_keep_margin"] else "keep_current"

    blockers = phys_blockers[best_conv] + legal_blockers + fin_blockers
    if fits[best_conv]["legal"] == 0:
        blockers.append(f"{best_conv}: no eligible legal path allows it")

    present = [sv.prov for _, sv, *_ in physical_inputs(building, best_conv, f, year) if sv.value is not None]
    if present:
        conf = min((p.confidence for p in present), key=lambda c: CONF_ORDER[c])
        if any(p.source == "derived" for p in present) and CONF_ORDER[conf] > CONF_ORDER["low"]:
            conf = "low"
    else:
        conf = "missing"

    embodied = round(embodied_co2_saved(rentable, f), 1) if best != "keep_current" and rentable is not None else None
    return ConversionCandidate(
        building_id=building.id, best_use=best, scores_by_use=scores_by_use, overall=round(overall[best], 4),
        est_units=units, blockers=blockers, legal_path=deciding.get(best) if best != "keep_current" else None,
        embodied_co2_saved_tonnes=embodied, confidence=conf, screening_only=data_tier == "public_only",
        details=details)
