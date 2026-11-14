"""Onboarding runs the legal corpus builder for each corpus target once: a built (agent) corpus is skipped next time,
a curated rules file is never rebuilt, even under force. The builder itself is faked. Offline."""
import pytest
import yaml

from backend import settings
from backend.corpus import loader
from backend.onboard import corpus, registry
from backend.onboard import run as run_mod
from backend.onboard.run import onboard_county

FIPS = "99001"
BOX = (-100.01, 40.0, -100.0, 40.01)
TARGETS = ["state:08", f"county:{FIPS}"]


@pytest.fixture
def builds(tmp_path, monkeypatch):
    reg = tmp_path / "registry"
    (reg / "counties").mkdir(parents=True)
    states = yaml.safe_load((registry.REGISTRY_DIR / "us_states.yaml").read_text())
    (reg / "us_states.yaml").write_text(yaml.safe_dump({**states, "99": {"usps": "ZZ", "name": "Testland"}}))
    (reg / "counties" / f"{FIPS}.yaml").write_text(yaml.safe_dump(
        {"fips": FIPS, "name": "Test County", "state": "99", "sample_lonlat": [-100.0, 40.0]}))
    monkeypatch.setattr(registry, "REGISTRY_DIR", reg)
    monkeypatch.setattr(loader, "CORPUS_DIR", tmp_path / "corpus")
    monkeypatch.setattr(settings, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(settings, "OFFLINE", False)
    monkeypatch.setattr(run_mod, "llm_ready", lambda: True)
    registry.clear_cache()
    calls = []

    def fake_build(target, *, bbox=None, **kw):
        j = corpus.resolve_target(target)[0]
        calls.append((target, bbox))
        d = loader.agent_dir() / j
        d.mkdir(parents=True)
        (d / "review.md").write_text("# built\n")
        (d / "rules.yaml").write_text("[]\n")
        return {"rules": 1}
    monkeypatch.setattr(corpus, "build", fake_build)
    yield calls
    registry.clear_cache()
    loader.clear_cache()


def test_corpus_built_once_and_curated_never_rebuilt(builds):
    quiet = {"only": {"corpus"}, "corpus_targets": TARGETS, "step": lambda s: None}
    out = onboard_county(FIPS, BOX, **quiet)
    assert out["done"] == ["corpus state:08", f"corpus county:{FIPS}"] and not out["errors"]
    assert builds == [("state:08", BOX), (f"county:{FIPS}", BOX)]

    again = onboard_county(FIPS, BOX, **quiet)
    assert again["skipped"] == ["corpus state:08: present", f"corpus county:{FIPS}: present"]
    assert len(builds) == 2

    (loader.CORPUS_DIR / "rules").mkdir()
    (loader.CORPUS_DIR / "rules" / "colorado.yaml").write_text("[]\n")
    forced = onboard_county(FIPS, BOX, force=True, **quiet)
    assert forced["skipped"] == ["corpus state:08: present"]
    assert forced["done"] == [f"corpus county:{FIPS}"] and builds[-1][0] == f"county:{FIPS}" and len(builds) == 3
