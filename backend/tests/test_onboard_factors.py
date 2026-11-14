"""Per-locale factors for areas outside the recorded locales: area -> recorded locale -> county -> state -> national."""
import pytest
import yaml

from backend.data import locales
from backend.data.factors import LOCAL_KEYS, FactorMissing, load_factors, resolve
from backend.onboard import factors as scoped
from backend.onboard import registry

REAL_NATIONAL = registry.REGISTRY_DIR / "factors" / "national.yaml"
KEY = "rent_usd_per_unit_month"


def _entry(v, scope):
    return {"value": v, "unit": "USD/unit/month", "source_url": "https://example.gov", "verified": False,
            "scope": scope}


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A tmp registry with national/state/county files and a drawn Denver area in a tmp cache."""
    reg = tmp_path / "registry"
    (reg / "factors").mkdir(parents=True)
    national = yaml.safe_load(REAL_NATIONAL.read_text())
    (reg / "factors" / "national.yaml").write_text(yaml.safe_dump(national))
    monkeypatch.setattr(registry, "REGISTRY_DIR", reg)
    monkeypatch.setattr(locales, "CACHE_DIR", tmp_path / "cache")
    area = tmp_path / "cache" / "areas" / "area-test"
    area.mkdir(parents=True)
    (area / "locale.yaml").write_text(yaml.safe_dump({
        "id": "area-test", "name": "t", "purpose": "t", "data_tier": "public_only", "jurisdiction": "co_denver",
        "bbox": [-105.0, 39.7, -104.99, 39.71], "utm_epsg": 32613, "county_fips": "08031", "transit_agency": "",
        "stations": [], "aliases": [], "sources_from": None}))
    for fn in (locales.get_locale.cache_clear, scoped.clear_cache):
        fn()
    yield reg, area
    for fn in (locales.get_locale.cache_clear, scoped.clear_cache):
        fn()


def _write(reg, scope, data):
    (reg / "factors" / f"{scope}.yaml").write_text(yaml.safe_dump(data))
    scoped.clear_cache()


def test_area_file_wins(world):
    reg, area = world
    _write(reg, "county-08031", {KEY: _entry(1500, "county")})
    (area / "factors.yaml").write_text(yaml.safe_dump({KEY: _entry(1777, "area")}))
    assert resolve("area-test")[KEY] == 1777


def test_county_beats_state_beats_national(world):
    reg, _ = world
    national = yaml.safe_load((reg / "factors" / "national.yaml").read_text())[KEY]["value"]
    assert resolve("area-test")[KEY] == national
    _write(reg, "state-08", {KEY: _entry(1600, "state")})
    assert resolve("area-test")[KEY] == 1600
    _write(reg, "county-08031", {KEY: _entry(1650, "county")})
    assert resolve("area-test")[KEY] == 1650


def test_recorded_locale_keeps_its_mapping(world):
    reg, _ = world
    _write(reg, "county-48201", {KEY: _entry(1, "county")})
    assert resolve("houston_downtown")[KEY] == load_factors()[KEY].value["houston_downtown"]


def test_missing_everywhere_names_the_scopes(world):
    reg, _ = world
    national = yaml.safe_load((reg / "factors" / "national.yaml").read_text())
    del national[KEY]
    _write(reg, "national", national)
    with pytest.raises(FactorMissing, match=r"area, county-08031, state-08, national"):
        resolve("area-test")


def test_national_file_covers_every_local_key():
    national = yaml.safe_load(REAL_NATIONAL.read_text())
    assert set(LOCAL_KEYS) <= set(national)
    assert all(v["verified"] is False for v in national.values())
