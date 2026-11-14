"""MatterportProvider: interiors measured from Matterport scans (Model API), recorded by
`scripts/record_fixtures.py --only matterport` (git-ignored: hackathon use only)."""
from backend.data.providers.costar import FixtureRecordProvider
from backend.data.resolver import Capability


class MatterportProvider(FixtureRecordProvider):
    name = "matterport"
    folder = "matterport"
    confidence = "high"
    files = {Capability.INTERIORS: "interiors.json"}
