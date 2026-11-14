from shapely.geometry import shape

from backend.agents.coordinator import run_plan
from backend.schemas import PlanOptions
from backend.tests.test_areas import HOUSTON_SUB


def test_subarea_plan_clips_targets(plans):
    plan = run_plan("houston_downtown", "x", "test-subarea", lambda e: None, llm=False, boundary=HOUSTON_SUB)
    assert plan.agent_errors == {}
    assert plan.locale.boundary == HOUSTON_SUB
    poly = shape(HOUSTON_SUB)
    assert plan.parcels and plan.buildings
    for g in [*(p.geometry for p in plan.parcels), *(b.footprint for b in plan.buildings)]:
        assert poly.contains(shape(g).representative_point())
    assert len(plan.parcels) < len(plans("houston_downtown").parcels)


def test_conversions_focus_drops_new_build():
    plan = run_plan("houston_downtown", "x", "test-subarea-conv", lambda e: None, llm=False, boundary=HOUSTON_SUB,
                    options=PlanOptions(focus="conversions"))
    assert plan.options.focus == "conversions"
    assert not [s for s in plan.sites if s.kind == "new_build"]
