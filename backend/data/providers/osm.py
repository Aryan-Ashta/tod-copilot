"""OsmProvider: footprints, streets, amenities, walk network, surface-parking flags, sparse building attrs."""
import gzip
import json
from functools import lru_cache

from backend.data.factors import resolve
from backend.data.providers._base import features, fx, prov, retrieved
from backend.data.resolver import Capability
from backend.schemas import Locale, Sourced

OSM_URL = "https://www.openstreetmap.org"
TYPE_MAP = {"office": "office", "commercial": "retail", "retail": "retail", "hotel": "hotel",
            "industrial": "industrial", "warehouse": "industrial", "parking": "parking_garage",
            "apartments": "residential", "residential": "residential"}
CAPS = {Capability.FOOTPRINTS, Capability.STREETS, Capability.AMENITIES, Capability.WALK_NETWORK,
        Capability.EV_CHARGING, Capability.IMAGERY, Capability.BUILDING_ATTRS}
AMENITY_KINDS = {"school", "clinic", "park", "grocery"}


def _num(v):
    try:
        return float(str(v).split(";")[0].replace("m", "").strip())
    except (TypeError, ValueError):
        return None


@lru_cache(maxsize=None)
def walk_graph(locale_id: str) -> dict:
    with gzip.open(fx(locale_id, "osm", "walk_graph.json.gz"), "rt") as fh:
        return json.load(fh)


class OsmProvider:
    name = "osm"

    def covers(self, locale: Locale, cap: Capability) -> bool:
        return cap in CAPS and fx(locale.id, "osm", "buildings.geojson").exists()

    def _p(self, locale: Locale, note=None):
        return prov(self.name, "medium", retrieved(locale.id, "osm"), OSM_URL, note)

    def fetch(self, locale: Locale, cap: Capability, **kw):
        feats = features(fx(locale.id, "osm", "features.geojson"))
        if cap == Capability.FOOTPRINTS:
            p = self._p(locale, "OpenStreetMap building footprint")
            return [{"id": f["properties"]["id"], "geometry": f["geometry"]}
                    for f in features(fx(locale.id, "osm", "buildings.geojson"))]
        if cap == Capability.BUILDING_ATTRS:
            return self._attrs(locale)
        if cap == Capability.IMAGERY:
            p = self._p(locale, "surface parking from OSM amenity=parking (parking=surface or untagged)")
            return [{"id": f["properties"]["id"], "geometry": f["geometry"], "surface_parking": Sourced(value=True, prov=p)}
                    for f in feats if f["properties"]["kind"] == "parking_surface"]
        if cap == Capability.STREETS:
            return Sourced(value={"bike_lanes": [f for f in feats if f["properties"]["kind"] == "bike_lane"],
                                  "rail": [f for f in feats if f["properties"]["kind"] == "rail"]},
                           prov=self._p(locale, "OSM cycleways and rail lines"))
        if cap == Capability.AMENITIES:
            return Sourced(value=[f for f in feats if f["properties"]["kind"] in AMENITY_KINDS],
                           prov=self._p(locale, "OSM schools, clinics/doctors/hospitals, parks, supermarkets"))
        if cap == Capability.EV_CHARGING:
            return Sourced(value=[f for f in feats if f["properties"]["kind"] == "ev_charger"],
                           prov=self._p(locale, "OSM amenity=charging_station (AFDC fallback)"))
        if cap == Capability.WALK_NETWORK:
            return Sourced(value=walk_graph(locale.id), prov=self._p(locale, "OSM walkable ways (osmnx walk filter)"))
        raise ValueError(cap)

    def _attrs(self, locale: Locale) -> list[dict]:
        story_ft = resolve(locale.id)["story_height_ft"]
        out = []
        for f in features(fx(locale.id, "osm", "buildings.geojson")):
            pr = f["properties"]
            row = {"id": pr["id"]}
            levels, height = _num(pr.get("levels")), _num(pr.get("height"))
            if levels:
                row["stories"] = Sourced(value=int(round(levels)), prov=prov(self.name, "low", retrieved(locale.id, "osm"),
                                                                            OSM_URL, "OSM building:levels"))
            elif height:
                row["stories"] = Sourced(value=max(1, int(round(height * 3.28084 / story_ft))),
                                         prov=prov(self.name, "low", retrieved(locale.id, "osm"), OSM_URL,
                                                   "OSM height / factor story_height_ft"))
            pt = TYPE_MAP.get(pr.get("building") or "")
            if pt:
                row["property_type"] = Sourced(value=pt, prov=prov(self.name, "low", retrieved(locale.id, "osm"),
                                                                   OSM_URL, f"OSM building={pr.get('building')}"))
            if pr.get("name"):
                row["name"] = Sourced(value=pr["name"], prov=prov(self.name, "low", retrieved(locale.id, "osm"), OSM_URL))
            if len(row) > 1:
                out.append(row)
        return out
