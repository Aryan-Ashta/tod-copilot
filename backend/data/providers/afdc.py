"""AfdcProvider: EV chargers from the NREL Alternative Fuels Data Center."""
from backend.data.providers._base import features, first_url, fx, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class AfdcProvider:
    name = "afdc"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.EV_CHARGING and fx(locale.id, "afdc", "stations.geojson").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        p = prov(self.name, "high", retrieved(locale.id, "afdc"), first_url(locale.id, "afdc"),
                 "NREL Alternative Fuels Data Center, electric stations")
        return Sourced(value=features(fx(locale.id, "afdc", "stations.geojson")), prov=p)
