"""Onboarding verifiers (docs/12 §14) against seeded ArcGIS responses and pages: what an agent proposes is written
only when the live source backs it. Offline."""
from collections import Counter

import pytest
from shapely.geometry import box, mapping

from backend import settings
from backend.onboard import assessor, corpus, land_use, parcels, registry, utilities, zoning
from backend.onboard.arcgis import query_params
from backend.research import pages
from backend.schemas import (AssessorProposal, CorpusProposal, FieldExpr, LandUseProposal, LayerRef,
                             ParcelSourceProposal, UtilitiesProposal, UtilityLayerRef, ZoningProposal)
from backend.tests.research_helpers import pdf, seed_json, seed_page

BOX = (-105.0, 39.70, -104.99, 39.71)
LAYER = "https://gis.example.gov/arcgis/rest/services/Parcels/MapServer/0"
FIELDS = [{"name": n, "type": t} for n, t in (("OBJECTID", "esriFieldTypeOID"), ("PIN", "esriFieldTypeString"),
                                               ("SITUS", "esriFieldTypeString"), ("USECODE", "esriFieldTypeString"),
                                               ("VAL", "esriFieldTypeDouble"), ("LAND_SF", "esriFieldTypeDouble"))]


@pytest.fixture(autouse=True)
def tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CACHE_DIR", tmp_path / "cache")
    pages._cached.cache_clear()
    yield
    pages._cached.cache_clear()


def _layer(url, geometry="esriGeometryPolygon", fields=FIELDS):
    seed_json(url, {"f": "json"}, {"name": "x", "geometryType": geometry, "objectIdField": "OBJECTID",
                                   "fields": fields})


def _features(props: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": p} for p in props]}


def _parcels(ids: list[str]):
    _layer(LAYER)
    seed_json(f"{LAYER}/query", query_params(BOX, "1=1", "*", True, "OBJECTID", 0, 200), {
        "type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"OBJECTID": i, "PIN": pin, "SITUS": f"{100 + i} MAIN ST",
                                               "USECODE": "1112", "VAL": 1000.0 * i, "LAND_SF": 25000},
             "geometry": mapping(box(-104.999 + i * 0.0006, 39.701, -104.9985 + i * 0.0006, 39.7015))}
            for i, pin in enumerate(ids)]})


def _proposal(**fields) -> ParcelSourceProposal:
    base = {"id": FieldExpr(field="PIN"), "address": FieldExpr(field="SITUS", strip=True),
            "raw_use": FieldExpr(field="USECODE"), "assessed_value_usd": FieldExpr(number="VAL")}
    return ParcelSourceProposal(status="found", layer_url=LAYER, fields={**base, **fields})


# ---------------------------------------------------------------- parcels
def test_parcel_layer_with_25_good_parcels_is_accepted():
    _parcels([f"P{i:03d}" for i in range(25)])
    ok, problems, section = parcels.verify(_proposal(), BOX)
    assert ok, problems
    assert section["coverage"]["id"] == 1.0 and section["url"] == LAYER


def test_parcel_rejects_duplicate_ids_unknown_fields_and_points():
    _parcels(["SAME"] * 25)
    ok, problems, _ = parcels.verify(_proposal(), BOX)
    assert not ok and any("id unique share" in p for p in problems)

    _parcels([f"P{i:03d}" for i in range(25)])
    ok, problems, _ = parcels.verify(_proposal(owner=FieldExpr(field="OWNER_NAME")), BOX)
    assert not ok and any("OWNER_NAME" in p for p in problems)

    _layer(LAYER, geometry="esriGeometryPoint")
    ok, problems, _ = parcels.verify(_proposal(), BOX)
    assert not ok and any("esriGeometryPoint" in p for p in problems)


def test_parcel_rejects_square_feet_mapped_as_acres():
    _parcels([f"P{i:03d}" for i in range(25)])
    ok, problems, _ = parcels.verify(_proposal(area_acres=FieldExpr(number="LAND_SF")), BOX)
    assert not ok and any("not in acres" in p for p in problems)
    ok, problems, _ = parcels.verify(_proposal(assessed_value_usd=FieldExpr(field="VAL")), BOX)
    assert not ok and any("must use `number` or `sum`" in p for p in problems)


# ---------------------------------------------------------------- land use
def test_land_use_rejects_a_code_page_missing_half_the_parcels():
    url = "https://assessor.example.gov/codes"
    seed_page(url, "<html><body><h1>Use codes</h1><p>OFFICE BUILDING</p><p>SINGLE FAMILY</p></body></html>")
    counts = {"raw_use": Counter(), "raw_use_desc": Counter({"OFFICE BUILDING": 5, "WAREHOUSE STORAGE": 5})}
    p = LandUseProposal(field="raw_use_desc", map={"OFFICE BUILDING": "office", "WAREHOUSE STORAGE": "industrial"},
                        default="other", building_type_reliable=True, code_list_url=url)
    ok, problems, _ = land_use.verify(p, counts, {"fields": {"raw_use_desc": {"field": "DESC"}}})
    assert not ok and any("50%" in x for x in problems)


# ---------------------------------------------------------------- zoning
def test_zoning_field_half_empty_is_rejected():
    url = "https://gis.example.gov/arcgis/rest/services/Zoning/MapServer/2"
    _layer(url, fields=[{"name": "OBJECTID", "type": "esriFieldTypeOID"}, {"name": "ZONE_DIST", "type": "x"}])
    seed_json(f"{url}/query", query_params(BOX, "1=1", "ZONE_DIST", False, "OBJECTID", 0, 200),
              _features([{"ZONE_DIST": ("C-MX-8" if i % 4 == 0 else "R-2") if i % 2 else ""} for i in range(10)]))
    p = ZoningProposal(status="found", layers=[LayerRef(url=url, field="ZONE_DIST", label="City zoning")])
    ok, problems, _ = zoning.verify(p, BOX)
    assert not ok and any("filled on 50%" in x for x in problems)


def test_no_zoning_from_an_official_page_is_accepted():
    url = "https://www.examplecity.gov/planning"
    seed_page(url, "<html><body><p>Example City has no zoning ordinance; deed restrictions govern land use."
                   "</p></body></html>")
    p = ZoningProposal(status="no_zoning", evidence_url=url, quote="Example City has no zoning ordinance")
    ok, problems, section = zoning.verify(p, BOX)
    assert ok, problems
    assert section["none"] is True


# ---------------------------------------------------------------- utilities
def test_utility_layer_whose_where_errors_is_dropped():
    good = "https://gis.example.gov/arcgis/rest/services/Water/MapServer/1"
    bad = "https://gis.example.gov/arcgis/rest/services/Sewer/MapServer/3"
    for url in (good, bad):
        _layer(url, geometry="esriGeometryPolyline", fields=[{"name": "OBJECTID", "type": "esriFieldTypeOID"}])
    seed_json(f"{good}/query", query_params(BOX, "1=1", "OBJECTID", False, "OBJECTID", 0, 1),
              _features([{"OBJECTID": 1}]))
    seed_json(f"{bad}/query", query_params(BOX, "NOPE = 1", "OBJECTID", False, "OBJECTID", 0, 1),
              {"error": {"code": 400, "message": "Invalid where"}})
    p = UtilitiesProposal(layers=[UtilityLayerRef(kind="water_main", url=good, label="Water"),
                                  UtilityLayerRef(kind="sewer_main", url=bad, where="NOPE = 1", label="Sewer")],
                          not_found=[])
    keep, problems = utilities.verify(p, BOX)
    assert [x["kind"] for x in keep] == ["water_main"]
    assert any(bad in x for x in problems)


# ---------------------------------------------------------------- assessor
def test_assessor_card_for_another_parcel_is_rejected():
    url = "https://assessor.example.gov/card?pin=0123456789"
    seed_page(url, "<html><body><h1>Property record</h1><p>Parcel 0999999999</p><p>1500 MAIN ST</p></body></html>")
    p = AssessorProposal(card_url=url, parcel_id="0123456789", url_pattern=None)
    ok, problems, _ = assessor.verify(p, [{"id": "0123456789", "address": "1500 MAIN ST"}], registry.state("08"))
    assert not ok and any("not on the card page" in x for x in problems)


# ---------------------------------------------------------------- corpus
def test_corpus_drops_unbacked_rules_hosts_and_sections():
    url = "https://library.municode.com/co/example/codes/zoning"
    sec = ("Sec. 3.2. Mixed use districts. Multifamily dwellings are permitted by right in the C-MX districts, "
           "with a maximum height of 75 feet.")
    seed_page(url, f"<html><body><h2>Article 3</h2><p>{sec}</p></body></html>")
    seed_page("https://www.lawfirm.com/blog", "<html><body><p>" + "x" * 60 + "</p></body></html>")
    cite = {"doc_id": "example_zoning_art3", "section": "Sec. 3.2", "quote": "with a maximum height of 75 feet"}
    p = CorpusProposal.model_validate({
        "documents": [
            {"doc_id": "example_zoning_art3", "title": "Example zoning", "url": url, "path_name": "Mixed use",
             "sections": [{"heading": "Sec. 3.2", "text": sec},
                          {"heading": "Sec. 9", "text": "This section text was never on the fetched page at all."}]},
            {"doc_id": "lawfirm_summary", "title": "Blog", "url": "https://www.lawfirm.com/blog", "path_name": None,
             "sections": [{"heading": "x", "text": "x" * 60}]}],
        "rules": [
            {"path": "Mixed use", "rule": "max_height_ft", "value": 85, "cite": cite},
            {"path": "Mixed use", "rule": "max_height_ft", "value": 75, "cite": cite},
            {"path": "Mixed use", "rule": "eligible", "value": True,
             "cite": {**cite, "quote": "Multifamily dwellings are permitted by right"}},
            {"path": "Mixed use", "rule": "allows_uses", "value": ["residential"],
             "cite": {**cite, "quote": "Multifamily dwellings are permitted by right"}},
            {"path": "Mixed use", "rule": "approval_steps", "value": "TODO", "cite": cite}],
        "paths": [{"name": "Mixed use", "kind": "both"}],
        "not_covered": ["density bonus"]})
    v = corpus.verify(p, "co_example")
    reasons = dict(v["rejected"])
    assert [(r["rule"], r["value"]) for r in v["rules"]] == [
        ("max_height_ft", 75), ("eligible", True), ("allows_uses", ["residential"]), ("approval_steps", "TODO")]
    assert "85 does not appear in the quote" in reasons["rule Mixed use / max_height_ft"]
    assert "not an allowed official" in reasons["document lawfirm_summary"]
    assert "not verbatim" in reasons["example_zoning_art3 / Sec. 9"]
    assert [s["heading"] for s in v["docs"][0]["sections"]] == ["Sec. 3.2"]


def test_corpus_page_hint_hosts_and_minimum_rules():
    url = "https://denvergov.org/zoning-code.pdf"
    sec = "Sec. 7.1. Multifamily dwellings are permitted by right in the C-MX-8 zone district of the city."
    seed_page(url, pdf(["Article 7 contents and definitions of this code.", sec]))
    cite = {"doc_id": "denver_art7", "section": "Sec. 7.1", "quote": "Multifamily dwellings are permitted by right"}
    full = {"path": "City zoning", "cite": cite}
    p = CorpusProposal.model_validate({
        "documents": [{"doc_id": "denver_art7", "title": "Denver zoning", "url": url, "path_name": "City zoning",
                       "sections": [{"heading": "Sec. 7.1", "text": sec, "page": 1}]}],   # text is on page 2
        "rules": [{**full, "rule": "eligible", "value": True, "applies_if": {"zoning_code": {"in": ["C-MX-8"]}}},
                  {**full, "rule": "allows_uses", "value": ["residential"]},
                  {**full, "rule": "approval_steps", "value": "TODO"},
                  {"path": "Only eligible", "rule": "eligible", "value": True, "cite": cite}],
        "paths": [{"name": "City zoning", "kind": "both"}, {"name": "Only eligible", "kind": "both"}],
        "not_covered": []})
    assert "not an allowed official" in dict(corpus.verify(p, "co_example")["rejected"])["document denver_art7"]
    v = corpus.verify(p, "co_example", {"denvergov.org"})
    reasons = dict(v["rejected"])
    assert [s["heading"] for s in v["docs"][0]["sections"]] == ["Sec. 7.1"]   # wrong page hint ignored
    assert {r["path"] for r in v["rules"]} == {"City zoning"} and list(v["paths"]) == ["City zoning"]
    assert reasons["path Only eligible"] == "path lacks eligible/allows_uses/approval_steps rules"


def test_corpus_section_may_cross_a_pdf_running_footer():
    url = "https://leg.example.gov/bill.pdf"
    seed_page(url, pdf(["29-37-205. A transit-oriented community shall designate\nPAGE 1-HOUSE BILL 24-1313",
                        "an area as a transit center of at least fifteen units per acre.\nPAGE 2-HOUSE BILL 24-1313",
                        "29-37-206. Reports.\nPAGE 3-HOUSE BILL 24-1313"]))
    joined = ("29-37-205. A transit-oriented community shall designate an area as a transit center of at least "
              "fifteen units per acre.")
    skipped = "29-37-205. A transit-oriented community shall designate an area of at least fifteen units per acre."
    p = CorpusProposal.model_validate({
        "documents": [{"doc_id": "bill", "title": "Bill", "url": url, "path_name": None,
                       "sections": [{"heading": "29-37-205", "text": joined},
                                    {"heading": "29-37-205 elided", "text": skipped}]}],
        "rules": [], "paths": [], "not_covered": []})
    v = corpus.verify(p, "co_example")
    assert [s["heading"] for s in v["docs"][0]["sections"]] == ["29-37-205"]
    assert "not verbatim" in dict(v["rejected"])["bill / 29-37-205 elided"]
