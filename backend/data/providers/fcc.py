"""FccBroadbandProvider: FCC National Broadband Map.

TODO(kickoff): the FCC map's public API needs an account token; no fixture was recorded, so broadband is
missing for every locale and readiness reports "broadband data not available here".
"""
from backend.data.providers._base import fx, load_json, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class FccBroadbandProvider:
    name = "fcc"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.BROADBAND and fx(locale.id, "fcc", "broadband.json").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        return Sourced(value=load_json(fx(locale.id, "fcc", "broadband.json")),
                       prov=prov(self.name, "medium", retrieved(locale.id, "fcc")))
