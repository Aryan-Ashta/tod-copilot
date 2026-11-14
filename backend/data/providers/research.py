"""PublicResearchProvider: hand-entered building facts from cited public sources (listings, press, assessor,
studies), recorded by `scripts/record_fixtures.py --only research`. Every field carries its source URL."""
from backend.data.providers.costar import FixtureRecordProvider
from backend.data.resolver import Capability


class PublicResearchProvider(FixtureRecordProvider):
    name = "public_research"
    folder = "research"
    confidence = "medium"
    files = {Capability.PARCELS: "parcels.json", Capability.OWNERSHIP_SALES: "parcels.json",
             Capability.BUILDING_ATTRS: "buildings.json"}
