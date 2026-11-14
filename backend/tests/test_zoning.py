from backend.models.zoning import apply_rules, homes_for, recommend

F = {"story_height_ft": 12, "newbuild_assumed_stories": 7, "site_lot_coverage_ratio": 0.6, "avg_unit_sqft_residential": 1000}
C = {"doc_id": "d", "section": "1", "quote": "q"}
RULES = [
    {"path": "A", "rule": "stop_tier", "applies_if": {"station_mode": {"eq": "heavy_rail"}}, "value": 1, "cite": C},
    {"path": "A", "rule": "eligible", "applies_if": {"distance_to_stop_mi": {"lte": 0.5}, "stop_tier": {"in": [1]}}, "value": True, "cite": C},
    {"path": "A", "rule": "max_units_per_acre", "applies_if": {"stop_tier": {"eq": 1}}, "value": 100, "cite": C},
    {"path": "A", "rule": "max_far", "applies_if": {}, "value": 2, "cite": C},
    {"path": "A", "rule": "approval_steps", "applies_if": {}, "value": "TODO", "cite": C},
    {"path": "B", "rule": "eligible", "applies_if": {"property_type": {"in": ["office"]}}, "value": True, "cite": C},
    {"path": "B", "rule": "approval_steps", "applies_if": {}, "value": 1, "cite": C},
]


def test_apply_rules_tier_todo_and_missing_attr():
    a, b = apply_rules({"station_mode": "heavy_rail", "distance_to_stop_mi": 0.3, "property_type": None}, RULES, ["A", "B"])
    assert a.eligible is True and a.allows == {"max_units_per_acre": 100, "max_far": 2,
                                               "not_covered": ["approval_steps"]}  # TODO is flagged, never defaulted
    # property_type missing -> not covered, never a default; the missing input is named
    assert b.eligible is None and b.allows == {"missing_inputs": ["property_type"]}


def test_homes_for_density_vs_floor_area():
    a = apply_rules({"station_mode": "heavy_rail", "distance_to_stop_mi": 0.3}, RULES, ["A"])[0]
    # 0.5 acre: density 50; FAR 2 x 21,780 sqft = 43,560 / 1000 = 43 -> min = 43
    assert homes_for(0.5, a, F) == 43
    # no FAR, no height: 21,780 x 0.6 x 7 / 1000 = 91.47 -> 91; density 50 caps it
    a2 = a.model_copy(update={"allows": {"max_units_per_acre": 100}})
    assert homes_for(0.5, a2, F) == 50


def test_recommend_ties_go_to_fewer_steps():
    a, b = apply_rules({"station_mode": "heavy_rail", "distance_to_stop_mi": 0.3, "property_type": "office"}, RULES, ["A", "B"])
    assert recommend([a, b], {"A": 40, "B": 40}) == "B"
    assert recommend([a, b], {"A": 41, "B": 40}) == "A"


def test_density_rule_with_todo_value_blocks_homes():
    rules = [{"path": "L", "rule": "eligible", "applies_if": {"zoning_code": {"eq": "C-G"}}, "value": True, "cite": C},
             {"path": "L", "rule": "max_units_per_acre", "applies_if": {"zoning_code": {"eq": "C-G"}}, "value": "TODO",
              "cite": C}]
    p = apply_rules({"zoning_code": "C-G"}, rules, ["L"])[0]
    assert p.eligible is True and p.allows["not_covered"] == ["max_units_per_acre"]
    assert homes_for(2.0, p, F) is None  # never fall back to assumed stories when the law sets an uncited cap


def test_off_path_citations_explain_only_the_verdict():
    rules = [{"path": "R", "rule": "eligible", "applies_if": {"est_units": {"gte": 5}}, "value": True, "cite": {**C, "section": "ok"}},
             {"path": "R", "rule": "eligible", "applies_if": {"est_units": {"lte": 4}}, "value": False, "cite": {**C, "section": "why"}},
             {"path": "R", "rule": "allows_uses", "applies_if": {}, "value": ["residential"], "cite": {**C, "section": "uses"}}]
    no, = apply_rules({"est_units": 3}, rules, ["R"])
    assert no.eligible is False and [c.section for c in no.citations] == ["why"]
    unknown, = apply_rules({"est_units": None}, rules, ["R"])
    assert unknown.eligible is None and unknown.citations == [] and unknown.allows == {"missing_inputs": ["est_units"]}
    yes, = apply_rules({"est_units": 9}, rules, ["R"])
    assert [c.section for c in yes.citations] == ["ok", "uses"]
