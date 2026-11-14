"""MatterportProvider: interiors where scanned.

TODO(kickoff): Matterport access. No scan data is public, so no fixtures exist and this covers nothing.
"""
from backend.data.providers._base import fx, load_json, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


class MatterportProvider:
    name = "matterport"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.INTERIORS and fx(locale.id, "matterport", "interiors.json").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> list[dict]:
        at = retrieved(locale.id, "matterport")
        return [{"id": r["id"], **{k: Sourced(value=v["value"], prov=prov(self.name, "high", at, v.get("source_url")))
                                   for k, v in r["fields"].items()}}
                for r in load_json(fx(locale.id, "matterport", "interiors.json"))]
