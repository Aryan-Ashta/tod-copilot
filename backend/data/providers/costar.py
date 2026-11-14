"""CoStarProvider: reads fixtures/<locale>/costar/*.json shaped like our schema.

TODO(kickoff): CoStar endpoint, auth, rate limits and exact field names (backend/data/costar_fields.md).
Until then the fixtures are hand-entered from cited public reporting (source "costar_fixture", medium).
"""
from backend.data.providers._base import features, fx, load_json, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced

FILES = {Capability.PARCELS: "parcels.json", Capability.OWNERSHIP_SALES: "parcels.json",
         Capability.LEASES: "leases.json", Capability.BUILDING_ATTRS: "buildings.json"}


class CoStarProvider:
    name = "costar_fixture"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        if locale.data_tier != "costar_full" or cap not in FILES:
            return False
        p = fx(locale.id, "costar", FILES[cap])
        if not p.exists():
            return False
        return cap != Capability.LEASES or bool(load_json(p))

    def fetch(self, locale: Locale, cap: Capability, **kw) -> list[dict]:
        at = retrieved(locale.id, "costar")
        out = []
        for rec in load_json(fx(locale.id, "costar", FILES[cap])):
            row = {"id": rec["id"]}
            if rec.get("parcel_id"):
                row["parcel_id"] = rec["parcel_id"]
            for field, v in rec["fields"].items():
                row[field] = Sourced(value=v["value"], prov=prov(self.name, "medium", at, v.get("source_url"),
                                                                 v.get("note")))
            out.append(row)
        return out


__all__ = ["CoStarProvider", "features"]
