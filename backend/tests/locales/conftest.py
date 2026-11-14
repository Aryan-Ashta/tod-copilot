import statistics
from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml

from backend.agents.coordinator import run_plan
from backend.data.factors import resolve
from backend.models.reuse import score_reuse
from backend.schemas import Building, InfraReadiness, Provenance, Sourced

BACKTESTS = yaml.safe_load((Path(__file__).with_name("backtests.yaml")).read_text())
_PLANS: dict = {}


@pytest.fixture(scope="session")
def plans():
    def get(locale_id: str):
        if locale_id not in _PLANS:
            _PLANS[locale_id] = run_plan(locale_id, "Plan TOD around the stations", f"test-{locale_id}",
                                         emit=lambda e: None, llm=False)
        return _PLANS[locale_id]
    return get


def _s(v, source="backtest", url=None, note=None, conf="medium"):
    return Sourced(value=v, prov=Provenance(source=source, confidence="missing" if v is None else conf,
                                            retrieved_at=datetime(2026, 11, 13, tzinfo=timezone.utc), url=url, note=note))


def backtest_candidate(key: str, plan, paths, acquisition_usd, year=2026, same_building=None):
    """Score a published pre-conversion building with the locale's legal paths and median readiness/walk.

    `same_building`: the locale's record of this very building; its values fill attributes the published
    sources do not give (e.g. county year built), keeping their own provenance."""
    bt = BACKTESTS[key]
    urls = bt["source_urls"]
    f = resolve(plan.locale.id)
    rentable, stories = bt["rentable_area_sqft"], bt["stories"]
    depth = (bt["min_floorplate_dimension_ft"] / 2 - f["derived_core_depth_ft"]) if bt.get("min_floorplate_dimension_ft") else None
    b = Building(
        id=key, parcel_id="backtest", footprint={}, property_type=_s(bt["property_type"], url=urls.get("property_type")),
        building_class=_s(None), year_built=_s(bt.get("year_built"), url=urls.get("year_built")), year_renovated=_s(None),
        stories=_s(stories, url=urls.get("stories")), rentable_area_sqft=_s(rentable, url=urls.get("rentable_area_sqft")),
        typical_floor_sqft=_s(round(rentable / stories), "derived", note="rentable / stories", conf="low"),
        vacancy_pct=_s(None), asking_rent_usd_sqft_yr=_s(None), parking_spaces=_s(bt.get("parking_spaces")),
        floor_depth_ft=_s(depth, "derived", note="min floorplate dimension / 2 - core", conf="low"),
        ceiling_height_ft=_s(None), window_wall_pct=_s(None), roof_area_sqft=_s(None), name=_s(bt["name"]))
    if same_building is not None:
        fill = {k: getattr(same_building, k) for k in ("year_built", "floor_depth_ft", "ceiling_height_ft",
                                                       "window_wall_pct", "vacancy_pct", "asking_rent_usd_sqft_yr")
                if getattr(b, k).value is None and getattr(same_building, k).value is not None}
        b = b.model_copy(update=fill)
    med = statistics.median(r.score for r in plan.readiness)
    cand_ids = [c.building_id for c in plan.conversions]
    walk = {k: statistics.median([plan.precomputed.walk_m[i][k] for i in cand_ids
                                  if plan.precomputed.walk_m.get(i, {}).get(k) is not None])
            for k in ("park", "clinic", "grocery", "school", "frequent_stop")}
    acq = _s(float(acquisition_usd), url=urls.get("acquisition_usd_estimate")) if acquisition_usd else None
    c = score_reuse(b, paths, InfraReadiness(target_id=key, score=med, present=[], gaps=[]), walk, acq, f,
                    locale_id=plan.locale.id, data_tier=plan.locale.data_tier, year=year)
    return c, f


def use_overall(c, use, f) -> float:
    s, w = c.scores_by_use[use], f["reuse_weights"]
    return sum(w[k] * getattr(s, k) for k in w) / sum(w.values())
