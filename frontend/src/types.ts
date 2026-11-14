// Mirror of backend/schemas.py (the single source of truth). Keep in sync when schemas change.
// datetime fields arrive as ISO strings; tuples arrive as JSON arrays.

export type Confidence = 'high' | 'medium' | 'low' | 'missing'

export interface Provenance {
  source: string
  confidence: Confidence
  retrieved_at: string
  url?: string | null
  note?: string | null
}

export interface Sourced<T> {
  value: T | null
  prov: Provenance
}

/** GeoJSON geometry (WGS84). */
export interface Geometry {
  type: string
  coordinates?: unknown
  geometries?: Geometry[]
}

export type LonLat = [number, number]

export interface Station {
  name: string
  lonlat: LonLat
  mode: 'light_rail' | 'heavy_rail' | 'intercity_rail_planned' | 'frequent_bus'
  source_url: string
  note?: string | null
}

export type LocaleId = string

/** The three recorded, committed locales. Other ids are sub-plans or custom areas (`area-xxxxxxxx`). */
export const RECORDED_LOCALE_IDS = ['houston_downtown', 'la_wilshire_koreatown', 'brevard_cocoa'] as const

export interface Locale {
  id: LocaleId
  name: string
  purpose: string
  data_tier: 'costar_full' | 'public_only'
  jurisdiction: string
  bbox: [number, number, number, number]
  stations: Station[]
  utm_epsg: number
  county_fips: string
  transit_agency: string
  /** GeoJSON Polygon/MultiPolygon (WGS84) for drawn areas. */
  boundary?: Geometry | null
  aliases?: string[]
  /** Recorded locale id whose sources a drawn metro area reuses. */
  sources_from: string | null
}

export interface Parcel {
  id: string
  geometry: Geometry
  area_acres: Sourced<number>
  land_use: Sourced<string>
  owner: Sourced<string>
  last_sale_usd: Sourced<number>
  last_sale_year: Sourced<number>
  lease_expiry_year: Sourced<number>
  address: Sourced<string>
  assessed_value_usd: Sourced<number>
  zoning_code: Sourced<string>
}

export interface Building {
  id: string
  parcel_id: string
  footprint: Geometry
  property_type: Sourced<string>
  building_class: Sourced<string>
  year_built: Sourced<number>
  year_renovated: Sourced<number>
  stories: Sourced<number>
  rentable_area_sqft: Sourced<number>
  typical_floor_sqft: Sourced<number>
  vacancy_pct: Sourced<number>
  asking_rent_usd_sqft_yr: Sourced<number>
  parking_spaces: Sourced<number>
  floor_depth_ft: Sourced<number>
  ceiling_height_ft: Sourced<number>
  window_wall_pct: Sourced<number>
  roof_area_sqft: Sourced<number>
  name: Sourced<string>
  osm_id?: string | null
}

export type UseType = 'residential' | 'hotel' | 'mixed_use' | 'keep_current'
export type FitName = 'physical' | 'legal' | 'market' | 'financial' | 'location'

export interface FitScores {
  physical: number
  legal: number
  market: number
  financial: number
  location: number
}

export interface ScoreInput {
  use: UseType
  fit: FitName
  name: string
  value: number | string | null
  unit: string
  threshold: string | null
  factor_key: string | null
  score: number
  prov: Provenance
}

export interface ConversionCandidate {
  building_id: string
  best_use: UseType
  scores_by_use: Partial<Record<UseType, FitScores>>
  overall: number
  est_units: number | null
  blockers: string[]
  legal_path: LegalPath | null
  embodied_co2_saved_tonnes: number | null
  confidence: Confidence
  screening_only: boolean
  details: ScoreInput[]
}

export type InfraKind =
  | 'rail'
  | 'bus_route'
  | 'bus_stop'
  | 'sidewalk'
  | 'bike_lane'
  | 'water_main'
  | 'sewer_main'
  | 'power_substation'
  | 'ev_charger'
  | 'broadband'
  | 'school'
  | 'clinic'
  | 'park'
  | 'grocery'
  | 'flood_zone'
  | 'affordable_housing'

export interface InfraFeature {
  kind: InfraKind
  geometry: Geometry
  attrs: Record<string, unknown>
  prov: Provenance
}

export interface InfraReadiness {
  target_id: string
  score: number
  present: string[]
  gaps: string[]
}

export interface Stop {
  id: string
  lonlat: LonLat
  route_ids: string[]
  riders_per_day_low: number
  riders_per_day_high: number
  prov: Provenance
  name?: string | null
}

export type RouteKind = 'rail_existing' | 'bus_existing' | 'frequent_bus' | 'brt' | 'on_demand_zone'

export interface Route {
  id: string
  kind: RouteKind
  geometry: Geometry
  headway_min: number | null
  phase: number
  annual_operating_cost_usd: number
}

export interface MeasurementSuggestion {
  what: string
  target_id: string
  expected_range_narrowing_pct: number
}

export interface TransitPlan {
  routes: Route[]
  stops: Stop[]
  measurements: MeasurementSuggestion[]
  coverage_goal_pct: number
  coverage_baseline_pct: number
  coverage_pct: number
  annual_operating_cost_usd: number
}

export interface Citation {
  doc_id: string
  section: string
  quote: string
  url: string | null
  /** UI only: every quote when chips for the same (doc_id, section) are merged */
  quotes?: string[]
}

export interface LegalPath {
  name: string
  eligible: boolean | null
  allows: Record<string, unknown>
  citations: Citation[]
  homes?: number | null
}

export interface ZoningEnvelope {
  parcel_id: string
  paths: LegalPath[]
  recommended_path: string | null
  covered: boolean
}

export interface Site {
  id: string
  kind: 'new_build' | 'conversion'
  parcel_ids: string[]
  building_id: string | null
  geometry: Geometry
  homes: number
  height_ft: number
  status: 'pursue' | 'pass' | 'watch' | 'reserve'
}

export type DealKind = 'buy' | 'ground_lease' | 'joint_development' | 'owner_partnership' | 'pass'

export interface DealStrategy {
  site_id: string
  strategy: DealKind
  reasons: string[]
  letter_draft: string | null
}

export interface GapToPencil {
  gap_per_home_usd: number | null
  cost_per_home_usd: number | null
  value_per_home_usd: number | null
  rent_usd_per_unit_month: number
  break_even_rent_usd_per_unit_month: number | null
  debt_limit: 'loan_to_value' | 'loan_to_cost'
  factor_keys: string[]
}

export interface CapitalStack {
  site_id: string
  units: number
  affordable_units: number
  total_cost_usd: number
  debt_usd: number
  tax_credit_equity_usd: number
  incentive_usd: number
  investor_equity_usd: number
  gap_usd: number
  pencils: boolean
  assumptions: string[]
  gap_to_pencil?: GapToPencil | null
}

export type TargetKey = 'transport_co2' | 'embodied_co2_saved' | 'rooftop_solar' | 'walk_access' | 'flood_exposure'

export interface TargetScore {
  key: TargetKey
  value: number
  unit: string
  target: number | null
  factor_keys: string[]
}

export type GoalKey = 'affordable_homes' | 'total_homes' | 'conversions' | 'transit_coverage'

export interface GoalProgress {
  key: GoalKey
  goal: number | null
  achieved: number
  unit: string
  met: boolean | null
}

export interface ExistingAffordable {
  properties: number
  affordable_homes: number
  total_homes: number
  prov: Provenance
}

export interface GoalReport {
  goals: GoalProgress[]
  sites_funded: number
  total_cost_usd: number
  housing_gap_usd: number
  tax_credit_equity_usd: number
  incentive_usd: number
  transit_operating_usd_per_year: number
  existing_affordable: ExistingAffordable | null
  notes: string[]
}

export interface DemandCell {
  h3: string
  lonlat: LonLat
  demand: number
  homes: number
}

export interface Precomputed {
  walk_m: Record<string, Record<string, number | null>>
  in_flood: Record<string, boolean>
  centroid: Record<string, LonLat>
  homes_by_parcel: Record<string, number | null>
  demand_cells: DemandCell[]
  solar_kwh_per_kw_year: number | null
}

export interface Plan {
  id: string
  locale: Locale
  infrastructure: InfraFeature[]
  readiness: InfraReadiness[]
  transit: TransitPlan
  parcels: Parcel[]
  buildings: Building[]
  envelopes: ZoningEnvelope[]
  conversions: ConversionCandidate[]
  sites: Site[]
  deals: DealStrategy[]
  stacks: CapitalStack[]
  targets: TargetScore[]
  created_at: string
  prompt: string
  notes: Record<string, string>
  agent_errors: Record<string, string>
  precomputed: Precomputed
  options?: PlanOptions
  llm_run?: LlmRun | null
  goals_report?: GoalReport | null
}

export interface PlanGoals {
  affordable_homes: number | null
  total_homes: number | null
  conversions: number | null
  transit_coverage_pct: number | null
}

export interface PlanOptions {
  focus: 'all' | 'conversions' | 'new_build'
  goals: PlanGoals
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  focus: 'all',
  goals: { affordable_homes: null, total_homes: null, conversions: null, transit_coverage_pct: null },
}

export interface LlmRun {
  model: string
  seconds: number
  agents_completed: AgentName[]
  notes_from_llm: AgentName[]
  fallback_reason: string | null
  input_tokens: number | null
  output_tokens: number | null
  tool_outputs: Record<string, string[]>
}

export interface StockPrompt {
  id: string
  locale_id: string | null
  title: string
  prompt: string
  options: PlanOptions
}

export interface GeocodeResult {
  label: string
  lonlat: LonLat
  bbox: [number, number, number, number]
  recorded_locale_id: string | null
  /** County the result lies in, e.g. "Harris County". */
  metro: string | null
}

export interface AreaCheck {
  kind: 'subarea' | 'metro' | null
  locale_id: string | null
  label: string | null
  jurisdiction: string | null
  area_km2: number | null
  /** Recorded locale whose county sources and stock prompts a drawn area reuses; null outside those counties. */
  sources_from: string | null
  error: string | null
}

export interface MetroProperties {
  kind: 'county' | 'place'
  geoid: string
  name: string
  sources_from: string | null
  jurisdiction: string | null
}

export interface MetroOutlines {
  type: 'FeatureCollection'
  features: { type: 'Feature'; properties: MetroProperties; geometry: Geometry }[]
}

export type TileKind = 'homes' | 'park' | 'stop' | 'convert_residential' | 'convert_hotel'

export interface Edit {
  kind: 'place_tile' | 'remove_tile' | 'slider'
  tile?: TileKind | null
  target_id?: string | null
  value?: number | null
}

// ---- Additions: API, events, rescore ----

export type AgentName =
  | 'infrastructure'
  | 'transit_network'
  | 'zoning_legislation'
  | 'site'
  | 'building_reuse'
  | 'land_deal'
  | 'funding'
  | 'sustainability_health'
  | 'coordinator'

export interface AgentEvent {
  agent: AgentName
  status: 'running' | 'done' | 'error'
  step: string
  payload: Record<string, unknown>
}

export interface Scoreboard {
  homes: number
  walk_access_pct: number
  transport_co2_tonnes_per_year: number
  embodied_co2_saved_tonnes: number
  affordable_homes: number
  funding_gap_usd: number
  walk_by_amenity_pct?: Record<string, number>
}

export interface Rejection {
  edit_index: number
  reason: string
  citation: Citation | null
  factor_key: string | null
}

/** Keys present replace those Plan fields; `infrastructure_added` holds proposed park features. */
export interface PlanPatch {
  sites?: Site[]
  stacks?: CapitalStack[]
  deals?: DealStrategy[]
  conversions?: ConversionCandidate[]
  targets?: TargetScore[]
  transit?: TransitPlan
  infrastructure_added?: InfraFeature[]
  goals_report?: GoalReport | null
}

export interface RescoreResponse {
  plan_patch: PlanPatch
  scoreboard: Scoreboard
  deltas: Record<string, number>
  rejected: Rejection | null
}

export interface SimulatedCount {
  stop_id: string
  simulated: true
  count_per_day: number
  before: [number, number]
  after: [number, number]
  label: string
}

export interface Factor {
  key: string
  value: unknown
  unit: string
  source_url: string
  verified: boolean
  note?: string | null
  label?: string | null
}

// ---- API response shapes (Phase 7) ----

export interface BuildingDetail {
  building: Building
  conversion: ConversionCandidate | null
  readiness: InfraReadiness | null
  envelope: ZoningEnvelope | null
}

export interface CorpusDoc {
  doc_id: string
  title: string
  url: string
  sections: { section: string; text: string }[]
}

export const AGENTS: Exclude<AgentName, 'coordinator'>[] = [
  'infrastructure',
  'transit_network',
  'zoning_legislation',
  'site',
  'building_reuse',
  'land_deal',
  'funding',
  'sustainability_health',
]

export const AGENT_LABELS: Record<AgentName, string> = {
  infrastructure: 'Infrastructure',
  transit_network: 'Transit network',
  zoning_legislation: 'Zoning & legislation',
  site: 'Site',
  building_reuse: 'Building reuse',
  land_deal: 'Land deal',
  funding: 'Funding',
  sustainability_health: 'Sustainability & health',
  coordinator: 'Coordinator',
}
