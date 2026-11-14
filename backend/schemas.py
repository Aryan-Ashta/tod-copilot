"""Shared Pydantic models: the single source of truth (docs/02-architecture.md).

Mirrored in frontend/src/types.ts. The block up to `Edit` is copied from docs/02; additions the
docs' own requirements need are marked "Addition".
"""
from datetime import datetime
from typing import Any, Generic, Literal, Optional, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")
Confidence = Literal["high", "medium", "low", "missing"]


class Provenance(BaseModel):
    source: str                 # "costar", "vexcel", "matterport", "county_parcels", "osm", "fema", "corpus", ...
    confidence: Confidence
    retrieved_at: datetime
    url: Optional[str] = None
    note: Optional[str] = None  # e.g. "lease data unavailable; verify before outreach"


class Sourced(BaseModel, Generic[T]):
    value: Optional[T]
    prov: Provenance


class Station(BaseModel):       # Addition: stations need a name, mode and source
    name: str
    lonlat: tuple[float, float]
    mode: Literal["light_rail", "heavy_rail", "intercity_rail_planned", "frequent_bus"]
    source_url: str
    note: Optional[str] = None


class Locale(BaseModel):
    id: str                     # recorded locale id, or "area-<hex8>" for a custom area
    name: str
    purpose: str                # one sentence, from docs/11-test-locales.md
    data_tier: Literal["costar_full", "public_only"]
    jurisdiction: str
    bbox: tuple[float, float, float, float]   # min lon, min lat, max lon, max lat
    stations: list[Station]     # Addition: was list[tuple[float, float]]
    utm_epsg: int               # Addition
    county_fips: str            # Addition (5-digit)
    transit_agency: str         # Addition
    boundary: Optional[dict] = None   # Addition: drawn GeoJSON Polygon/MultiPolygon (WGS84)
    aliases: list[str] = []           # Addition: city-search names
    sources_from: Optional[str] = None   # Addition: recorded locale whose county sources a custom area reuses
    costar_loaded: bool = False   # Addition: CoStar extract present on this machine (data_tier is the intended tier)


class Parcel(BaseModel):
    id: str
    geometry: dict              # GeoJSON polygon
    area_acres: Sourced[float]
    land_use: Sourced[str]      # "surface_parking", "retail_1story", "vacant", "office", ...
    owner: Sourced[str]
    last_sale_usd: Sourced[float]
    last_sale_year: Sourced[int]
    lease_expiry_year: Sourced[int]
    address: Sourced[str]               # Addition
    assessed_value_usd: Sourced[float]  # Addition: acquisition basis where sale prices are not disclosed (TX)
    zoning_code: Sourced[str]           # Addition


class Building(BaseModel):      # existing structure on a parcel
    id: str
    parcel_id: str
    footprint: dict             # GeoJSON
    property_type: Sourced[str]         # office, retail, hotel, industrial, parking_garage, ...
    building_class: Sourced[str]        # A, B, C
    year_built: Sourced[int]
    year_renovated: Sourced[int]
    stories: Sourced[int]
    rentable_area_sqft: Sourced[float]
    typical_floor_sqft: Sourced[float]
    vacancy_pct: Sourced[float]
    asking_rent_usd_sqft_yr: Sourced[float]
    parking_spaces: Sourced[int]
    floor_depth_ft: Sourced[float]       # core-to-window; Matterport or derived from footprint
    ceiling_height_ft: Sourced[float]    # Matterport
    window_wall_pct: Sourced[float]      # Matterport or imagery estimate
    roof_area_sqft: Sourced[float]       # Vexcel or footprints
    name: Sourced[str]                   # Addition
    osm_id: Optional[str] = None         # Addition


UseType = Literal["residential", "hotel", "mixed_use", "keep_current"]


class FitScores(BaseModel):     # each 0–1, computed in models/reuse.py
    physical: float
    legal: float
    market: float
    financial: float
    location: float


class ScoreInput(BaseModel):    # Addition: every component score's input and threshold
    use: UseType
    fit: Literal["physical", "legal", "market", "financial", "location"]
    name: str
    value: Optional[float | str]
    unit: str
    threshold: Optional[str]
    factor_key: Optional[str]
    score: float
    prov: Provenance


class ConversionCandidate(BaseModel):
    building_id: str
    best_use: UseType
    scores_by_use: dict[UseType, FitScores]
    overall: float
    est_units: Optional[int]
    blockers: list[str]          # e.g. "floor depth 95 ft exceeds residential threshold"
    legal_path: Optional["LegalPath"]
    embodied_co2_saved_tonnes: Optional[float]
    confidence: Confidence       # Addition
    screening_only: bool         # Addition
    details: list[ScoreInput]    # Addition (all uses)


class InfraFeature(BaseModel):
    kind: Literal["rail", "bus_route", "bus_stop", "sidewalk", "bike_lane", "water_main", "sewer_main",
                  "power_substation", "ev_charger", "broadband", "school", "clinic", "park", "grocery", "flood_zone"]
    geometry: dict
    attrs: dict
    prov: Provenance


class InfraReadiness(BaseModel):
    target_id: str              # parcel or building id
    score: float                # 0–1
    present: list[str]          # what's within reach
    gaps: list[str]             # e.g. "no sidewalk on 2 of 4 frontages", "sewer data not public here"


class Stop(BaseModel):
    id: str
    lonlat: tuple[float, float]
    route_ids: list[str]
    riders_per_day_low: float
    riders_per_day_high: float
    prov: Provenance
    name: Optional[str] = None  # Addition: GTFS stop name or "<feeder> stop N"


class Route(BaseModel):
    id: str
    kind: Literal["rail_existing", "bus_existing", "frequent_bus", "brt", "on_demand_zone"]
    geometry: dict
    headway_min: Optional[int]
    phase: int
    annual_operating_cost_usd: float


class MeasurementSuggestion(BaseModel):
    what: str                   # "manual weekday passenger count at stop S4, 7–9 am"
    target_id: str
    expected_range_narrowing_pct: float


class TransitPlan(BaseModel):
    routes: list[Route]
    stops: list[Stop]
    measurements: list[MeasurementSuggestion]
    budget_usd: float


class Citation(BaseModel):
    doc_id: str
    section: str
    quote: str                  # short verbatim excerpt from the corpus
    url: Optional[str]


class LegalPath(BaseModel):
    name: str                   # "SB 79 new construction", "LA Citywide Adaptive Reuse", "Houston development rules"
    eligible: Optional[bool]    # None = not covered by corpus
    allows: dict                # e.g. {"max_height_ft": ..., "max_units": ..., "parking_min_per_unit": ...}
    citations: list[Citation]
    homes: Optional[int] = None  # Addition: homes this path allows here (None: not eligible or unknown)


ConversionCandidate.model_rebuild()


class ZoningEnvelope(BaseModel):
    parcel_id: str
    paths: list[LegalPath]
    recommended_path: Optional[str]
    covered: bool


class Site(BaseModel):
    id: str
    kind: Literal["new_build", "conversion"]
    parcel_ids: list[str]
    building_id: Optional[str]  # set for conversions
    geometry: dict
    homes: int
    height_ft: float
    status: Literal["pursue", "pass", "watch"]


class DealStrategy(BaseModel):
    site_id: str
    strategy: Literal["buy", "ground_lease", "joint_development", "owner_partnership", "pass"]
    reasons: list[str]
    letter_draft: Optional[str]


class GapToPencil(BaseModel):  # Addition: what would close an open funding gap (models/finance.gap_to_pencil)
    gap_per_home_usd: Optional[float]                    # extra per-home incentive that closes it; None: no homes
    cost_per_home_usd: Optional[float]
    value_per_home_usd: Optional[float]                  # stabilized value (NOI / cap rate) per home
    rent_usd_per_unit_month: float                       # rent factor used
    break_even_rent_usd_per_unit_month: Optional[float]  # None: rent alone cannot close it, or no homes
    debt_limit: Literal["loan_to_value", "loan_to_cost"]  # which cap binds the debt today
    factor_keys: list[str]


class CapitalStack(BaseModel):
    site_id: str
    total_cost_usd: float
    debt_usd: float
    tax_credit_equity_usd: float
    incentive_usd: float        # e.g. local per-unit rebate, when a factor exists for it
    investor_equity_usd: float
    gap_usd: float
    pencils: bool
    assumptions: list[str]      # factors.yaml keys used
    gap_to_pencil: Optional[GapToPencil] = None  # Addition: None when it pencils


class TargetScore(BaseModel):
    key: Literal["transport_co2", "embodied_co2_saved", "rooftop_solar", "walk_access", "flood_exposure"]
    value: float
    unit: str
    target: Optional[float]
    factor_keys: list[str]


class Precomputed(BaseModel):   # Addition: everything rescore needs, built with the plan
    walk_m: dict[str, dict[str, Optional[float]]]   # target id -> {park, clinic, grocery, school, frequent_stop}
    in_flood: dict[str, bool]
    centroid: dict[str, tuple[float, float]]
    homes_by_parcel: dict[str, Optional[int]]
    demand_cells: list[dict]                         # {h3, lonlat, demand, homes}
    solar_kwh_per_kw_year: Optional[float]


AgentName = Literal["infrastructure", "transit_network", "zoning_legislation", "site", "building_reuse",
                    "land_deal", "funding", "sustainability_health", "coordinator"]


class PlanOptions(BaseModel):   # Addition: steering options, parsed from the prompt or set with the UI sliders
    focus: Literal["all", "conversions", "new_build"] = "all"
    transit_budget_multiplier: float = Field(1.0, gt=0, le=10)    # × the locale's transit_budget_usd
    affordable_share: Optional[float] = Field(None, ge=0, le=1)   # None: factors.yaml affordable_share


class StockPrompt(BaseModel):   # Addition
    id: str
    locale_id: Optional[str]
    title: str
    prompt: str
    options: PlanOptions


class LlmRun(BaseModel):        # Addition: how the LLM coordinator run went
    model: str
    seconds: float
    agents_completed: list[AgentName]      # agents whose last tool ran via the LLM
    notes_from_llm: list[AgentName]        # agents whose note text came from the LLM
    fallback_reason: Optional[str]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    tool_outputs: dict[str, list[str]]     # agent -> tool result strings, for grounding checks


class Plan(BaseModel):
    id: str
    locale: Locale
    infrastructure: list[InfraFeature]
    readiness: list[InfraReadiness]
    transit: TransitPlan
    parcels: list[Parcel]
    buildings: list[Building]
    envelopes: list[ZoningEnvelope]
    conversions: list[ConversionCandidate]
    sites: list[Site]
    deals: list[DealStrategy]
    stacks: list[CapitalStack]
    targets: list[TargetScore]
    created_at: datetime
    prompt: str                       # Addition
    notes: dict[str, str]             # Addition: agent -> short explanation
    agent_errors: dict[str, str]      # Addition
    precomputed: Precomputed          # Addition
    options: PlanOptions = PlanOptions()   # Addition
    llm_run: Optional[LlmRun] = None       # Addition


class Edit(BaseModel):          # from meeting mode or the slider
    kind: Literal["place_tile", "remove_tile", "slider"]
    tile: Optional[Literal["homes", "park", "stop", "convert_residential", "convert_hotel"]] = None
    target_id: Optional[str] = None   # parcel or building id
    value: Optional[float] = None


# ---- Additions: API, events, rescore -------------------------------------------------------

# AgentName is defined above Plan.


class AgentEvent(BaseModel):
    agent: AgentName
    status: Literal["running", "done", "error"]
    step: str
    payload: dict = {}


class Scoreboard(BaseModel):
    homes: int
    walk_access_pct: float
    transport_co2_tonnes_per_year: float
    embodied_co2_saved_tonnes: float
    pencils_yes: int
    pencils_total: int
    walk_by_amenity_pct: dict[str, float] = {}  # Addition: % of new homes within the walk of a park / clinic / grocery


class Rejection(BaseModel):
    edit_index: int
    reason: str
    citation: Optional[Citation]
    factor_key: Optional[str]


class RescoreResponse(BaseModel):
    # Keys sites, stacks, deals, conversions, targets, transit, infrastructure_added replace those Plan
    # fields; returning a patch instead of the full Plan keeps the round trip under 1 s.
    plan_patch: dict
    scoreboard: Scoreboard
    deltas: dict[str, float]          # vs the base plan
    rejected: Optional[Rejection]


class SimulatedCount(BaseModel):
    stop_id: str
    simulated: Literal[True]
    count_per_day: float
    before: tuple[float, float]
    after: tuple[float, float]
    label: str = "Simulated count (demo)"


class Factor(BaseModel):
    key: str
    value: Any
    unit: str
    source_url: str
    verified: bool
    note: Optional[str] = None
    label: Optional[str] = None  # Addition: human name shown in the UI; the key stays in the tooltip
