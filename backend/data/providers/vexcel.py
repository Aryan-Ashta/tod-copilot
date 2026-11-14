"""VexcelProvider: imagery flags and footprints.

TODO(kickoff): Vexcel access. No Vexcel data is public, so no fixtures exist and this covers nothing.
"""
from backend.data.providers._base import fx, load_json, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced

FILES = {Capability.IMAGERY: "imagery.json", Capability.FOOTPRINTS: "footprints.json"}


class VexcelProvider:
    name = "vexcel"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap in FILES and fx(locale.id, "vexcel", FILES[cap]).exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> list[dict]:
        at = retrieved(locale.id, "vexcel")
        return [{"id": r["id"], "geometry": r.get("geometry"),
                 **{k: Sourced(value=v["value"], prov=prov(self.name, "high", at, v.get("source_url")))
                    for k, v in r.get("fields", {}).items()}}
                for r in load_json(fx(locale.id, "vexcel", FILES[cap]))]
