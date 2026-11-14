"""Shared Pydantic models: the single source of truth (docs/02-architecture.md).

Mirrored in frontend/src/types.ts. The block up to `Edit` is copied from docs/02; additions the
docs' own requirements need are marked "Addition".
"""
from datetime import datetime
from typing import Any, Generic, Literal, Optional, TypeVar

from pydantic import BaseModel, Field, model_validator

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
                  "power_substation", "ev_charger", "broadband", "school", "clinic", "park", "grocery", "flood_zone",
                  "affordable_housing"]
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
    coverage_goal_pct: float            # % of transit demand the plan aims to put within a frequent stop
    coverage_baseline_pct: float        # % covered by rail + existing frequent buses before any new service
    coverage_pct: float                 # % covered with the selected network
    annual_operating_cost_usd: float    # operating funding the new network needs per year


class Citation(BaseModel):
    doc_id: str
    section: str
    quote: str                  # short verbatim excerpt from the corpus
    url: Optional[str]
    status: Literal["reviewed", "agent_verified"] = "reviewed"   # agent_verified: code-checked, not reviewed


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
    status: Literal["pursue", "pass", "watch", "reserve"]   # reserve: priced but not needed for the goals


class DealStrategy(BaseModel):
    site_id: str
    strategy: Literal["buy", "ground_lease", "joint_development", "owner_partnership", "pass"]
    reasons: list[str]
    letter_draft: Optional[str]


class GapToPencil(BaseModel):  # Addition: what would cover the funding a site still requires (models/finance)
    funding_required_per_home_usd: Optional[float]       # extra per-home incentive that covers it; None: no homes
    cost_per_home_usd: Optional[float]
    value_per_home_usd: Optional[float]                  # stabilized value (NOI / cap rate) per home
    rent_usd_per_unit_month: float                       # rent factor used
    break_even_rent_usd_per_unit_month: Optional[float]  # None: rent alone cannot close it, or no homes
    debt_limit: Literal["loan_to_value", "loan_to_cost"]  # which cap binds the debt today
    factor_keys: list[str]


class CapitalStack(BaseModel):
    site_id: str
    units: int
    affordable_units: int
    total_cost_usd: float
    debt_usd: float
    tax_credit_equity_usd: float
    incentive_usd: float        # e.g. local per-unit rebate, when a factor exists for it
    investor_equity_usd: float
    funding_required_usd: float  # outside funding still needed after the stack; <= 0: it pencils
    pencils: bool
    assumptions: list[str]      # factors.yaml keys used
    gap_to_pencil: Optional[GapToPencil] = None  # Addition: None when it pencils


class TargetScore(BaseModel):
    key: Literal["transport_co2", "embodied_co2_saved", "rooftop_solar", "walk_access", "flood_exposure"]
    value: float
    unit: str
    target: Optional[float]
    factor_keys: list[str]


GoalKey = Literal["affordable_homes", "total_homes", "conversions", "transit_coverage"]


class GoalProgress(BaseModel):
    key: GoalKey
    goal: Optional[float]      # None: no goal set
    achieved: float
    unit: str                  # "homes" | "buildings" | "% of demand"
    met: Optional[bool]        # None when no goal


class ExistingAffordable(BaseModel):   # HUD LIHTC properties in the area
    properties: int
    affordable_homes: int      # sum of LI_UNITS
    total_homes: int           # sum of N_UNITS
    prov: Provenance


class GoalReport(BaseModel):
    goals: list[GoalProgress]
    sites_funded: int
    total_cost_usd: float
    housing_funding_required_usd: float  # one-time: sum of positive per-site funding required (no cross-subsidy)
    tax_credit_equity_usd: float
    incentive_usd: float
    transit_operating_usd_per_year: float
    existing_affordable: Optional[ExistingAffordable]   # None: no HUD LIHTC data for this area
    notes: list[str]


class Precomputed(BaseModel):   # Addition: everything rescore needs, built with the plan
    walk_m: dict[str, dict[str, Optional[float]]]   # target id -> {park, clinic, grocery, school, frequent_stop}
    in_flood: dict[str, bool]
    centroid: dict[str, tuple[float, float]]
    homes_by_parcel: dict[str, Optional[int]]
    demand_cells: list[dict]                         # {h3, lonlat, demand, homes}
    solar_kwh_per_kw_year: Optional[float]


AgentName = Literal["infrastructure", "transit_network", "zoning_legislation", "site", "building_reuse",
                    "land_deal", "funding", "sustainability_health", "coordinator"]


class PlanGoals(BaseModel):   # Addition: numeric goals the user sets; None = no goal
    affordable_homes: Optional[int] = Field(None, ge=0)        # new affordable homes
    total_homes: Optional[int] = Field(None, ge=0)             # new homes
    conversions: Optional[int] = Field(None, ge=0)             # buildings converted
    transit_coverage_pct: Optional[float] = Field(None, ge=0, le=100)  # None: factor transit_coverage_goal_pct

    def housing(self) -> bool:
        return any(v is not None for v in (self.affordable_homes, self.total_homes, self.conversions))


class PlanOptions(BaseModel):   # Addition: fixed steering options from the prompt
    focus: Literal["all", "conversions", "new_build"] = "all"
    goals: PlanGoals = PlanGoals()


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
    goals_report: Optional[GoalReport] = None   # Addition: None only when the funding agent failed


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
    affordable_homes: int
    funding_required_usd: float
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


# ---- Additions: agent research (docs/12-agent-research.md) -------------------------------------

class ResearchedFact(BaseModel):
    field: str                      # a key in backend/research/fields.yaml, e.g. "vacancy_pct"
    value: float | int | str        # what the LLM read; the verifier re-derives it and the two must match
    source_url: str
    quote: str                      # verbatim span from the page, 20-400 chars, containing the value
    source_type: Optional[str] = None   # Addition: a sources.yaml source type; picks the confidence (docs/12 §7)
    as_of: Optional[str] = None     # date or quarter the source says the value applies to ("Q3 2026")
    page: Optional[int] = None      # PDF page (1-based), when the source is a PDF


class ResearchedBuilding(BaseModel):
    job_id: str
    building_id: str                # from the queue; the agent never makes one up
    name: Optional[ResearchedFact] = None
    address: Optional[ResearchedFact] = None
    facts: list[ResearchedFact]     # empty is a valid answer
    not_found: list[str]            # fields searched for and not found, with no guesses


class ResearchedFactor(BaseModel):
    factor_key: str                 # a market factor key in backend/research/fields.yaml (`market_factors`)
    scope: str                      # locale id or submarket name the value applies to
    fact: ResearchedFact


class ResearchedMarket(BaseModel):  # Addition: the market researcher's structured answer
    factors: list[ResearchedFactor]
    not_found: list[str]


class ResearchJob(BaseModel):
    job_id: str
    building_id: str
    parcel_id: Optional[str]
    label: str                      # common.building_label(); what the agent searches for
    address: Optional[str]
    lonlat: tuple[float, float]
    fields: list[str]               # missing fields worth researching, best first
    swing: float                    # max change in ConversionCandidate.overall if those fields were known


# ---- Additions: US-wide onboarding agents (docs/12 §14) ----------------------------------------------------
# Structured answers of the onboarding agents in backend/onboard/. Code verifies each against the live source before
# anything is written to backend/registry/.

LandUse = Literal["office", "retail", "hotel", "industrial", "parking_garage", "surface_parking", "residential",
                  "public", "vacant", "other"]
FIELD_OPERATORS = ("field", "number", "sum", "join", "epoch_ms_year", "year", "first")


class FieldExpr(BaseModel):
    """One parcel property from the raw layer's fields (backend/onboard/parcels.py): exactly one operator."""
    field: Optional[str] = None            # the raw value
    number: Optional[str] = None           # a finite number
    sum: Optional[list[str]] = None        # sum of numbers; None when all are missing
    join: Optional[list[str]] = None       # space-joined non-empty values (an address)
    epoch_ms_year: Optional[str] = None    # year of an epoch-milliseconds date
    year: Optional[str] = None             # a 4-digit year field
    first: Optional[list[str]] = None      # first non-empty field
    strip: Optional[bool] = None
    zero_is_null: Optional[bool] = None
    null_values: Optional[list[str]] = None
    append: Optional[str] = None
    append_separator: Optional[str] = None
    min_exclusive: Optional[int] = None
    require: Optional[str] = None

    @model_validator(mode="after")
    def _one_operator(self):
        n = sum(getattr(self, k) is not None for k in FIELD_OPERATORS)
        if n != 1:
            raise ValueError(f"exactly one of {FIELD_OPERATORS} is required, got {n}")
        return self


class ParcelSourceProposal(BaseModel):
    status: Literal["found", "not_found"]
    layer_url: Optional[str] = None        # ArcGIS MapServer/FeatureServer layer URL (ends in /<layer id>)
    where: str = "1=1"
    fields: dict[str, FieldExpr] = {}      # parcel prop -> expression (backend/onboard/parcels.PARCEL_PROPS)
    notes: dict[str, str] = {}             # e.g. assessed_value_usd: "Assessor total market value"
    evidence_url: Optional[str] = None
    reason: Optional[str] = None           # why not found


class LandUseProposal(BaseModel):
    field: Literal["raw_use", "raw_use_desc"]
    map: dict[str, LandUse]
    default: LandUse
    vacant_code_suffix: Optional[str] = None
    building_type_reliable: bool
    code_list_url: str                     # the fetched page listing the county's use codes


class LayerRef(BaseModel):
    url: str
    field: str
    label: str
    prefix: str = ""


class ZoningProposal(BaseModel):
    status: Literal["found", "no_zoning", "not_found"]
    layers: list[LayerRef] = []
    evidence_url: Optional[str] = None     # no_zoning: the official page saying so
    quote: Optional[str] = None


class UtilityLayerRef(BaseModel):
    kind: Literal["water_main", "sewer_main"]
    url: str
    where: str = "1=1"
    label: str


class UtilitiesProposal(BaseModel):
    layers: list[UtilityLayerRef]
    not_found: list[str]


class AssessorProposal(BaseModel):
    card_url: Optional[str]
    parcel_id: Optional[str]
    url_pattern: Optional[str]             # card URL with {parcel_id}
    non_disclosure: Optional[bool] = None
    non_disclosure_url: Optional[str] = None
    non_disclosure_quote: Optional[str] = None


class ProposedSection(BaseModel):
    heading: str
    text: str                              # verbatim from the page
    page: Optional[int] = None


class ProposedDoc(BaseModel):
    doc_id: str
    title: str
    url: str
    path_name: Optional[str]
    sections: list[ProposedSection]


class ProposedCite(BaseModel):
    doc_id: str
    section: str
    quote: str


class ProposedRule(BaseModel):
    path: str
    rule: str
    applies_if: dict = {}
    value: Any
    cite: ProposedCite


class ProposedPath(BaseModel):
    name: str
    kind: Literal["new_construction", "conversion", "both"]


class CorpusProposal(BaseModel):
    documents: list[ProposedDoc]
    rules: list[ProposedRule]
    paths: list[ProposedPath]
    not_covered: list[str]
