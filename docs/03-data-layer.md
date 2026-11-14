# 03: Data layer

Agents never call a provider directly. They ask the **resolver** for a capability at a locale, and it returns `Sourced` values from the best provider that covers it.

## Interface

```python
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

class Provider(Protocol):
    name: str
    def covers(self, locale: Locale, cap: Capability) -> bool: ...
    def fetch(self, locale: Locale, cap: Capability, **kw): ...

class Resolver:
    def __init__(self, providers: list[Provider]): ...   # ordered best-first
    def get(self, locale: Locale, cap: Capability, **kw):
        for p in self.providers:
            if p.covers(locale, cap):
                return p.fetch(locale, cap, **kw)
        return missing(cap)   # Sourced(value=None, prov=Provenance(confidence="missing", note=...))
```

## Providers by locale

| Capability | Houston / LA (CoStar tier) | Brevard (public tier) |
| --- | --- | --- |
| PARCELS, OWNERSHIP_SALES | `CoStarProvider` · high | `CountyParcelProvider` · medium |
| LEASES | `CoStarProvider` · high | **missing**: no public source |
| BUILDING_ATTRS | `CoStarProvider` · high | `CountyParcelProvider` (year built, use, area only) · low |
| INTERIORS | `MatterportProvider` · high where scanned; else derived from footprint · low | derived from footprint · low |
| IMAGERY, FOOTPRINTS | `VexcelProvider` · high | `PublicImageryProvider` + open building footprints · medium |
| DEMAND | `LodesProvider` · medium | same |
| TRANSIT_EXISTING | `GtfsProvider` (Houston METRO, LA Metro) · high | `GtfsProvider` (Space Coast Area Transit) · high |
| STREETS, AMENITIES, WALK_NETWORK | `OsmProvider` · medium | same |
| UTILITIES | `CityOpenDataProvider` where a public layer exists · medium; else missing | same |
| EV_CHARGING | `AfdcProvider` (NREL Alternative Fuels Data Center) · high | same |
| BROADBAND | `FccBroadbandProvider` · medium | same |
| FLOOD | `FemaProvider` · high | same |

`TODO(kickoff)` for CoStar: endpoint, auth, rate limits, and the **exact field names** for each `Building` attribute in `schemas.py`. Write a mapping table in `backend/data/costar_fields.md` once known. Until then, implement against `fixtures/<locale>/costar/*.json` shaped like our schema, and mark the mapping as unconfirmed.

`TODO(kickoff)` for utilities: check each city's open data portal for water, sewer and power layers. If none is public, the capability is missing for that locale and the infrastructure agent says so.

## Deriving interiors without a scan

When there is no Matterport scan, estimate floor depth from the footprint: for a rectangular footprint, depth to the nearest exterior wall is about half the short side minus the core. Mark it `confidence="low"` with a note. Never present a derived value as measured.

## Rules

- **Provenance on everything.** Each `Sourced` value records source, confidence, `retrieved_at`, and URL when available.
- **Missing is a value.** Agents must handle `confidence="missing"` and say what's missing.
- **Locale-scoped.** Providers only fetch within `locale.bbox`. Drawn areas in Harris County or Los Angeles County get their own data directory (`cache/areas/<id>/`) and reuse their metro locale's sources (`Locale.sources_from`); supported county and city outlines are in `fixtures/metros/` (`record_fixtures.py --metros`).
- **Cache by request** in `cache/`. With `DEMO_OFFLINE=1`, a cache miss raises instead of calling out.
- **Record fixtures early** with `scripts/record_fixtures.py --locale <id>`.
- **Coordinates:** GeoJSON in WGS84; distance and area math in the locale's UTM zone.
