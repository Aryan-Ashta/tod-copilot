// deck.gl layer builders, in docs/06 order (bottom → top). Each builder is pure; MapView memoizes
// each one on the identity of its data so thousands of extrusions are not rebuilt on every render.
import { GeoJsonLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { DataFilterExtension, PathStyleExtension, type DataFilterExtensionProps } from '@deck.gl/extensions'
import type { Color, Layer, PickingInfo } from '@deck.gl/core'
import type { Feature, Geometry as GJGeometry } from 'geojson'
import type {
  Building,
  ConversionCandidate,
  DealKind,
  Geometry,
  InfraFeature,
  InfraKind,
  LonLat,
  Parcel,
  Route,
  Site,
  Station,
  Stop,
  TileKind,
  UseType,
} from './types'
import { geometryCentroid } from './format'
import { cornerIndices, separateFootprints, simplifyRing } from './footprints'
import { REDUCED_MOTION, standingShare, type Build } from './construction'

export type LayerKey =
  | 'base_dark'
  | 'aerial'
  | 'transit_existing'
  | 'walk_bike'
  | 'utilities'
  | 'amenities'
  | 'flood'
  | 'proposed_transit'
  | 'parcels'
  | 'buildings'
  | 'sites'
  | 'new_buildings'

export const LAYER_DEFS: { key: LayerKey; label: string; group: 'Base' | 'Infrastructure' | 'Plan'; on: boolean }[] = [
  { key: 'base_dark', label: 'Base map (light grey)', group: 'Base', on: true },
  { key: 'aerial', label: 'Aerial imagery', group: 'Base', on: false },
  { key: 'transit_existing', label: 'Rail and bus routes (existing)', group: 'Infrastructure', on: true },
  { key: 'walk_bike', label: 'Sidewalks / bike lanes', group: 'Infrastructure', on: false },
  { key: 'utilities', label: 'Utilities (where public)', group: 'Infrastructure', on: false },
  { key: 'amenities', label: 'EV chargers, schools, clinics, parks, grocery', group: 'Infrastructure', on: true },
  { key: 'flood', label: 'FEMA flood zones', group: 'Infrastructure', on: true },
  { key: 'proposed_transit', label: 'Proposed routes and stops', group: 'Plan', on: true },
  { key: 'parcels', label: 'Underused parcels', group: 'Plan', on: true },
  { key: 'buildings', label: 'Conversion candidates', group: 'Plan', on: true },
  { key: 'sites', label: 'Pursued sites', group: 'Plan', on: true },
  { key: 'new_buildings', label: 'New buildings', group: 'Plan', on: true },
]

/** Legend swatch per layer (CSS background), kept next to the colours the layers use. */
export const LAYER_SWATCH: Partial<Record<LayerKey, string>> = {
  transit_existing: 'linear-gradient(90deg,#1C2230 50%,#13808A 50%)',
  walk_bike: 'linear-gradient(90deg,#9AA09A 50%,#2E7D5B 50%)',
  utilities: 'repeating-linear-gradient(90deg,#2F5BD3 0 3px,transparent 3px 5px)',
  amenities: 'linear-gradient(90deg,#13808A,#E3B448,#B93A2E,#2E7D5B,#C0703A)',
  flood: 'rgba(47,91,211,0.25)',
  proposed_transit: 'linear-gradient(90deg,#2E7D5B 50%,#13808A 50%)',
  parcels: '#E3B448',
  buildings: 'linear-gradient(90deg,#2F5BD3,#E3B448,#2E7D5B,#C4C9C1)',
  sites: '#1C2230',
  new_buildings: '#A9BFE7',
}

export const UNDERUSED_LAND_USES: Record<string, true> = { surface_parking: true, vacant: true, retail_1story: true }

// Accents shared with the iso figures (src/iso): residential blue, hotel mustard, mixed use green, keep grey.
export const USE_COLORS: Record<UseType, Color> = {
  residential: [47, 91, 211],
  hotel: [227, 180, 72],
  mixed_use: [46, 125, 91],
  keep_current: [196, 201, 193],
}

export const STRATEGY_COLORS: Record<DealKind, Color> = {
  buy: [46, 125, 91],
  ground_lease: [227, 180, 72],
  joint_development: [47, 91, 211],
  owner_partnership: [19, 128, 138],
  pass: [154, 160, 154],
}

export const INK: Color = [28, 34, 48]
export const TEAL: Color = [19, 128, 138]
export const INFRA_COLORS: Partial<Record<InfraKind, Color>> = {
  sidewalk: [154, 160, 154],
  bike_lane: [46, 125, 91],
  water_main: [47, 91, 211],
  sewer_main: [138, 101, 18],
  power_substation: [227, 180, 72],
  ev_charger: TEAL,
  school: [227, 180, 72],
  clinic: [185, 58, 46],
  park: [46, 125, 91],
  grocery: [192, 112, 58],
  affordable_housing: [123, 63, 160],
}
const AMBER: Color = [227, 180, 72]
const NO_SIDEWALK_COLOR: Color = [185, 58, 46]
export const FT_TO_M = 0.3048 // unit conversion, not a planning factor
// Ground-plane layers draw in layer order without depth testing or writing: the iso camera's narrow field of view
// puts the eye far away, and coplanar polygons (flood zones, parcels) z-fight at that depth precision. Extruded
// buildings still depth-test, and draw after these, so they correctly hide what is behind them.
export const FLAT = { depthWriteEnabled: false, depthCompare: 'always' } as const

export type Feat<P> = Feature<GJGeometry, P>
export const feature = <P>(geometry: Geometry, properties: P) =>
  ({ type: 'Feature', geometry, properties }) as unknown as Feat<P>

export const withAlpha = (c: Color, a: number): Color => [c[0], c[1], c[2], a]

/** OSM sidewalk tag values that mean "no sidewalk on this frontage". */
const NO_SIDEWALK: Record<string, true> = { no: true, none: true }

// ---------------------------------------------------------------- transit
// Lines draw as on a transit map: each route in its feed colour over a white casing, so routes sharing a street read as
// one corridor and stay legible over parcels and sidewalks. Hovering or selecting a route (on the map, or a row in the
// transit card) or a stop focuses it: its lines and stops come forward and widen, the rest of the network fades.

/** Route keys in focus (hovered or selected), or null when nothing is. */
export type TransitFocus = ReadonlySet<string> | null

const ROUTE_ID_PREFIXES = ['rail-', 'bus-', 'upg-']

/**
 * The key tying a plan route to its feed line and its stops: the GTFS route id behind an existing, upgraded or BRT
 * route ('rail-700', 'bus-003', 'upg-003', 'brt-upg-003' → '700', '003'). New services (feeders 'fdr-…', on-demand
 * zones 'odz-…') keep their own id, which is what their stops list (backend/models/transit.py).
 */
export function routeKey(routeId: string): string {
  const id = routeId.startsWith('brt-') ? routeId.slice('brt-'.length) : routeId
  const p = ROUTE_ID_PREFIXES.find((x) => id.startsWith(x))
  return p ? id.slice(p.length) : id
}

/** One existing line from the feed: an infrastructure rail or bus_route feature. */
export interface TransitLine {
  key: string
  name: string
  mode: 'rail' | 'bus'
  color: Color
  headwayMin: number | null
  geometry: Geometry
}

const WHITE: Color = [255, 255, 255]
type RGB = [number, number, number]
const BUS_FALLBACK: RGB = [74, 128, 214]
const PROPOSED_COLORS: Record<'frequent_bus' | 'brt' | 'on_demand_zone', Color> = {
  frequent_bus: TEAL,
  brt: [46, 125, 91],
  on_demand_zone: [47, 91, 211],
}

/**
 * A feed colour ('#EF0000') as RGB; null when missing, malformed, so pale it would vanish on the paper base, or a
 * neutral grey/black (agencies paint whole bus networks #8A8A8A or #000000, which reads as base-map streets).
 */
function feedColor(v: unknown): RGB | null {
  const m = typeof v === 'string' ? /^#?([0-9a-f]{6})$/i.exec(v.trim()) : null
  if (!m) return null
  const n = parseInt(m[1], 16)
  const c: RGB = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const pale = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] > 200
  const neutral = Math.max(...c) - Math.min(...c) < 40
  return pale || neutral ? null : c
}

/**
 * A bus colour lifted to mid lightness and some saturation: agencies' navy and indigo at bus width read as the ink
 * outlines of parcels and buildings. Rail keeps its true colour; it is bold enough to read either way.
 */
function vivid([r, g, b]: RGB): Color {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const d = max - min
  const h = d === 0 ? 0 : max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  const l = Math.min(Math.max((max + min) / 2, 0.48), 0.6)
  const s = Math.max(d === 0 ? 0 : d / (1 - Math.abs(max + min - 1)), 0.55)
  // HSL → RGB
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r1, g1, b1] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)]
}

export function transitLines(infra: InfraFeature[]): TransitLine[] {
  const out: TransitLine[] = []
  infra.forEach((f, i) => {
    if (f.kind !== 'rail' && f.kind !== 'bus_route') return
    const mode = f.kind === 'rail' ? 'rail' : 'bus'
    const { route_id: id, short_name: short, peak_headway_min: hw, color } = f.attrs
    const key = typeof id === 'string' || typeof id === 'number' ? String(id) : `line-${i}`
    out.push({
      key,
      name: typeof short === 'string' && short ? short : key,
      mode,
      color: mode === 'rail' ? (feedColor(color) ?? INK) : vivid(feedColor(color) ?? BUS_FALLBACK),
      headwayMin: typeof hw === 'number' ? Math.round(hw) : null,
      geometry: f.geometry,
    })
  })
  return out
}

/** Feed names that are already words ("Metro B Line") as they are; bare route numbers with their mode. */
export const lineLabel = (l: TransitLine) => (/\s/.test(l.name) ? l.name : `${l.mode === 'rail' ? 'Rail' : 'Bus'} ${l.name}`)

const PROPOSED_KINDS: Partial<Record<Route['kind'], true>> = { frequent_bus: true, brt: true, on_demand_zone: true }
export const isProposedRoute = (r: Route) => PROPOSED_KINDS[r.kind] === true

export function routeLabel(r: Route, lines: ReadonlyMap<string, TransitLine>): string {
  const line = lines.get(routeKey(r.id))
  if (line) return lineLabel(line)
  if (r.kind === 'on_demand_zone') return 'On-demand zone'
  return routeKey(r.id).startsWith('fdr-') ? 'New feeder' : r.id
}

/** The colour a route draws in: the plan's service colour for new or upgraded service, else its feed colour. */
export function routeColor(r: Route, lines: ReadonlyMap<string, TransitLine>): Color {
  if (r.kind === 'frequent_bus' || r.kind === 'brt' || r.kind === 'on_demand_zone') return PROPOSED_COLORS[r.kind]
  return lines.get(routeKey(r.id))?.color ?? (r.kind === 'rail_existing' ? INK : BUS_FALLBACK)
}

/** Colour per route key for stop rings: feed colours, overridden by the plan's colour where a route is upgraded. */
export function transitKeyColors(lines: TransitLine[], routes: Route[]): Map<string, Color> {
  const m = new Map(lines.map((l) => [l.key, l.color]))
  // BRT before frequent bus, so a corridor that gets both rings in the frequent-bus colour it draws on top
  for (const r of routes.filter(isProposedRoute).sort((a, b) => PROPOSED_ORDER[a.kind] - PROPOSED_ORDER[b.kind])) {
    m.set(routeKey(r.id), routeColor(r, NO_LINES))
  }
  return m
}
const NO_LINES: ReadonlyMap<string, TransitLine> = new Map()

const focused = (focus: TransitFocus, key: string) => focus?.has(key) === true
const dimmed = (focus: TransitFocus, key: string) => focus !== null && !focus.has(key)
const ROUNDED = { lineJointRounded: true, lineCapRounded: true } as const

/** Existing feed lines: buses thin and softened, rail bold, both over one white casing. */
export function transitExistingLayer(lines: TransitLine[], visible: boolean, focus: TransitFocus) {
  // buses under rail, focused lines over both
  const rank = (l: TransitLine) => (focused(focus, l.key) ? 2 : 0) + (l.mode === 'rail' ? 1 : 0)
  const data = [...lines].sort((a, b) => rank(a) - rank(b)).map((l) => feature(l.geometry, l))
  const width = (l: TransitLine) => (l.mode === 'rail' ? 4.5 : 2.5) + (focused(focus, l.key) ? 2.5 : 0)
  const color = (l: TransitLine): Color => {
    if (dimmed(focus, l.key)) return withAlpha(l.color, l.mode === 'rail' ? 80 : 45)
    return withAlpha(l.color, focus || l.mode === 'rail' ? 255 : 210)
  }
  return [
    new GeoJsonLayer<TransitLine>({
      id: 'transit_casing',
      parameters: FLAT,
      data,
      visible,
      filled: false,
      ...ROUNDED,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => width(f.properties) + 3,
      getLineColor: (f) => withAlpha(WHITE, dimmed(focus, f.properties.key) ? 90 : 255),
    }),
    new GeoJsonLayer<TransitLine>({
      id: 'transit_lines',
      parameters: FLAT,
      data,
      visible,
      pickable: true,
      filled: false,
      ...ROUNDED,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => width(f.properties),
      getLineColor: (f) => color(f.properties),
    }),
  ]
}

/** Feed stops as plain dots, only until the transit plan's stops (with ridership) arrive. */
export function feedStopsLayer(infra: InfraFeature[], visible: boolean) {
  return new ScatterplotLayer<InfraFeature>({
    id: 'feed_stops',
    parameters: FLAT,
    data: infra.filter((f) => f.kind === 'bus_stop' && f.geometry.type === 'Point'),
    visible,
    getPosition: (f) => f.geometry.coordinates as unknown as LonLat,
    radiusUnits: 'meters',
    getRadius: 5,
    radiusMinPixels: 2,
    radiusMaxPixels: 6,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 1.5,
    getLineColor: withAlpha(INK, 200),
    getFillColor: WHITE,
  })
}

export function stationsLayer(stations: Station[], visible: boolean) {
  return new ScatterplotLayer<Station>({
    id: 'stations',
    parameters: FLAT,
    data: stations,
    visible,
    getPosition: (s) => s.lonlat,
    radiusUnits: 'pixels',
    getRadius: 7,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 3,
    getLineColor: INK,
    getFillColor: (s) => (s.mode === 'intercity_rail_planned' ? [237, 239, 234] : [255, 255, 255]),
    pickable: true,
  })
}

export interface ProposedDatum {
  route: Route
  key: string
  name: string
  color: Color
}

// BRT draws under the frequent-bus line on the same corridor, so the pair reads as a green-edged teal band.
const PROPOSED_ORDER: Record<Route['kind'], number> = { rail_existing: 0, bus_existing: 0, on_demand_zone: 0, brt: 1, frequent_bus: 2 }

export function proposedTransitLayer(routes: Route[], lines: ReadonlyMap<string, TransitLine>, visible: boolean, focus: TransitFocus) {
  const rank = (d: ProposedDatum) => (focused(focus, d.key) ? 3 : 0) + PROPOSED_ORDER[d.route.kind]
  const data = routes
    .filter(isProposedRoute)
    .map((r): ProposedDatum => ({ route: r, key: routeKey(r.id), name: routeLabel(r, lines), color: routeColor(r, lines) }))
    .sort((a, b) => rank(a) - rank(b))
    .map((d) => feature(d.route.geometry, d))
  const width = (d: ProposedDatum) =>
    (d.route.kind === 'brt' ? 10 : d.route.kind === 'on_demand_zone' ? 2 : 5) + (focused(focus, d.key) ? 3 : 0)
  return [
    new GeoJsonLayer<ProposedDatum>({
      id: 'proposed_casing',
      parameters: FLAT,
      data,
      visible,
      filled: false,
      ...ROUNDED,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => width(f.properties) + 3,
      getLineColor: (f) => withAlpha(WHITE, dimmed(focus, f.properties.key) ? 90 : 255),
    }),
    new GeoJsonLayer<ProposedDatum, { getDashArray?: unknown; dashJustified?: boolean }>({
      id: 'proposed_routes',
      parameters: FLAT,
      data,
      visible,
      pickable: true,
      filled: true,
      stroked: true,
      ...ROUNDED,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => width(f.properties),
      getLineColor: (f) => withAlpha(f.properties.color, dimmed(focus, f.properties.key) ? 70 : 255),
      getFillColor: (f) => withAlpha(f.properties.color, dimmed(focus, f.properties.key) ? 8 : focused(focus, f.properties.key) ? 48 : 24),
      getDashArray: (f: Feat<ProposedDatum>) => (f.properties.route.kind === 'on_demand_zone' ? [6, 4] : [0, 0]),
      dashJustified: true,
      extensions: [new PathStyleExtension({ dash: true })],
    }),
  ]
}

export interface StopDatum {
  stop: Stop
  /** Serves a new or upgraded route. */
  proposed: boolean
  /** Ring colour of the focused route it serves, when it serves one. */
  focusColor: Color | null
}

/**
 * The plan's stops (with ridership ranges): those on new or upgraded routes with the proposed layer, the rest with the
 * existing one. Sized in metres so the network thins out when zoomed out; the selected stop is always drawn.
 */
export function stopsLayer(
  stops: Stop[],
  proposedKeys: ReadonlySet<string>,
  keyColors: ReadonlyMap<string, Color>,
  show: { existing: boolean; proposed: boolean },
  focus: TransitFocus,
  selectedStop?: string,
) {
  const data: StopDatum[] = []
  for (const stop of stops) {
    const proposed = stop.route_ids.some((k) => proposedKeys.has(k))
    if (stop.id !== selectedStop && !(proposed ? show.proposed : show.existing)) continue
    const k = focus ? stop.route_ids.find((r) => focus.has(r)) : undefined
    data.push({ stop, proposed, focusColor: k === undefined ? null : keyColors.get(k) ?? INK })
  }
  // focused and selected stops on top
  const rank = (d: StopDatum) => (d.stop.id === selectedStop ? 2 : d.focusColor ? 1 : 0)
  data.sort((a, b) => rank(a) - rank(b))
  const faded = (d: StopDatum) => focus !== null && !d.focusColor && d.stop.id !== selectedStop
  return new ScatterplotLayer<StopDatum>({
    id: 'stops',
    parameters: FLAT,
    data,
    pickable: true,
    getPosition: (d) => d.stop.lonlat,
    radiusUnits: 'meters',
    getRadius: (d) => (d.stop.id === selectedStop ? 14 : d.focusColor ? 9 : d.proposed ? 7 : 5),
    radiusMinPixels: 2.5,
    radiusMaxPixels: 10,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: (d) => (d.focusColor ? 2.5 : 1.5),
    getLineColor: (d) => (faded(d) ? withAlpha(INK, 50) : d.focusColor ?? (d.proposed ? TEAL : withAlpha(INK, 200))),
    getFillColor: (d) => (d.stop.id === selectedStop ? AMBER : withAlpha(WHITE, faded(d) ? 90 : 255)),
  })
}

export function walkBikeLayer(infra: InfraFeature[], visible: boolean) {
  const feats = infra.filter((f) => f.kind === 'sidewalk' || f.kind === 'bike_lane').map((f) => feature(f.geometry, f))
  return new GeoJsonLayer<InfraFeature>({
    id: 'walk_bike',
    parameters: FLAT,
    data: feats,
    visible,
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    getLineColor: (f) => {
      const p = f.properties
      if (p.kind === 'sidewalk' && NO_SIDEWALK[String(p.attrs.sidewalk ?? '').toLowerCase()]) return NO_SIDEWALK_COLOR
      return withAlpha(INFRA_COLORS[p.kind] ?? [154, 160, 154], 170)
    },
    pointRadiusUnits: 'pixels',
    getPointRadius: 1,
  })
}

export function utilitiesLayer(infra: InfraFeature[], visible: boolean) {
  const feats = infra
    .filter((f) => f.kind === 'water_main' || f.kind === 'sewer_main' || f.kind === 'power_substation')
    .map((f) => feature(f.geometry, f))
  return new GeoJsonLayer<InfraFeature, { getDashArray?: unknown; dashJustified?: boolean }>({
    id: 'utilities',
    parameters: FLAT,
    data: feats,
    visible,
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    getLineColor: (f) => withAlpha(INFRA_COLORS[f.properties.kind] ?? [150, 150, 150], 200),
    // Some counties publish service areas (polygons) rather than mains: a light wash, not a solid sheet.
    getFillColor: (f) => withAlpha(INFRA_COLORS[f.properties.kind] ?? [150, 150, 150], f.geometry.type === 'Point' ? 200 : 30),
    pointRadiusUnits: 'pixels',
    getPointRadius: 4,
    getDashArray: [4, 3],
    dashJustified: true,
    extensions: [new PathStyleExtension({ dash: true })],
  })
}

/** `pendingParks`: parcels whose proposed park is still being laid out (construction.ts draws it meanwhile). */
export function amenitiesLayer(infra: InfraFeature[], added: InfraFeature[], visible: boolean, pendingParks: ReadonlySet<string>) {
  const kinds: Partial<Record<InfraKind, true>> = {
    ev_charger: true,
    school: true,
    clinic: true,
    park: true,
    grocery: true,
    affordable_housing: true,
  }
  const feats = [...infra, ...added.filter((f) => !pendingParks.has(String(f.attrs.parcel_id)))]
    .filter((f) => kinds[f.kind])
    .map((f) => feature(f.geometry, f))
  return new GeoJsonLayer<InfraFeature>({
    id: 'amenities',
    parameters: FLAT,
    data: feats,
    visible,
    stroked: true,
    filled: true,
    pickable: true,
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    getLineWidth: (f) => (f.properties.attrs.proposed ? 3 : 1),
    getLineColor: (f) => (f.properties.attrs.proposed ? INK : INFRA_COLORS[f.properties.kind] ?? [154, 160, 154]),
    getFillColor: (f) => withAlpha(INFRA_COLORS[f.properties.kind] ?? [154, 160, 154], f.properties.attrs.proposed ? 200 : 110),
    pointType: 'circle',
    pointRadiusUnits: 'pixels',
    getPointRadius: 4,
    updateTriggers: { getFillColor: added, getLineColor: added, getLineWidth: added },
  })
}

export function floodLayer(infra: InfraFeature[], visible: boolean) {
  const feats = infra.filter((f) => f.kind === 'flood_zone').map((f) => feature(f.geometry, f))
  return new GeoJsonLayer<InfraFeature>({
    id: 'flood',
    parameters: FLAT,
    data: feats,
    visible,
    filled: true,
    stroked: true,
    getFillColor: [47, 91, 211, 28],
    getLineColor: [47, 91, 211, 120],
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
  })
}

export interface ParcelDatum {
  parcel: Parcel
  underused: boolean
}

/** `taken`: parcels a proposed park or new build now occupies; they keep their outline but drop the fill. */
export function parcelsLayer(parcels: Parcel[], visible: boolean, selectedId?: string, taken: ReadonlySet<string> = NO_IDS) {
  const feats = parcels.map((p) =>
    feature<ParcelDatum>(p.geometry, { parcel: p, underused: !!UNDERUSED_LAND_USES[p.land_use.value ?? ''] }),
  )
  return new GeoJsonLayer<ParcelDatum>({
    id: 'parcels',
    parameters: FLAT,
    data: feats,
    visible,
    pickable: true,
    filled: true,
    stroked: true,
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    // a 1 px hairline faded right back: a half-pixel stroke shimmered as the camera moved
    getLineWidth: (f) => (f.properties.parcel.id === selectedId ? 3 : 1),
    getLineColor: (f) => (f.properties.parcel.id === selectedId ? INK : [28, 34, 48, 34]),
    getFillColor: (f) =>
      taken.has(f.properties.parcel.id) ? [0, 0, 0, 0] : f.properties.underused ? withAlpha(AMBER, 120) : [28, 34, 48, 6],
    updateTriggers: { getLineWidth: selectedId, getLineColor: selectedId, getFillColor: taken },
  })
}
const NO_IDS: ReadonlySet<string> = new Set()

/** Outline + light fill for the selected parcel, drawn whether or not the parcels layer is on. */
export function selectedParcelLayer(parcels: Parcel[], selectedId?: string) {
  const p = selectedId ? parcels.find((x) => x.id === selectedId) : undefined
  return new GeoJsonLayer<ParcelDatum>({
    id: 'selected-parcel',
    parameters: FLAT,
    data: p ? [feature<ParcelDatum>(p.geometry, { parcel: p, underused: false })] : [],
    pickable: false,
    filled: true,
    stroked: true,
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    getLineWidth: 3,
    getLineColor: INK,
    getFillColor: [227, 180, 72, 90],
  })
}

export interface BuildingDatum {
  building: Building
  conversion: ConversionCandidate | undefined
  polygon: number[][][]
}

/**
 * One datum per drawn polygon, with overlapping footprints resolved (footprints.ts) so extrusions never z-fight and
 * outlines simplified (simplifyRing) so near-collinear nodes add no facets.
 */
export function flattenBuildings(buildings: Building[], conversions: ConversionCandidate[]): BuildingDatum[] {
  const conv = new Map(conversions.map((c) => [c.building_id, c]))
  const shapes = separateFootprints(buildings, conversions)
  const out: BuildingDatum[] = []
  for (const b of buildings) {
    for (const p of shapes.get(b.id) ?? []) {
      out.push({ building: b, conversion: conv.get(b.id), polygon: p.map((r) => simplifyRing(r, OUTLINE_TOL_M)) })
    }
  }
  return out
}

/** Flat, matte material so the lighting reads as the iso figures' three face tones, not as gloss. */
export const MATTE = { ambient: 0.62, diffuse: 0.5, shininess: 0, specularColor: [0, 0, 0] as [number, number, number] }
const BLOCK: Color = [217, 221, 214]
const NO_CONVERSIONS: ReadonlyMap<string, UseType> = new Map()
// Selected building: ink, the one block darker than everything else on the paper ground (white vanished into it).
const SELECTED_BLOCK: Color = [58, 66, 86]
// The selection shell sits this much proud of the building so its faces never z-fight with the building's own.
const SELECTED_GROW = 1.02
const SELECTED_LIFT_M = 0.6

// A building whose use changes fades to its new colour (the scaffold wrap in construction.ts runs alongside).
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const RECOLOUR = { duration: REDUCED_MOTION ? 0 : 1600, easing: easeOutCubic }

export const storeyElevation = (b: Building, storyHeightFt: number | null) =>
  storyHeightFt !== null ? (b.stories.value ?? 0) * storyHeightFt * FT_TO_M : 0

/** A footprint's outer ring scaled about its vertex mean: shells that sit proud of a building, halos around it. */
export function grownRing(polygon: number[][][], factor: number): number[][] {
  const outer = polygon[0]
  const [cx, cy] = outer.reduce((a, p) => [a[0] + p[0] / outer.length, a[1] + p[1] / outer.length], [0, 0])
  return outer.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor])
}

// Hides buildings without reordering the data, so indices (and the colour transitions keyed on them) stay put.
const HIDE = new DataFilterExtension({ filterSize: 1 })

// ---------------------------------------------------------------- ink edges
// Building edges draw as screen-facing ink strokes (a set width in CSS pixels at any pixel ratio) instead of deck's
// wireframe, which ran a one-device-pixel line up every footprint vertex: a curved tower's dozens of vertices striped
// its facade. A footprint gets its roof and base outlines, and verticals only at its real corners (cornerIndices), so
// a round tower reads by its rims and a box by its edges.
/** Footprint vertices this close to the simplified outline are dropped (near-collinear nodes, traced-curve jitter). */
const OUTLINE_TOL_M = 0.35
/** A vertex where the outline turns at least this much is a corner and gets a vertical edge. */
const CORNER_TURN_DEG = 40
/** Sides shorter than this (jogs, notches, chamfers) end in no vertical edge: close verticals read as stripes. */
const MIN_SIDE_M = 2.5
/** A footprint with more corners than this (a sawtooth) keeps only its roof and base outlines. */
const MAX_CORNERS = 20
const EDGE_PX = 1
/** The iso camera's vertical field of view: narrow, so verticals stay close to parallel (MapView). */
export const ISO_FOV_DEG = 10
// deck draws a billboard path's pixel width at the viewport's focal distance in clip space, which with the narrow
// iso field of view (altitude 1 / (2 tan(fov / 2)) ≈ 5.7) came out that many times too wide; widths are divided back.
const BILLBOARD_PX = 2 * Math.tan((ISO_FOV_DEG / 2) * (Math.PI / 180))
// An edge straddles the faces it bounds, so their depth would hide its inner half. Every edge point moves this far
// along the view ray toward the iso camera (bearing −45°, pitch 60°: south-east and up), which leaves it where it
// was on screen but in front of the faces it outlines.
const EDGE_TOWARD_CAMERA_M = 2
const CAM_E = EDGE_TOWARD_CAMERA_M * Math.sin(Math.PI / 3) * Math.SQRT1_2
const CAM_UP = EDGE_TOWARD_CAMERA_M * Math.cos(Math.PI / 3)

/** One stroke of a building's edges, with the datum it belongs to (for filtering). */
export interface EdgePath<T> {
  path: [number, number, number][]
  of: T
}

const cornerCache = new WeakMap<number[][], number[]>()
function cornersOf(ring: number[][]): number[] {
  let c = cornerCache.get(ring)
  if (!c) {
    c = ring.length > 3 ? cornerIndices(ring, CORNER_TURN_DEG, MIN_SIDE_M) : []
    if (c.length > MAX_CORNERS) c = []
    cornerCache.set(ring, c)
  }
  return c
}

/** Edges of `polygon` extruded from `base` to `top` metres: roof outlines (holes too), base outline, corner verticals. */
export function pushEdges<T>(out: EdgePath<T>[], of: T, polygon: number[][][], top: number, base = 0) {
  const outer = polygon[0]
  if (!outer?.length) return
  const dLon = CAM_E / (M_PER_DEG * Math.cos((outer[0][1] * Math.PI) / 180))
  const dLat = -CAM_E / M_PER_DEG
  const at = (p: number[], z: number): [number, number, number] => [p[0] + dLon, p[1] + dLat, z + CAM_UP]
  for (const ring of polygon) out.push({ of, path: ring.map((p) => at(p, top)) })
  if (top - base < 0.05) return
  out.push({ of, path: outer.map((p) => at(p, base)) })
  for (const i of cornersOf(outer)) out.push({ of, path: [at(outer[i], base), at(outer[i], top)] })
}

/** Ink strokes for `pushEdges` output; `hide(of)` filters strokes out without rebuilding them. */
export function edgesLayer<T>(
  id: string,
  data: EdgePath<T>[],
  color: Color | ((of: T) => Color),
  opts: { visible?: boolean; width?: number; hide?: (of: T) => boolean; hideTrigger?: unknown } = {},
) {
  const { visible = true, width = EDGE_PX, hide, hideTrigger } = opts
  return new PathLayer<EdgePath<T>, DataFilterExtensionProps<EdgePath<T>>>({
    id,
    data,
    visible,
    pickable: false,
    billboard: true,
    widthUnits: 'pixels',
    getWidth: width * BILLBOARD_PX,
    antialiasing: true,
    jointRounded: true,
    capRounded: true,
    getPath: (e) => e.path,
    getColor: typeof color === 'function' ? (e) => color(e.of) : color,
    extensions: [HIDE],
    getFilterValue: (e) => (hide?.(e.of) ? 0 : 1),
    filterRange: [0.5, 1],
    updateTriggers: { getFilterValue: hideTrigger },
  })
}

const BUILDING_EDGE: Color = [28, 34, 48, 200]
const buildingEdgeCache = new WeakMap<BuildingDatum[], { sh: number | null; paths: EdgePath<BuildingDatum>[] }>()
function buildingEdges(data: BuildingDatum[], storyHeightFt: number | null): EdgePath<BuildingDatum>[] {
  const hit = buildingEdgeCache.get(data)
  if (hit && hit.sh === storyHeightFt) return hit.paths
  const paths: EdgePath<BuildingDatum>[] = []
  for (const d of data) pushEdges(paths, d, d.polygon, storeyElevation(d.building, storyHeightFt))
  buildingEdgeCache.set(data, { sh: storyHeightFt, paths })
  return paths
}

/**
 * Existing buildings: light grey blocks; a building the plan converts (`converted`: building id → its new use) in that
 * use's colour, so every Convert tile visibly changes its building. Ink edges. Extrusion height = stories ×
 * story_height_ft (factor); without the factor, buildings stay flat. `hidden` buildings are being (or have been)
 * demolished: demolitionLayer draws them.
 */
export function buildingsLayer(
  data: BuildingDatum[],
  storyHeightFt: number | null,
  visible: boolean,
  hidden: ReadonlySet<string>,
  converted: ReadonlyMap<string, UseType> = NO_CONVERSIONS,
): Layer[] {
  return [
    new PolygonLayer<BuildingDatum, DataFilterExtensionProps<BuildingDatum>>({
      id: 'buildings',
      // PolygonLayer does not pass an extension accessor's update trigger to its sublayers, so a changed `hidden` set
      // never reached the filter values; a fresh array (same order) makes every attribute recompute instead.
      data: hidden.size ? data.slice() : data,
      visible,
      pickable: true,
      extruded: storyHeightFt !== null,
      filled: true,
      stroked: false,
      material: MATTE,
      getPolygon: (d) => d.polygon,
      getElevation: (d) => storeyElevation(d.building, storyHeightFt),
      getFillColor: (d) => {
        const use = converted.get(d.building.id)
        return use ? USE_COLORS[use] : BLOCK
      },
      extensions: [HIDE],
      getFilterValue: (d) => (hidden.has(d.building.id) ? 0 : 1),
      filterRange: [0.5, 1],
      updateTriggers: { getElevation: storyHeightFt, getFilterValue: hidden, getFillColor: converted },
      // conversions arriving from the agent, a Convert tile or an undo all show as a fade, not a jump
      transitions: { getFillColor: RECOLOUR },
    }),
    edgesLayer('building-edges', buildingEdges(data, storyHeightFt), BUILDING_EDGE, {
      visible,
      hide: (d) => hidden.has(d.building.id),
      hideTrigger: hidden,
    }),
  ]
}

/** Buildings coming down for a new build or a park, at their standing share of height; gone once demolished. */
export function demolitionLayer(data: BuildingDatum[], storyHeightFt: number | null, demolitions: ReadonlyMap<string, Build>, clock: number): Layer[] {
  const falling: { d: BuildingDatum; h: number }[] = []
  for (const d of data) {
    const b = demolitions.get(d.building.id)
    const share = b ? standingShare(b, clock) : 0
    if (share > 0) falling.push({ d, h: storeyElevation(d.building, storyHeightFt) * share })
  }
  const edges: EdgePath<BuildingDatum>[] = []
  for (const f of falling) pushEdges(edges, f.d, f.d.polygon, f.h)
  return [
    new PolygonLayer<(typeof falling)[number]>({
      id: 'demolition',
      data: falling,
      extruded: storyHeightFt !== null,
      material: MATTE,
      getPolygon: (f) => f.d.polygon,
      getElevation: (f) => f.h,
      getFillColor: BLOCK,
      updateTriggers: { getElevation: clock },
    }),
    edgesLayer('demolition-edges', edges, BUILDING_EDGE),
  ]
}

/** The selected building as a slightly larger ink shell over it: instant, unlike the faded use colours. */
export function selectedBuildingLayer(data: BuildingDatum[], storyHeightFt: number | null, selectedId?: string): Layer[] {
  const sel = selectedId ? data.filter((d) => d.building.id === selectedId) : []
  const grown = sel.map((d) => ({ d, ring: grownRing(d.polygon, SELECTED_GROW) }))
  const top = (g: (typeof grown)[number]) => storeyElevation(g.d.building, storyHeightFt) + SELECTED_LIFT_M
  const edges: EdgePath<null>[] = []
  for (const g of grown) pushEdges(edges, null, [g.ring], top(g))
  return [
    new PolygonLayer<(typeof grown)[number]>({
      id: 'selected-building',
      data: grown,
      extruded: storyHeightFt !== null,
      material: MATTE,
      getPolygon: (g) => g.ring,
      getElevation: top,
      getFillColor: SELECTED_BLOCK,
    }),
    edgesLayer('selected-building-edges', edges, [28, 34, 48, 220], { width: 1.25 }),
  ]
}

// ---------------------------------------------------------------- click-twice tiles (edit mode)
// An armed tile highlights the targets it can land on (tools.ts) in the tile's colour; MapView pulses the layer's
// opacity and dims the rest. Both layers decode as parcels / buildings, so a click picks them like the originals.

export const TILE_COLORS: Record<TileKind, Color> = {
  homes: USE_COLORS.residential,
  park: [46, 125, 91],
  stop: TEAL,
  convert_residential: USE_COLORS.residential,
  convert_hotel: USE_COLORS.hotel,
}

/** Parcels an armed Homes / Park / Stop tile can land on: tinted fill and an ink outline. Pickable even with the
 *  parcels layer off. */
export function toolParcelsLayer(parcels: Parcel[], valid: ReadonlySet<string>, color: Color) {
  return new GeoJsonLayer<ParcelDatum>({
    id: 'tool_parcels',
    parameters: FLAT,
    data: parcels.filter((p) => valid.has(p.id)).map((p) => feature<ParcelDatum>(p.geometry, { parcel: p, underused: false })),
    pickable: true,
    filled: true,
    stroked: true,
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    getLineWidth: 1.6,
    getLineColor: withAlpha(INK, 230),
    getFillColor: withAlpha(color, 130),
  })
}

const TOOL_GROW = 1.035
const TOOL_LIFT_M = 0.8

/** Buildings an armed Convert tile can land on: a shell in the tile's colour, a little proud of each building. */
export function toolBuildingsLayer(data: BuildingDatum[], storyHeightFt: number | null, valid: ReadonlySet<string>, color: Color): Layer[] {
  const shells = data.filter((d) => valid.has(d.building.id)).map((d): BuildingDatum => ({ ...d, polygon: [grownRing(d.polygon, TOOL_GROW)] }))
  const top = (d: BuildingDatum) => storeyElevation(d.building, storyHeightFt) + TOOL_LIFT_M
  const edges: EdgePath<null>[] = []
  for (const d of shells) pushEdges(edges, null, d.polygon, top(d))
  return [
    new PolygonLayer<BuildingDatum>({
      id: 'tool_buildings',
      data: shells,
      pickable: true,
      extruded: storyHeightFt !== null,
      filled: true,
      material: MATTE,
      getPolygon: (d) => d.polygon,
      getElevation: top,
      getFillColor: withAlpha(color, 200),
    }),
    edgesLayer('tool_building_edges', edges, withAlpha(INK, 230), { width: 1.5 }),
  ]
}

export interface SiteDatum {
  site: Site
  letter: string
  strategy: DealKind | undefined
  centroid: LonLat | null
}

export function siteLetters(sites: Site[]): Map<string, string> {
  const m = new Map<string, string>()
  let i = 0
  for (const s of sites) {
    if (s.status !== 'pursue') continue
    const n = i++
    m.set(s.id, n < 26 ? String.fromCharCode(65 + n) : `A${n - 25}`)
  }
  return m
}

export function pursuedSites(sites: Site[], strategyBySite: Map<string, DealKind>): SiteDatum[] {
  const letters = siteLetters(sites)
  return sites
    .filter((s) => s.status === 'pursue')
    .map((s) => ({
      site: s,
      letter: letters.get(s.id) ?? '',
      strategy: strategyBySite.get(s.id),
      centroid: geometryCentroid(s.geometry),
    }))
}

export function sitesLayer(data: SiteDatum[], visible: boolean) {
  return [
    new GeoJsonLayer<SiteDatum>({
      id: 'sites',
      data: data.map((d) => feature(d.site.geometry, d)),
      visible,
      pickable: true,
      filled: false,
      stroked: true,
      ...ROUNDED,
      lineWidthUnits: 'pixels',
      getLineWidth: 3,
      getLineColor: (f) => (f.properties.strategy ? STRATEGY_COLORS[f.properties.strategy] : INK),
    }),
    new TextLayer<SiteDatum>({
      id: 'site_labels',
      data: data.filter((d) => d.centroid),
      visible,
      getPosition: (d) => d.centroid as LonLat,
      getText: (d) => d.letter,
      getSize: 18,
      getColor: INK,
      fontWeight: 700,
      outlineWidth: 4,
      outlineColor: [237, 239, 234, 255],
      fontSettings: { sdf: true },
      billboard: true,
      getPixelOffset: [0, -14],
    }),
  ]
}

const NEW_BUILD: Color = [169, 191, 231]
// On-watch sites (the plan counts them; they don't pencil yet) stand as translucent massing, pursued ones solid.
const NEW_BUILD_WATCH_ALPHA = 110

// ---------------------------------------------------------------- green-space slider
// The slider moves a share of every in-plan new build's homes into open space (rescore.py: homes × (1 − share)). On
// the map each such plot is cut across its long axis: the building keeps (1 − share) of the plot's area and a lawn
// takes the rest, at the plot's near end (toward the iso camera) so it reads in front of the building.
const M_PER_DEG = 111_320 // unit conversion, not a planning factor
/** Toward the iso camera, which looks north-west, in local east/north metres. */
const NEAR_SIDE = [Math.SQRT1_2, -Math.SQRT1_2]
const SPLIT_STEPS = 24 // bisection steps for the cut: far below a centimetre on any plot
/** A plot whose long axis is less than this times its short one counts as near square. */
const SQUARISH = 1.4
const LAWN: Color = withAlpha(INFRA_COLORS.park!, 200) // the proposed-park fill of amenitiesLayer

/** A new build's plot piece: the building's footprint and, with green space, the lawn beside it. */
export interface GreenPlot {
  site: Site
  /** Site id (with the piece index for a multi-part plot): stable across slider moves, so plantings keep their seed. */
  key: string
  building: number[][][]
  lawn: number[][][] | null
}

/** The part of `pts` (local metres) on one side of the line p·a = c: Sutherland–Hodgman against one half-plane. */
function clipHalf(pts: number[][], ax: number, ay: number, c: number, above: boolean): number[][] {
  const out: number[][] = []
  const s = above ? 1 : -1
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    const fp = s * (p[0] * ax + p[1] * ay - c)
    const fq = s * (q[0] * ax + q[1] * ay - c)
    if (fp >= 0) out.push(p)
    if (fp * fq < 0) {
      const t = fp / (fp - fq)
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])])
    }
  }
  return out
}

function shoelace(pts: number[][]): number {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1])
  return Math.abs(a) / 2
}

/** Lowest and highest projection of `pts` on (ax, ay). */
function span(pts: number[][], ax: number, ay: number): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    const v = p[0] * ax + p[1] * ay
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  return [lo, hi]
}

/** Cut a plot (closed lon/lat ring) so the lawn covers `share` of it; a degenerate plot keeps its building whole. */
function splitPlot(ring: number[][], share: number): { building: number[][][]; lawn: number[][][] | null } {
  const [lon0, lat0] = ring[0]
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)
  const pts = ring.slice(0, -1).map(([x, y]) => [(x - lon0) * kx, (y - lat0) * M_PER_DEG])
  // cut across one of the plot's axes (its longest side's direction and that side's normal): the long one, so the
  // building keeps a usable shape, unless the plot is near square, then the one facing the camera most, so the
  // lawn lies in front of the building rather than beside it
  let [ex, ey, longest] = [1, 0, 0]
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length]
    const l = Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1])
    if (l > longest) [ex, ey, longest] = [(q[0] - pts[i][0]) / l, (q[1] - pts[i][1]) / l, l]
  }
  const [l1, h1] = span(pts, ex, ey)
  const [l2, h2] = span(pts, -ey, ex)
  const facing = (x: number, y: number) => Math.abs(x * NEAR_SIDE[0] + y * NEAR_SIDE[1])
  const squarish = Math.max(h1 - l1, h2 - l2) < SQUARISH * Math.min(h1 - l1, h2 - l2)
  const across = squarish ? facing(-ey, ex) > facing(ex, ey) : h2 - l2 > h1 - l1
  let [ax, ay] = across ? [-ey, ex] : [ex, ey]
  if (ax * NEAR_SIDE[0] + ay * NEAR_SIDE[1] < 0) [ax, ay] = [-ax, -ay]
  // the lawn is the part beyond the cut; its area falls as the cut moves along the axis
  const want = share * shoelace(pts)
  let [lo, hi] = span(pts, ax, ay)
  for (let k = 0; k < SPLIT_STEPS; k++) {
    const c = (lo + hi) / 2
    if (shoelace(clipHalf(pts, ax, ay, c, true)) > want) lo = c
    else hi = c
  }
  const cut = (lo + hi) / 2
  const building = clipHalf(pts, ax, ay, cut, false)
  const lawn = clipHalf(pts, ax, ay, cut, true)
  if (building.length < 3 || lawn.length < 3) return { building: [ring], lawn: null }
  const toLonLat = (q: number[][]) => [...q, q[0]].map(([x, y]) => [lon0 + x / kx, lat0 + y / M_PER_DEG])
  return { building: [toLonLat(building)], lawn: [toLonLat(lawn)] }
}

/**
 * Every new build still drawn (not passed), split for the green-space slider: `share` (0..1 of the plot) applies to
 * in-plan sites (pursue, watch), as in rescore.py; 0 leaves every plot whole.
 */
export function greenPlots(sites: Site[], share: number): GreenPlot[] {
  const out: GreenPlot[] = []
  for (const site of sites) {
    if (site.kind !== 'new_build' || site.status === 'pass') continue
    const g = site.status === 'pursue' || site.status === 'watch' ? share : 0
    const geom = site.geometry
    const polys = (geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : []) as number[][][][]
    polys.forEach((p, i) => {
      const key = polys.length > 1 ? `${site.id}:${i}` : site.id
      out.push(g > 0 ? { site, key, ...splitPlot(p[0], g) } : { site, key, building: p, lawn: null })
    })
  }
  return out
}

/** The slider's lawns: flat park green with an ink rim. */
export function lawnLayer(plots: GreenPlot[], visible: boolean) {
  return new PolygonLayer<GreenPlot>({
    id: 'green_lawns',
    parameters: FLAT,
    data: plots.filter((p) => p.lawn),
    visible,
    filled: true,
    stroked: true,
    ...ROUNDED,
    lineWidthUnits: 'pixels',
    getLineWidth: 1.5,
    getPolygon: (p) => p.lawn!,
    getFillColor: LAWN,
    getLineColor: withAlpha(INK, 190),
  })
}

/**
 * Proposed new buildings on their plots (`greenPlots`), at `rise(siteId)` (0..1) of their height while they are
 * being built (construction.ts); `clock` changes only while something is going up. A site moving between watch and
 * pursue fades between ghost and solid.
 */
export function newBuildingsLayer(plots: GreenPlot[], visible: boolean, rise: (siteId: string) => number, clock: number): Layer[] {
  const height = (s: Site) => s.height_ft * FT_TO_M * rise(s.id)
  const edges: EdgePath<Site>[] = []
  for (const p of plots) pushEdges(edges, p.site, p.building, height(p.site))
  return [
    new GeoJsonLayer<Site>({
      id: 'new_buildings',
      data: plots.map((p) => feature({ type: 'Polygon', coordinates: p.building }, p.site)),
      visible,
      pickable: true,
      extruded: true,
      filled: true,
      material: MATTE,
      getElevation: (f) => height(f.properties),
      getFillColor: (f) => (f.properties.status === 'pursue' ? NEW_BUILD : withAlpha(NEW_BUILD, NEW_BUILD_WATCH_ALPHA)),
      updateTriggers: { getElevation: clock },
      transitions: { getFillColor: RECOLOUR },
    }),
    edgesLayer('new_building_edges', edges, (s) => withAlpha(INK, s.status === 'pursue' ? 180 : 110), { visible }),
  ]
}

export type Picked =
  | { layer: 'parcels'; parcel: Parcel }
  | { layer: 'buildings'; building: Building; conversion: ConversionCandidate | undefined }
  | { layer: 'sites'; site: SiteDatum }
  | { layer: 'new_buildings'; site: Site }
  | { layer: 'stops'; stop: Stop }
  | { layer: 'proposed_routes'; route: ProposedDatum }
  | { layer: 'transit_lines'; line: TransitLine }
  | { layer: 'stations'; station: Station }
  | { layer: 'amenities'; feature: InfraFeature }

/**
 * deck.gl picking returns the picked layer's data element as `unknown`-ish `any`; the layer id determines
 * which datum type the builders above put there, so each branch narrows by id.
 */
export function decodePick(info: PickingInfo | null | undefined): Picked | null {
  const obj: unknown = info?.object
  if (!obj || !info?.layer) return null
  switch (info.layer.id) {
    case 'parcels':
    case 'tool_parcels': {
      const f = obj as Feat<ParcelDatum> // parcelsLayer data
      return { layer: 'parcels', parcel: f.properties.parcel }
    }
    case 'buildings':
    case 'tool_buildings': {
      const d = obj as BuildingDatum // buildingsLayer data
      return { layer: 'buildings', building: d.building, conversion: d.conversion }
    }
    case 'sites': {
      const f = obj as Feat<SiteDatum> // sitesLayer data
      return { layer: 'sites', site: f.properties }
    }
    case 'new_buildings': {
      const f = obj as Feat<Site> // newBuildingsLayer data
      return { layer: 'new_buildings', site: f.properties }
    }
    case 'stops':
      return { layer: 'stops', stop: (obj as StopDatum).stop } // stopsLayer data
    case 'proposed_routes': {
      const f = obj as Feat<ProposedDatum> // proposedTransitLayer data
      return { layer: 'proposed_routes', route: f.properties }
    }
    case 'transit_lines': {
      const f = obj as Feat<TransitLine> // transitExistingLayer data
      return { layer: 'transit_lines', line: f.properties }
    }
    case 'stations':
      return { layer: 'stations', station: obj as Station }
    case 'amenities': {
      const f = obj as Feat<InfraFeature> // amenitiesLayer data
      return { layer: 'amenities', feature: f.properties }
    }
    default:
      return null
  }
}
