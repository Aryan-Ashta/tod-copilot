"""FccBroadbandProvider: FCC Broadband Data Collection availability per H3 resolution-8 cell.

Fixture `fcc/broadband.json` (written by `record_fixtures.py --only fcc`): `{"h3_res": 8, "cells": [{"h3",
"served_share", "total_bsl", ...}]}`. A cell counts as served at 100/20 when its served share exceeds factor
`broadband_served_share_min`. The fetched value adds a `by_h3` index; look up a point with `served_at(value, lon, lat)`.
"""
from typing import Optional

import h3

from backend.data.factors import resolve
from backend.data.providers._base import first_url, fx, load_json, meta, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced


def served_at(value: dict, lon: float, lat: float) -> Optional[bool]:
    """served_100_20 of the cell containing (lon, lat); None when no recorded cell covers it."""
    cell = h3.latlng_to_cell(lat, lon, value["h3_res"])
    c = value["by_h3"].get(cell)
    return None if c is None else c["served_100_20"]


class FccBroadbandProvider:
    name = "fcc"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.BROADBAND and fx(locale.id, "fcc", "broadband.json").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Sourced:
        d = load_json(fx(locale.id, "fcc", "broadband.json"))
        floor = resolve(locale.id)["broadband_served_share_min"]
        cells = [{**c, "served_100_20": c["served_share"] > floor} for c in d["cells"]]
        value = {"h3_res": d["h3_res"], "cells": cells, "by_h3": {c["h3"]: c for c in cells}}
        return Sourced(value=value, prov=prov(self.name, "medium", retrieved(locale.id, "fcc"),
                                              first_url(locale.id, "fcc"), meta(locale.id, "fcc").get("note")))
