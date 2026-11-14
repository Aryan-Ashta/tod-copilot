"""DerivedInteriorProvider: interiors estimated from the footprint when nothing is scanned (docs/03).

floor_depth_ft = short side of the minimum rotated rectangle / 2 - core depth. Never presented as measured.
"""
import math
from functools import lru_cache

from backend.data.factors import resolve
from backend.data.geo import SQFT_PER_M2, to_utm
from backend.data.providers._base import features, fx, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced

NOTE = "derived from footprint, not measured"
FT_PER_M = 3.28084


def short_side_ft(utm_geom) -> float:
    r = utm_geom.minimum_rotated_rectangle
    xs = list(r.exterior.coords)
    sides = [math.dist(xs[i], xs[i + 1]) for i in range(len(xs) - 1)]
    return min(s for s in sides if s > 0) * FT_PER_M if sides else 0.0


def derive_rentable_sqft(footprint_sqft: float, stories: int, efficiency: float) -> float:
    return footprint_sqft * stories * efficiency


class DerivedInteriorProvider:
    name = "derived"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap == Capability.INTERIORS and fx(locale.id, "osm", "buildings.geojson").exists()

    def fetch(self, locale: Locale, cap: Capability, **kw) -> list[dict]:
        return _derive(locale.id, locale.utm_epsg)


@lru_cache(maxsize=None)
def _derive(locale_id: str, epsg: int) -> list[dict]:
    core = resolve(locale_id)["derived_core_depth_ft"]
    p = prov("derived", "low", retrieved(locale_id, "osm"), None, NOTE)
    out = []
    for f in features(fx(locale_id, "osm", "buildings.geojson")):
        g = to_utm(f["geometry"], epsg)
        if g.is_empty or g.area <= 0:
            continue
        area = g.area * SQFT_PER_M2
        depth = max(0.0, short_side_ft(g) / 2 - core)
        out.append({"id": f["properties"]["id"],
                    "floor_depth_ft": Sourced(value=round(depth, 1), prov=p),
                    "typical_floor_sqft": Sourced(value=round(area), prov=p),
                    "roof_area_sqft": Sourced(value=round(area), prov=p),
                    "footprint_sqft": Sourced(value=round(area), prov=p)})
    return out
