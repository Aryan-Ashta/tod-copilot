from datetime import datetime, timezone

from backend.data.resolver import Capability, Resolver
from backend.schemas import Locale, Provenance, Sourced

LOC = Locale(id="houston_downtown", name="t", purpose="t", data_tier="costar_full", jurisdiction="houston",
             bbox=(0, 0, 1, 1), stations=[], utm_epsg=32615, county_fips="48201", transit_agency="METRO")


def s(v, src, conf="medium"):
    return Sourced(value=v, prov=Provenance(source=src, confidence=conf, retrieved_at=datetime.now(timezone.utc)))


class Fake:
    def __init__(self, name, caps, records):
        self.name, self.caps, self.records = name, caps, records

    def covers(self, locale, cap):
        return cap in self.caps

    def fetch(self, locale, cap, **kw):
        return self.records


def test_costar_field_wins_and_missing_falls_through():
    costar = Fake("costar", {Capability.BUILDING_ATTRS}, [
        {"id": "b1", "stories": s(20, "costar"), "year_built": s(None, "costar", "missing")}])
    county = Fake("county", {Capability.BUILDING_ATTRS}, [
        {"id": "b1", "stories": s(3, "county"), "year_built": s(1965, "county")},
        {"id": "b2", "stories": s(1, "county")}])
    recs = {r["id"]: r for r in Resolver([costar, county]).get_records(LOC, Capability.BUILDING_ATTRS)}
    assert recs["b1"]["stories"].value == 20 and recs["b1"]["stories"].prov.source == "costar"
    assert recs["b1"]["year_built"].value == 1965 and recs["b1"]["year_built"].prov.source == "county"
    assert recs["b2"]["stories"].value == 1  # record only a lower provider knows is kept


def test_absent_provider_gives_missing():
    r = Resolver([Fake("x", {Capability.FLOOD}, [])]).get(LOC, Capability.BROADBAND)
    assert r.value is None and r.prov.confidence == "missing"
