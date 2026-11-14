"""Capability resolver (docs/03-data-layer.md). Agents ask for a capability; never a provider."""
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Protocol

from backend.schemas import Locale, Provenance, Sourced


class Capability(str, Enum):
    PARCELS = "parcels"
    OWNERSHIP_SALES = "ownership_sales"
    LEASES = "leases"
    BUILDING_ATTRS = "building_attrs"     # class, year built, stories, floor size, vacancy, rent, parking
    INTERIORS = "interiors"               # floor depth, ceiling height, windows (Matterport)
    IMAGERY = "imagery"                   # aerial tiles + derived flags (surface parking, roof area)
    FOOTPRINTS = "footprints"
    DEMAND = "demand"                     # homes, jobs, zero-car households
    TRANSIT_EXISTING = "transit_existing" # GTFS
    STREETS = "streets"                   # roads, sidewalks, bike lanes, crossings
    UTILITIES = "utilities"               # water, sewer, power where a public layer exists
    EV_CHARGING = "ev_charging"
    BROADBAND = "broadband"
    AMENITIES = "amenities"               # schools, clinics, parks, grocery
    WALK_NETWORK = "walk_network"
    FLOOD = "flood"
    AFFORDABLE_INVENTORY = "affordable_inventory"   # HUD LIHTC properties
    SOLAR = "solar"


RECORD_CAPS = {Capability.PARCELS, Capability.OWNERSHIP_SALES, Capability.LEASES, Capability.BUILDING_ATTRS,
               Capability.INTERIORS, Capability.IMAGERY, Capability.FOOTPRINTS}


class Provider(Protocol):
    name: str

    def covers(self, locale: Locale, cap: Capability) -> bool: ...

    def fetch(self, locale: Locale, cap: Capability, **kw) -> Any: ...


def missing(cap: Capability | str, note: str | None = None) -> Sourced:
    c = cap.value if isinstance(cap, Capability) else cap
    return Sourced(value=None, prov=Provenance(source="none", confidence="missing",
                                               retrieved_at=datetime.now(timezone.utc),
                                               note=note or f"{c}: no provider covers this locale"))


def _is_present(v: Any) -> bool:
    return isinstance(v, Sourced) and v.prov.confidence != "missing"


class Resolver:
    def __init__(self, providers: list[Provider]):
        self.providers = providers  # ordered best-first

    def covering(self, locale: Locale, cap: Capability) -> list[Provider]:
        return [p for p in self.providers if p.covers(locale, cap)]

    def get(self, locale: Locale, cap: Capability, **kw) -> Any:
        for p in self.providers:
            if p.covers(locale, cap):
                return p.fetch(locale, cap, **kw)
        return missing(cap)

    def get_records(self, locale: Locale, cap: Capability, **kw) -> list[dict]:
        """Merge records from every covering provider, best first, keyed by "id".

        Per field the first non-missing Sourced wins; geometry from the first provider that has one;
        records only a lower provider knows are kept.
        """
        merged: dict[str, dict] = {}
        for p in self.covering(locale, cap):
            for rec in p.fetch(locale, cap, **kw):
                cur = merged.setdefault(rec["id"], {"id": rec["id"]})
                for k, v in rec.items():
                    if k == "id":
                        continue
                    if k == "geometry":
                        if cur.get("geometry") is None and v is not None:
                            cur["geometry"] = v
                    elif isinstance(v, Sourced):
                        if not _is_present(cur.get(k)) and (_is_present(v) or k not in cur):
                            cur[k] = v
                    elif k not in cur:
                        cur[k] = v
        return list(merged.values())


def default_resolver() -> Resolver:
    from backend.data.providers import (afdc, agent_research, costar, county, demand, derived, fcc, fema, gtfs, hud,
                                        matterport, osm, pvwatts, research, utilities, vexcel)
    return Resolver([
        costar.CoStarProvider(), matterport.MatterportProvider(), vexcel.VexcelProvider(),
        research.PublicResearchProvider(), agent_research.AgentResearchProvider(),
        county.CountyParcelProvider(), afdc.AfdcProvider(), fcc.FccBroadbandProvider(),
        utilities.CityOpenDataProvider(), fema.FemaProvider(), hud.HudLihtcProvider(), gtfs.GtfsProvider(),
        demand.DemandProvider(),
        pvwatts.PvwattsProvider(), osm.OsmProvider(), derived.DerivedInteriorProvider(),
    ])
