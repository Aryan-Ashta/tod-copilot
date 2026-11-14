"""Parcel source scout end to end with a scripted fake chat model (docs/12 §14): deepagents runs the real probe and
check tools against seeded ArcGIS responses for a fake county, the verifier accepts the proposal and the registry
gets an agent_verified `parcels` section; a second onboarding skips it without calling the model. Offline."""
import pytest
import yaml
from langchain_core.messages import AIMessage

from backend import settings
from backend.onboard import registry
from backend.onboard.arcgis import query_params, sample_params
from backend.onboard.common import sample_box, thresholds
from backend.onboard.run import onboard_county
from backend.research.tools import FixtureSearch
from backend.tests.research_helpers import seed_json
from backend.tests.test_research_agent_fake import Exploding, ScriptedModel, _call

FIPS = "99001"
LONLAT = (-100.0, 40.0)
LAYER = "https://gis.example.gov/arcgis/rest/services/Parcels/MapServer/0"


@pytest.fixture
def county(tmp_path, monkeypatch):
    reg = tmp_path / "registry"
    (reg / "counties").mkdir(parents=True)
    states = yaml.safe_load((registry.REGISTRY_DIR / "us_states.yaml").read_text())
    (reg / "us_states.yaml").write_text(yaml.safe_dump({**states, "99": {"usps": "ZZ", "name": "Testland"}}))
    (reg / "counties" / f"{FIPS}.yaml").write_text(yaml.safe_dump({
        "fips": FIPS, "name": "Test County", "state": "99", "sample_lonlat": list(LONLAT)}))
    monkeypatch.setattr(registry, "REGISTRY_DIR", reg)
    monkeypatch.setattr(settings, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(settings, "OFFLINE", False)
    registry.clear_cache()
    box = sample_box(*LONLAT, thresholds()["onboard_sample_box_m"])
    fields = [{"name": n, "type": t} for n, t in (("OBJECTID", "esriFieldTypeOID"), ("PIN", "esriFieldTypeString"),
                                                   ("SITUS", "esriFieldTypeString"), ("USECODE", "esriFieldTypeString"))]
    seed_json(LAYER, {"f": "json"}, {"name": "Parcels", "geometryType": "esriGeometryPolygon",
                                     "objectIdField": "OBJECTID", "maxRecordCount": 2000, "fields": fields})
    recs = [{"OBJECTID": i, "PIN": f"P{i:04d}", "SITUS": f"{100 + i} OAK ST", "USECODE": "0100"} for i in range(30)]
    seed_json(f"{LAYER}/query", sample_params(box), {"features": [{"attributes": r} for r in recs[:5]]})
    seed_json(f"{LAYER}/query", query_params(box, "1=1", "*", True, "OBJECTID", 0, 200),
              {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": r} for r in recs]})
    yield reg
    registry.clear_cache()


def test_parcel_scout_writes_a_verified_section(county):
    proposal = {"status": "found", "layer_url": LAYER, "where": "1=1",
                "fields": {"id": {"field": "PIN"}, "address": {"field": "SITUS", "strip": True},
                           "raw_use": {"field": "USECODE"}},
                "notes": {}, "evidence_url": LAYER}
    model = ScriptedModel(messages=iter([
        _call("arcgis_layer", {"url": LAYER}, 1),
        _call("arcgis_sample", {"url": LAYER}, 2),
        _call("check_parcel_source", {"proposal": proposal}, 3),
        _call("ParcelSourceProposal", proposal, 4),
        AIMessage(content="done"),
    ]))
    out = onboard_county(FIPS, only={"parcels"}, model=model, search=FixtureSearch({}), step=lambda s: None)
    assert out["done"] == ["parcels"] and not out["errors"], out
    section = yaml.safe_load((county / "counties" / f"{FIPS}.yaml").read_text())["parcels"]
    assert section["status"] == "agent_verified"
    assert section["coverage"]["id"] == 1.0 and section["url"] == LAYER

    again = onboard_county(FIPS, only={"parcels"}, model=Exploding(messages=iter([])), search=FixtureSearch({}),
                           step=lambda s: None)
    assert again["skipped"] == ["parcels: present"] and not again["done"]
