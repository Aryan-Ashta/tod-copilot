"""CoStarProvider: the CoStar HackPrinceton data extract (Houston and LA), recorded by
`scripts/record_fixtures.py --only costar` into fixtures/<locale>/costar/*.json (git-ignored: hackathon use only).

Field mapping and derivations: backend/data/costar_fields.md.
"""
from datetime import datetime

from backend.data.providers._base import fx, load_json, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced

FILES = {Capability.PARCELS: "parcels.json", Capability.OWNERSHIP_SALES: "parcels.json",
         Capability.LEASES: "leases.json", Capability.BUILDING_ATTRS: "buildings.json"}


class FixtureRecordProvider:
    """Records shaped `{"id", "parcel_id"?, "fields": {field: {"value", "source_url", "note", "confidence"?,
    "retrieved_at"?}}}`; a field's own confidence and retrieval time override the provider's."""
    name = ""
    folder = ""
    confidence = "medium"
    files = FILES

    def covers(self, locale: Locale, cap: Capability) -> bool:
        if cap not in self.files:
            return False
        p = fx(locale.id, self.folder, self.files[cap])
        return p.exists() and bool(load_json(p))

    def fetch(self, locale: Locale, cap: Capability, **kw) -> list[dict]:
        at = retrieved(locale.id, self.folder)
        out = []
        for rec in load_json(fx(locale.id, self.folder, self.files[cap])):
            row = {"id": rec["id"]}
            if rec.get("parcel_id"):
                row["parcel_id"] = rec["parcel_id"]
            if rec.get("geometry"):
                row["geometry"] = rec["geometry"]
            for field, v in rec.get("fields", {}).items():
                t = datetime.fromisoformat(v["retrieved_at"]) if v.get("retrieved_at") else at
                row[field] = Sourced(value=v["value"], prov=prov(self.name, v.get("confidence") or self.confidence, t,
                                                                 v.get("source_url"), v.get("note")))
            out.append(row)
        return out


class CoStarProvider(FixtureRecordProvider):
    name = "costar"
    folder = "costar"
    confidence = "high"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return locale.data_tier == "costar_full" and super().covers(locale, cap)
