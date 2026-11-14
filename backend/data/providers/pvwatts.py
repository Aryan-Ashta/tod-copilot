"""PvwattsProvider: NREL PVWatts v8 annual AC output per kW at the locale centre."""
from backend.data.providers._base import first_url, fx, load_json, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class PvwattsProvider:
    name = "pvwatts"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.SOLAR and fx(locale.id, "pvwatts", "solar.json").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        d = load_json(fx(locale.id, "pvwatts", "solar.json"))
        return Sourced(value={"annual_kwh_per_kw": d["annual_kwh_per_kw"]},
                       prov=prov(self.name, "high", retrieved(locale.id, "pvwatts"), first_url(locale.id, "pvwatts"),
                                 "PVWatts v8: 1 kW, standard module, 14% losses, fixed open rack, tilt 20, azimuth 180"))
