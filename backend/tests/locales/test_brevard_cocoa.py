"""Brevard: public data only, greenfield transit around a planned station, flood risk (docs/11)."""
from backend.models.deal import LEASE_UNKNOWN

L = "brevard_cocoa"


def _sources(o, out):
    if isinstance(o, dict):
        if "source" in o and "confidence" in o:
            out.add(o["source"])
        for v in o.values():
            _sources(v, out)
    elif isinstance(o, list):
        for v in o:
            _sources(v, out)
    return out


def test_no_costar_source(plans):
    assert not any(s.startswith("costar") for s in _sources(plans(L).model_dump(mode="json"), set()))


def test_every_deal_flags_unknown_leases(plans):
    deals = plans(L).deals
    assert deals and all(LEASE_UNKNOWN in d.reasons for d in deals)


def test_no_new_homes_in_flood_zones(plans):
    t = {x.key: x for x in plans(L).targets}
    assert t["flood_exposure"].value == 0


def test_transit_upgrades_an_existing_route(plans):
    assert any(r.id.startswith("upg-") for r in plans(L).transit.routes)


def test_at_least_one_measurement(plans):
    assert plans(L).transit.measurements
