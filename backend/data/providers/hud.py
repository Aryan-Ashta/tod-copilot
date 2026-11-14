"""HudLihtcProvider: HUD LIHTC database, tax-credit properties and their low-income unit counts."""
from backend.data.providers._base import features, first_url, fx, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class HudLihtcProvider:
    name = "hud_lihtc"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.AFFORDABLE_INVENTORY and fx(locale.id, "hud", "lihtc.geojson").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        p = prov(self.name, "high", retrieved(locale.id, "hud"), first_url(locale.id, "hud"),
                 "HUD LIHTC database: tax-credit properties and their low-income unit counts")
        return Sourced(value=features(fx(locale.id, "hud", "lihtc.geojson")), prov=p)
