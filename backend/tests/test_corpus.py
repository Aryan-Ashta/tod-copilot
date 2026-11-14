"""Legal corpus integrity: verbatim citations, registered documents, required rule kinds, search."""
import pytest

from backend.corpus.loader import load_index, load_rules, load_sections, search_corpus

JURISDICTIONS = ["houston", "los_angeles", "brevard"]
RULE_KINDS = {
    "eligible", "max_height_ft", "max_units_per_acre", "max_far", "parking_min_per_unit",
    "allows_uses", "approval_steps", "discretionary", "note", "stop_tier",
}
USES = {"residential", "hotel", "mixed_use", "keep_current"}
ATTRS = {
    "property_type", "land_use", "building_age_years", "stories", "distance_to_stop_mi", "station_mode",
    "stop_tier", "area_acres", "zoning_code", "in_flood_zone", "est_units",
}
OPS = {"in", "lte", "gte", "eq"}
EXPECTED_PATHS = {
    "houston": {"Houston development rules"},
    "los_angeles": {"SB 79 new construction", "LA Citywide Adaptive Reuse"},
    "brevard": {"City of Cocoa land development code"},
}


def _all_rules():
    return [(j, r) for j in JURISDICTIONS for r in load_rules(j)]


def test_index_documents_exist_and_have_sections():
    index = load_index()
    ids = [d["doc_id"] for d in index]
    assert len(ids) == len(set(ids))
    for d in index:
        assert {"doc_id", "title", "jurisdiction", "path_name", "url", "retrieved_at"} <= d.keys()
        assert d["url"].startswith("https://")
        assert load_sections(d["doc_id"]), d["doc_id"]


@pytest.mark.parametrize("jurisdiction,rule", _all_rules())
def test_rule_shape_and_verbatim_quote(jurisdiction, rule):
    index_ids = {d["doc_id"] for d in load_index()}
    assert rule["rule"] in RULE_KINDS
    for attr, cond in (rule.get("applies_if") or {}).items():
        assert attr in ATTRS, attr
        assert set(cond) <= OPS, cond
    if rule["rule"] == "allows_uses" and rule["value"] != "TODO":
        assert set(rule["value"]) <= USES
    cite = rule["cite"]
    assert cite["doc_id"] in index_ids
    sections = load_sections(cite["doc_id"])
    assert cite["section"] in sections, (cite["doc_id"], cite["section"])
    assert cite["quote"] and cite["quote"] in sections[cite["section"]], cite["quote"]


@pytest.mark.parametrize("jurisdiction", JURISDICTIONS)
def test_every_path_has_minimum_rules(jurisdiction):
    rules = load_rules(jurisdiction)
    paths = {r["path"] for r in rules}
    assert paths == EXPECTED_PATHS[jurisdiction]
    for p in paths:
        kinds = {r["rule"] for r in rules if r["path"] == p}
        assert {"eligible", "allows_uses", "approval_steps"} <= kinds, (p, kinds)


def test_no_houston_quote_says_zoning_district():
    for r in load_rules("houston"):
        assert "zoning district" not in r["cite"]["quote"].lower()
        assert "zoning district" not in str(r["value"]).lower()


@pytest.mark.parametrize("jurisdiction,query,doc_id", [
    ("houston", "building line requirement central business district", "houston_ch42_development"),
    ("los_angeles", "adaptive reuse eligible buildings 15 years", "la_adaptive_reuse_2026"),
    ("los_angeles", "tier 1 transit-oriented development stop height limit", "ca_sb79_2025"),
    ("brevard", "multiple-family dwellings units per acre", "cocoa_zoning_code"),
])
def test_search_corpus(jurisdiction, query, doc_id):
    hits = search_corpus(jurisdiction, query, k=5)
    assert 0 < len(hits) <= 5
    assert all({"doc_id", "section", "text"} <= h.keys() for h in hits)
    assert doc_id in {h["doc_id"] for h in hits}


def test_search_scoped_to_jurisdiction():
    hits = search_corpus("houston", "adaptive reuse transit-oriented development stop", k=10)
    jur = {d["doc_id"]: d["jurisdiction"] for d in load_index()}
    assert all(jur[h["doc_id"]] == "houston" for h in hits)
