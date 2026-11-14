"""CityOpenDataProvider: public water/sewer/power layers where a city publishes them."""
from backend.data.providers._base import features, first_url, fx, meta, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced

KINDS = ("water_main", "sewer_main", "power_substation")


class CityOpenDataProvider:
    name = "city_open_data"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.UTILITIES and any(fx(locale.id, "utilities", f"{k}.geojson").exists() for k in KINDS)

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        layers = meta(locale.id, "utilities").get("layers", {})
        p = prov(self.name, "medium", retrieved(locale.id, "utilities"), first_url(locale.id, "utilities"),
                 "; ".join(f"{k}: {v}" for k, v in layers.items()))
        return Sourced(value={k: features(fx(locale.id, "utilities", f"{k}.geojson")) for k in KINDS
                              if fx(locale.id, "utilities", f"{k}.geojson").exists()}, prov=p)
