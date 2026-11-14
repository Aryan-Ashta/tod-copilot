from datetime import datetime, timezone

from backend.data.factors import resolve
from backend.models.reuse import ramp, score_reuse
from backend.schemas import Building, LegalPath, Provenance, Sourced

P = Provenance(source="costar_fixture", confidence="medium", retrieved_at=datetime.now(timezone.utc))
D = Provenance(source="derived", confidence="low", retrieved_at=datetime.now(timezone.utc))


def s(v, p=P):
    return Sourced(value=v, prov=p)


def building(**kw):
    base = dict(id="b", parcel_id="p", footprint={}, property_type=s("office"), building_class=s(None),
                year_built=s(1965), year_renovated=s(None), stories=s(20), rentable_area_sqft=s(400_000),
                typical_floor_sqft=s(15_000), vacancy_pct=s(60), asking_rent_usd_sqft_yr=s(18), parking_spaces=s(None),
                floor_depth_ft=s(30, D), ceiling_height_ft=s(None), window_wall_pct=s(None), roof_area_sqft=s(None),
                name=s("T"))
    base.update(kw)
    return Building(**base)


def test_ramp():
    assert ramp(10, 5, 20, 0.25) == 1
    assert ramp(22.5, 5, 20, 0.25) == 0.5   # 2.5 over a 5-wide band
    assert ramp(0, 4, None, 0.25) == 0


def test_feasible_office_converts_and_derived_caps_confidence():
    f = resolve("houston_downtown")
    path = LegalPath(name="Houston development rules", eligible=True,
                     allows={"allows_uses": ["residential", "hotel", "mixed_use", "keep_current"]}, citations=[])
    c = score_reuse(building(), [path], None, {"park": 100, "clinic": 100, "grocery": 100, "frequent_stop": 100},
                    s(20_000_000.0), f, locale_id="houston_downtown", data_tier="costar_full", year=2026)
    assert c.best_use != "keep_current"
    assert c.est_units == int(400_000 * f["reuse_efficiency_factor"] // f["avg_unit_sqft_residential"])
    assert c.confidence == "low"  # derived floor depth
    assert any("ceiling height missing" in b for b in c.blockers)


def test_uncovered_legal_scores_point_three():
    f = resolve("houston_downtown")
    c = score_reuse(building(), [LegalPath(name="x", eligible=None, allows={}, citations=[])], None, {}, None, f,
                    locale_id="houston_downtown", data_tier="public_only", year=2026)
    assert c.scores_by_use["residential"].legal == 0.3
    assert "legal status not covered by corpus" in c.blockers and c.screening_only
