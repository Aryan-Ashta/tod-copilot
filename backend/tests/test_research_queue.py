"""Gap queue (docs/12 §5.1, §10): deterministic, never queues a value a real source already supplies, and state
policies remove fields in code."""
import pytest

from backend.models.research import needs_research
from backend.research.context import PlanContext


@pytest.fixture(scope="module")
def houston():
    return PlanContext("houston_downtown")


@pytest.fixture(scope="module")
def la():
    return PlanContext("la_wilshire_koreatown")


def test_queue_is_deterministic_and_ordered(houston):
    a, b = houston.queue(), houston.queue()
    assert [j.model_dump() for j in a] == [j.model_dump() for j in b]
    assert a, "Houston has candidate buildings with missing market data"
    assert len(a) <= houston.f["research_max_buildings"]
    assert all(j.swing >= houston.f["research_min_swing"] for j in a)
    assert [j.swing for j in a] == sorted((j.swing for j in a), reverse=True)
    assert len({j.job_id for j in a}) == len(a)


def test_queue_never_asks_for_values_a_source_already_has(houston):
    parcels = houston.ctx.cache["parcels_by_id"]
    for j in houston.queue():
        b = houston.by_id[j.building_id]
        for field in j.fields:
            sv = getattr(b, field) if hasattr(b, field) else getattr(parcels[j.parcel_id], field)
            assert needs_research(sv), (j.label, field, sv.prov.source)
            assert sv.prov.source not in ("costar", "public_research")


def test_texas_non_disclosure_removes_sale_price(houston, la):
    assert not any("last_sale_usd" in j.fields for j in houston.queue())
    assert any("last_sale_usd" in j.fields for j in la.queue())   # California has no such policy
