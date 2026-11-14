"""AgentResearchProvider: building and parcel facts found by the agent research pipeline (docs/12) and verified in
code (quote on the cached page, value parsed from the quote), recorded by
`scripts/record_fixtures.py --only agent_research`. Sits below CoStar and hand research, above county parcels.
Each value carries its own confidence (capped at medium) and the quote in its note."""
from backend.data.providers.costar import FixtureRecordProvider
from backend.data.resolver import Capability


class AgentResearchProvider(FixtureRecordProvider):
    name = "agent_research"
    folder = "agent_research"
    confidence = "low"
    files = {Capability.PARCELS: "parcels.json", Capability.OWNERSHIP_SALES: "parcels.json",
             Capability.BUILDING_ATTRS: "buildings.json"}
