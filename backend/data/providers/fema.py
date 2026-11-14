"""FemaProvider: FEMA NFHL special flood hazard areas (SFHA_TF = T)."""
from backend.data.providers._base import features, first_url, fx, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class FemaProvider:
    name = "fema"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.FLOOD and fx(locale.id, "fema", "flood_zones.geojson").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        p = prov(self.name, "high", retrieved(locale.id, "fema"), first_url(locale.id, "fema"),
                 "FEMA National Flood Hazard Layer, high-risk (SFHA) zones")
        return Sourced(value=features(fx(locale.id, "fema", "flood_zones.geojson")), prov=p)
