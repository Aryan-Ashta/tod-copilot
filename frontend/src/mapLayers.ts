// deck.gl layer builders, in docs/06 order (bottom → top). Each builder is pure; MapView memoizes
// each one on the identity of its data so thousands of extrusions are not rebuilt on every render.
import { GeoJsonLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { DataFilterExtension, PathStyleExtension, type DataFilterExtensionProps } from '@deck.gl/extensions'
import type { Color, PickingInfo } from '@deck.gl/core'
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
  UseType,
} from './types'
import { geometryCentroid } from './format'
import { separateFootprints } from './footprints'
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
  { key: 'walk_bike', label: 'Sidewalks / bike lanes', group: 'Infrastructure', on: true },
  { key: 'utilities', label: 'Utilities (where public)', group: 'Infrastructure', on: true },
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

const INK: Color = [28, 34, 48]
const TEAL: Color = [19, 128, 138]
const INFRA_COLORS: Partial<Record<InfraKind, Color>> = {
  rail: INK,
  bus_route: [19, 128, 138, 120],
  bus_stop: TEAL,
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
const FLAT = { depthWriteEnabled: false, depthCompare: 'always' } as const

type Feat<P> = Feature<GJGeometry, P>
const feature = <P>(geometry: Geometry, properties: P) =>
  ({ type: 'Feature', geometry, properties }) as unknown as Feat<P>

const withAlpha = (c: Color, a: number): Color => [c[0], c[1], c[2], a]

/** OSM sidewalk tag values that mean "no sidewalk on this frontage". */
const NO_SIDEWALK: Record<string, true> = { no: true, none: true }

export function transitExistingLayer(infra: InfraFeature[], stations: Station[], visible: boolean) {
  const feats = infra
    .filter((f) => f.kind === 'rail' || f.kind === 'bus_route' || f.kind === 'bus_stop')
    .map((f) => feature(f.geometry, f))
  return [
    new GeoJsonLayer<InfraFeature>({
      id: 'transit_existing',
      parameters: FLAT,
      data: feats,
      visible,
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => (f.properties.kind === 'rail' ? 3 : 1.5),
      getLineColor: (f) => INFRA_COLORS[f.properties.kind] ?? [160, 160, 160],
      getFillColor: (f) => INFRA_COLORS[f.properties.kind] ?? [160, 160, 160],
      pointType: 'circle',
      pointRadiusUnits: 'pixels',
      getPointRadius: 2,
    }),
    new ScatterplotLayer<Station>({
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
    }),
  ]
}

export function walkBikeLayer(infra: InfraFeature[], visible: boolean) {
  const feats = infra.filter((f) => f.kind === 'sidewalk' || f.kind === 'bike_lane').map((f) => feature(f.geometry, f))
  return new GeoJsonLayer<InfraFeature>({
    id: 'walk_bike',
    parameters: FLAT,
    data: feats,
    visible,
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
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
  })
}

const PROPOSED_KINDS: Partial<Record<Route['kind'], true>> = { frequent_bus: true, brt: true, on_demand_zone: true }

export function proposedTransitLayer(routes: Route[], stops: Stop[], visible: boolean, selectedStop?: string) {
  const proposed = routes.filter((r) => PROPOSED_KINDS[r.kind])
  const feats = proposed.map((r) => feature(r.geometry, r))
  const proposedRouteIds = new Set(proposed.map((r) => r.id))
  return [
    new GeoJsonLayer<Route, { getDashArray?: unknown; dashJustified?: boolean }>({
      id: 'proposed_routes',
      parameters: FLAT,
      data: feats,
      visible,
      pickable: true,
      filled: true,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => (f.properties.kind === 'brt' ? 9 : f.properties.kind === 'on_demand_zone' ? 2 : 4),
      getLineColor: (f) => (f.properties.kind === 'brt' ? [46, 125, 91] : f.properties.kind === 'on_demand_zone' ? [47, 91, 211] : TEAL),
      getFillColor: [47, 91, 211, 24],
      getDashArray: (f: Feat<Route>) => (f.properties.kind === 'on_demand_zone' ? [6, 4] : [0, 0]),
      dashJustified: true,
      extensions: [new PathStyleExtension({ dash: true })],
    }),
    new ScatterplotLayer<Stop>({
      id: 'proposed_stops',
      parameters: FLAT,
      data: stops,
      visible,
      pickable: true,
      getPosition: (s) => s.lonlat,
      radiusUnits: 'pixels',
      getRadius: (s) => (s.id === selectedStop ? 8 : s.route_ids.some((r) => proposedRouteIds.has(r)) ? 5 : 3),
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: INK,
      getFillColor: (s) => (s.id === selectedStop ? [227, 180, 72] : [255, 255, 255]),
      updateTriggers: { getRadius: [selectedStop, proposedRouteIds.size], getFillColor: selectedStop },
    }),
  ]
}

export interface ParcelDatum {
  parcel: Parcel
  underused: boolean
}

export function parcelsLayer(parcels: Parcel[], visible: boolean, selectedId?: string) {
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
    lineWidthUnits: 'pixels',
    getLineWidth: (f) => (f.properties.parcel.id === selectedId ? 3 : 0.5),
    getLineColor: (f) => (f.properties.parcel.id === selectedId ? INK : [28, 34, 48, 50]),
    getFillColor: (f) => (f.properties.underused ? withAlpha(AMBER, 120) : [28, 34, 48, 6]),
    updateTriggers: { getLineWidth: selectedId, getLineColor: selectedId },
  })
}

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

/** One datum per drawn polygon, with overlapping footprints resolved (footprints.ts) so extrusions never z-fight. */
export function flattenBuildings(buildings: Building[], conversions: ConversionCandidate[]): BuildingDatum[] {
  const conv = new Map(conversions.map((c) => [c.building_id, c]))
  const shapes = separateFootprints(buildings, conversions)
  const out: BuildingDatum[] = []
  for (const b of buildings) {
    for (const polygon of shapes.get(b.id) ?? []) out.push({ building: b, conversion: conv.get(b.id), polygon })
  }
  return out
}

/** Flat, matte material so the lighting reads as the iso figures' three face tones, not as gloss. */
export const MATTE = { ambient: 0.62, diffuse: 0.5, shininess: 0, specularColor: [0, 0, 0] as [number, number, number] }
const BLOCK: Color = [217, 221, 214]
const mix = (a: Color, b: Color, t: number): Color => {
  const at = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t)
  return [at(0), at(1), at(2)]
}
// Selected building: ink, the one block darker than everything else on the paper ground (white vanished into it).
const SELECTED_BLOCK: Color = [58, 66, 86]
// The selection shell sits this much proud of the building so its faces never z-fight with the building's own.
const SELECTED_GROW = 1.02
const SELECTED_LIFT_M = 0.6

// A building whose use changes fades to its new colour (the scaffold wrap in construction.ts runs alongside).
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const RECOLOUR = { duration: REDUCED_MOTION ? 0 : 1600, easing: easeOutCubic }

const storeyElevation = (b: Building, storyHeightFt: number | null) =>
  storyHeightFt !== null ? (b.stories.value ?? 0) * storyHeightFt * FT_TO_M : 0

// Hides buildings without reordering the data, so indices (and the colour transitions keyed on them) stay put.
const HIDE = new DataFilterExtension({ filterSize: 1 })

/**
 * Existing buildings: light grey blocks; conversion candidates in their best-use colour, washed toward the block grey
 * as the overall score falls. Ink wireframe edges. Extrusion height = stories × story_height_ft (factor); without
 * the factor, buildings stay flat. `hidden` buildings are being (or have been) demolished: demolitionLayer draws them.
 */
export function buildingsLayer(data: BuildingDatum[], storyHeightFt: number | null, visible: boolean, hidden: ReadonlySet<string>) {
  return new PolygonLayer<BuildingDatum, DataFilterExtensionProps<BuildingDatum>>({
    id: 'buildings',
    // PolygonLayer does not pass an extension accessor's update trigger to its sublayers, so a changed `hidden` set
    // never reached the filter values; a fresh array (same order) makes every attribute recompute instead.
    data: hidden.size ? data.slice() : data,
    visible,
    pickable: true,
    extruded: storyHeightFt !== null,
    wireframe: true,
    filled: true,
    stroked: true,
    lineWidthUnits: 'pixels',
    material: MATTE,
    getPolygon: (d) => d.polygon,
    getElevation: (d) => storeyElevation(d.building, storyHeightFt),
    getFillColor: (d) => {
      if (!d.conversion) return BLOCK
      return mix(BLOCK, USE_COLORS[d.conversion.best_use], Math.max(0.15, d.conversion.overall))
    },
    getLineColor: [28, 34, 48, 150],
    getLineWidth: 0.5,
    extensions: [HIDE],
    getFilterValue: (d) => (hidden.has(d.building.id) ? 0 : 1),
    filterRange: [0.5, 1],
    updateTriggers: { getElevation: storyHeightFt, getFilterValue: hidden },
    // conversions arriving from the agent, a Convert tile or an undo all show as a fade, not a jump
    transitions: { getFillColor: RECOLOUR },
  })
}

/** Buildings coming down for a new build or a park, at their standing share of height; gone once demolished. */
export function demolitionLayer(data: BuildingDatum[], storyHeightFt: number | null, demolitions: ReadonlyMap<string, Build>, clock: number) {
  const falling = data.filter((d) => {
    const b = demolitions.get(d.building.id)
    return b !== undefined && standingShare(b, clock) > 0
  })
  return new PolygonLayer<BuildingDatum>({
    id: 'demolition',
    data: falling,
    extruded: storyHeightFt !== null,
    wireframe: true,
    material: MATTE,
    getPolygon: (d) => d.polygon,
    getElevation: (d) => storeyElevation(d.building, storyHeightFt) * standingShare(demolitions.get(d.building.id)!, clock),
    getFillColor: BLOCK,
    getLineColor: [28, 34, 48, 150],
    updateTriggers: { getElevation: clock },
  })
}

/** The selected building as a slightly larger ink shell over it: instant, unlike the faded use colours. */
export function selectedBuildingLayer(data: BuildingDatum[], storyHeightFt: number | null, selectedId?: string) {
  const sel = selectedId ? data.filter((d) => d.building.id === selectedId) : []
  const grown = sel.map((d) => {
    const outer = d.polygon[0]
    const [cx, cy] = outer.reduce((a, p) => [a[0] + p[0] / outer.length, a[1] + p[1] / outer.length], [0, 0])
    return { d, ring: outer.map(([x, y]) => [cx + (x - cx) * SELECTED_GROW, cy + (y - cy) * SELECTED_GROW]) }
  })
  return new PolygonLayer<(typeof grown)[number]>({
    id: 'selected-building',
    data: grown,
    extruded: storyHeightFt !== null,
    wireframe: true,
    material: MATTE,
    getPolygon: (g) => g.ring,
    getElevation: (g) => storeyElevation(g.d.building, storyHeightFt) + SELECTED_LIFT_M,
    getFillColor: SELECTED_BLOCK,
    getLineColor: [28, 34, 48, 200],
  })
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

/**
 * Proposed new buildings for every site still in the plan, at `rise(siteId)` (0..1) of their height while they are
 * being built (construction.ts); `clock` changes only while something is going up. A site moving between watch and
 * pursue fades between ghost and solid.
 */
export function newBuildingsLayer(sites: Site[], visible: boolean, rise: (siteId: string) => number, clock: number) {
  const data = sites.filter((s) => s.kind === 'new_build' && s.status !== 'pass').map((s) => feature(s.geometry, s))
  return new GeoJsonLayer<Site>({
    id: 'new_buildings',
    data,
    visible,
    pickable: true,
    extruded: true,
    wireframe: true,
    filled: true,
    material: MATTE,
    getElevation: (f) => f.properties.height_ft * FT_TO_M * rise(f.properties.id),
    getFillColor: (f) => (f.properties.status === 'pursue' ? NEW_BUILD : withAlpha(NEW_BUILD, NEW_BUILD_WATCH_ALPHA)),
    getLineColor: [28, 34, 48, 170],
    updateTriggers: { getElevation: clock },
    transitions: { getFillColor: RECOLOUR },
  })
}

export type Picked =
  | { layer: 'parcels'; parcel: Parcel }
  | { layer: 'buildings'; building: Building; conversion: ConversionCandidate | undefined }
  | { layer: 'sites'; site: SiteDatum }
  | { layer: 'new_buildings'; site: Site }
  | { layer: 'proposed_stops'; stop: Stop }
  | { layer: 'proposed_routes'; route: Route }
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
    case 'parcels': {
      const f = obj as Feat<ParcelDatum> // parcelsLayer data
      return { layer: 'parcels', parcel: f.properties.parcel }
    }
    case 'buildings': {
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
    case 'proposed_stops':
      return { layer: 'proposed_stops', stop: obj as Stop }
    case 'proposed_routes': {
      const f = obj as Feat<Route> // proposedTransitLayer route data
      return { layer: 'proposed_routes', route: f.properties }
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
