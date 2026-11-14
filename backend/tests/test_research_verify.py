"""Verifier table tests (docs/12 §10): every check rejects what it should, a clean fact is accepted with the parsed
value and a provenance note that carries the quote."""
import pytest

from backend import settings
from backend.data.factors import resolve
from backend.research import pages, registry
from backend.research.verify import Accepted, BuildingRef, Rejected, parse_value, verify_fact
from backend.schemas import ResearchedFact
from backend.tests.research_helpers import RETRIEVED, pdf, seed_page

LA, TX = "06037", "48201"
URL = "https://example.org/wilshire-tower"
PDF_URL = "https://example.org/study.pdf"
PAGE = """<html><head><title>Wilshire Tower</title><script>var x = "9 stories";</script></head><body>
<h1>Wilshire Tower</h1><p>The Wilshire Tower at 3600 Wilshire Blvd. was built in 1962 and rises 22 stories.</p>
<p>Vacancy stood at 38% in Q2 2026, according to the leasing team.</p>
<p>Asking rents average $3.10/sf per month.</p>
<p>The property sold in March 2025 for $41.5 million to Example Capital.</p>
</body></html>"""
OTHER = ("<html><body><p>Across town, 900 Main Street is a 15-story office building with 120,000 square feet."
         "</p>" + "<p>filler text.</p>" * 400 + "</body></html>")
REF = BuildingRef(building_id="osm:w1", name=None, address="3600 WILSHIRE BLVD LOS ANGELES CA 90010", osm_levels=21,
                  footprint_sqft=20000)


@pytest.fixture(autouse=True)
def cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "CACHE_DIR", tmp_path)
    pages._cached.cache_clear()
    seed_page(URL, PAGE)
    seed_page("https://example.org/other", OTHER)
    seed_page("https://www.loopnet.com/Listing/3600-Wilshire", PAGE)
    seed_page(PDF_URL, pdf(["Cover: Downtown Office Study 2023",
                            "Wilshire Tower 3600 Wilshire Blvd STORIES: 22 TYPICAL FLOOR SIZE: 18,500 SF"]))
    yield


def fact(field, value, quote, url=URL, **kw):
    return ResearchedFact(field=field, value=value, source_url=url, quote=quote, **kw)


def run(fct, ref=REF, county=LA):
    return verify_fact(fct, registry.spec_for(fct.field), ref, resolve("la_wilshire_koreatown"), county_fips=county,
                       year=2026)


def test_accepts_clean_fact_with_parsed_value_and_quote_in_note():
    v = run(fact("stories", "22", "was built in 1962 and rises 22 stories", source_type="press"))
    assert isinstance(v, Accepted), v
    assert v.value == 22 and isinstance(v.value, int)          # parsed by code, not the LLM's string
    assert "rises 22 stories" in v.note and "agent-found, code-verified" in v.note
    assert v.retrieved_at == RETRIEVED and v.confidence == "low"


def test_accepts_pdf_page_quote_with_medium_confidence():
    v = run(fact("typical_floor_sqft", 18500, "TYPICAL FLOOR SIZE: 18,500 SF", url=PDF_URL, page=2,
                 source_type="building_profile_study"))
    assert isinstance(v, Accepted), v
    assert v.value == 18500 and v.confidence == "medium"


def test_usd_with_multiplier():
    v = run(fact("last_sale_usd", 41500000, "sold in March 2025 for $41.5 million", source_type="press",
                 as_of="2025"))
    assert isinstance(v, Accepted), v
    assert v.value == 41_500_000


@pytest.mark.parametrize("fct,check", [
    (fact("stories", 22, "rises 22 stories above Wilshire Boulevard"), "quote_missing"),
    (fact("stories", 25, "was built in 1962 and rises 22 stories"), "value_mismatch"),
    (fact("vacancy_pct", 38, "Vacancy stood at 38% in Q2 2026", as_of="Q2 2019"), "stale"),
    (fact("stories", 22, "was built in 1962 and rises 22 stories", url="https://example.org/never-fetched"),
     "not_fetched"),
    (fact("stories", 22, "was built in 1962 and rises 22 stories", url="https://www.loopnet.com/Listing/3600-Wilshire"),
     "denylisted"),
    (fact("stories", 15, "900 Main Street is a 15-story office building", url="https://example.org/other"),
     "identity"),
    (fact("asking_rent_usd_sqft_yr", 3.10, "Asking rents average $3.10/sf per month"), "unparseable"),
    (fact("stories", 22, "22 stories"), "quote_length"),
    (fact("typical_floor_sqft", 18500, "TYPICAL FLOOR SIZE: 18,500 SF", url=PDF_URL, page=1), "quote_missing"),
    (fact("made_up_field", 1, "was built in 1962 and rises 22 stories"), "unknown_field"),
])
def test_rejects(fct, check):
    v = run(fct)
    assert isinstance(v, Rejected), v
    assert v.check == check, v


def test_rejects_out_of_range():
    seed_page("https://example.org/tall", "<html><body><p>3600 Wilshire Blvd has 400 stories, they say.</p></body></html>")
    v = run(fact("stories", 400, "3600 Wilshire Blvd has 400 stories", url="https://example.org/tall"),
            ref=BuildingRef(building_id="osm:w1", address=REF.address))
    assert isinstance(v, Rejected) and v.check == "out_of_range"


def test_rejects_stories_far_from_osm_levels():
    v = run(fact("stories", 22, "was built in 1962 and rises 22 stories"),
            ref=BuildingRef(building_id="osm:w1", address=REF.address, osm_levels=12))
    assert isinstance(v, Rejected) and v.check == "osm_levels_within_2"


def test_rejects_sale_price_in_non_disclosure_state():
    v = run(fact("last_sale_usd", 41500000, "sold in March 2025 for $41.5 million"), county=TX)
    assert isinstance(v, Rejected) and v.check == "policy_blocked"


def test_missing_as_of_caps_time_varying_field_at_low():
    v = run(fact("typical_floor_sqft", 18500, "TYPICAL FLOOR SIZE: 18,500 SF", url=PDF_URL,
                 source_type="building_profile_study"))
    assert isinstance(v, Accepted) and v.confidence == "medium"   # not time-varying: no cap
    v = run(fact("vacancy_pct", 38, "Vacancy stood at 38% in Q2 2026", source_type="brokerage_report"))
    assert isinstance(v, Accepted) and v.confidence == "low"


@pytest.mark.parametrize("field,quote,want", [
    ("stories", "built in 1960, the 29-story tower", 29),
    ("parking_spaces", "PARKING: 1,300 spaces between 2 decks", 1300),
    ("vacancy_pct", "VACANT / AVAILABLE: 72%", 72),
    ("asking_rent_usd_sqft_yr", "CURRENT RENTS: $18.06 PSF (2023)", 18.06),
    ("rentable_area_sqft", "the 1.2 million square foot complex", 1_200_000),
    ("building_class", "Building Class: Class A office", "A"),
    ("year_built", "YEAR BUILT / RENOVATED: 1960", 1960),
])
def test_parsers(field, quote, want):
    assert parse_value(registry.spec_for(field), quote, want) == (want, "")


def test_parser_refuses_two_unanchored_values():
    v, why = parse_value(registry.spec_for("vacancy_pct"), "occupancy fell 20% while leasing rose 30% this year", 20)
    assert v is None and why.startswith("ambiguous")


def test_rejects_unlabelled_monthly_rent():
    seed_page("https://example.org/table", "<html><body><p>Submarket table: 3600 Wilshire Blvd asking rent $2.77 "
                                           "full service.</p></body></html>")
    v = run(fact("asking_rent_usd_sqft_yr", 2.77, "3600 Wilshire Blvd asking rent $2.77 full service",
                 url="https://example.org/table"), ref=BuildingRef(building_id="osm:w1", address=REF.address))
    assert isinstance(v, Rejected) and v.check == "out_of_range"


@pytest.mark.parametrize("field,quote", [
    ("year_built", "the original structure was built between 1857 and 1869"),
    ("asking_rent_usd_sqft_yr", "asking rents run $24 - $28 per square foot"),
    ("stories", "a 12 or 14 story tower is planned"),
])
def test_parser_never_narrows_a_range(field, quote):
    v, why = parse_value(registry.spec_for(field), quote)
    assert v is None and "range" in why
