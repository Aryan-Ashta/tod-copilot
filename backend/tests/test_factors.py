import yaml

from backend.data.factors import FACTORS_PATH, LOCALE_IDS, resolve


def test_every_factor_has_required_fields():
    raw = yaml.safe_load(FACTORS_PATH.read_text())
    for key, entry in raw.items():
        for field in ("value", "unit", "source_url", "verified"):
            assert field in entry, f"{key} missing {field}"
        assert entry["source_url"] and entry["source_url"] != "TODO", f"{key} has no source"


def test_resolve_all_locales():
    for lid in LOCALE_IDS:
        f = resolve(lid)
        assert isinstance(f["cap_rate"], float)
        assert not isinstance(f["conversion_cost_usd_per_sqft"], dict)


def test_custom_area_uses_national_values():
    raw = yaml.safe_load(FACTORS_PATH.read_text())
    f = resolve("area-test")
    assert f["construction_cost_usd_per_unit"] == raw["construction_cost_usd_per_unit"]["value"]["national"]
    assert f["transit_budget_usd"] == raw["transit_budget_usd"]["value"]["national"]
