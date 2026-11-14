"""DemandProvider: homes, jobs and zero-car households (Census LODES, Decennial, ACS)."""
from backend.data.providers._base import first_url, fx, load_json, meta, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class DemandProvider:
    name = "census_lodes_acs"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.DEMAND and fx(locale.id, "demand", "points.json").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        p = prov(self.name, "medium", retrieved(locale.id, "demand"), first_url(locale.id, "demand"),
                 meta(locale.id, "demand").get("note"))
        return Sourced(value=load_json(fx(locale.id, "demand", "points.json")), prov=p)
