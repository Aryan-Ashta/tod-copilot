"""VexcelProvider: Vexcel API 2.0 Elements, recorded by `scripts/record_fixtures.py --only vexcel`
(git-ignored: hackathon use only). IMAGERY = surface-parking parcels; FOOTPRINTS = building footprints and roof area."""
from backend.data.providers.costar import FixtureRecordProvider
from backend.data.resolver import Capability


class VexcelProvider(FixtureRecordProvider):
    name = "vexcel"
    folder = "vexcel"
    confidence = "high"
    files = {Capability.IMAGERY: "imagery.json", Capability.FOOTPRINTS: "footprints.json"}
