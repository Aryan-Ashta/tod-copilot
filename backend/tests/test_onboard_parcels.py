"""The registry parcel DSL reproduces the hand-written county normalizers it replaced (cases recorded from them)."""
import json
from pathlib import Path

import pytest

from backend.onboard import registry
from backend.onboard.parcels import normalize

CASES = json.loads((Path(__file__).parent / "fixtures" / "onboard" / "parcel_norm_cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['county']}-{c['expected']['id']}")
def test_registry_fields_match_old_normalizers(case):
    fields = registry.county(case["county"])["parcels"]["fields"]
    got = normalize(fields, case["raw"])
    assert got == case["expected"]
    assert list(got) == list(case["expected"])   # key order keeps recorded geojson byte-stable
