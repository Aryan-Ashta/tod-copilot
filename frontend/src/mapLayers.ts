// deck.gl layer builders, in docs/06 order (bottom → top). Each builder is pure; MapView memoizes
// each one on the identity of its data so thousands of extrusions are not rebuilt on every render.
import { GeoJsonLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { PathStyleExtension } from '@deck.gl/extensions'
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
  { key: 'base_dark', label: 'Dark base map', group: 'Base', on: true },
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

export const UNDERUSED_LAND_USES: Record<string, true> = { surface_parking: true, vacant: true, retail_1story: true }

export const USE_COLORS: Record<UseType, Color> = {
  residential: [59, 130, 246],
  hotel: [168, 85, 247],
  mixed_use: [20, 184, 166],
  keep_current: [140, 140, 140],
}

export const STRATEGY_COLORS: Record<DealKind, Color> = {
  buy: [34, 197, 94],
  ground_lease: [234, 179, 8],
  joint_development: [59, 130, 246],
  owner_partnership: [236, 72, 153],
  pass: [115, 115, 115],
}

const INFRA_COLORS: Partial<Record<InfraKind, Color>> = {
  rail: [230, 57, 70],
  bus_route: [140, 140, 140],
  bus_stop: [160, 160, 160],
  sidewalk: [115, 115, 115],
  bike_lane: [163, 230, 53],
  water_main: [59, 130, 246],
  sewer_main: [180, 140, 90],
  power_substation: [250, 204, 21],
  ev_charger: [34, 211, 238],
  school: [250, 204, 21],
  clinic: [244, 63, 94],
  park: [34, 197, 94],
  grocery: [251, 146, 60],
}
const AMBER: Color = [245, 158, 11]
const FT_TO_M = 0.3048 // unit conversion, not a planning factor

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
      data: stations,
      visible,
      getPosition: (s) => s.lonlat,
      radiusUnits: 'pixels',
      getRadius: 7,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 3,
      getLineColor: [230, 57, 70],
      getFillColor: (s) => (s.mode === 'intercity_rail_planned' ? [10, 10, 10] : [255, 255, 255]),
      pickable: true,
    }),
  ]
}

export function walkBikeLayer(infra: InfraFeature[], visible: boolean) {
  const feats = infra.filter((f) => f.kind === 'sidewalk' || f.kind === 'bike_lane').map((f) => feature(f.geometry, f))
  return new GeoJsonLayer<InfraFeature>({
    id: 'walk_bike',
    data: feats,
    visible,
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    getLineColor: (f) => {
      const p = f.properties
      if (p.kind === 'sidewalk' && NO_SIDEWALK[String(p.attrs.sidewalk ?? '').toLowerCase()]) return AMBER
      return withAlpha(INFRA_COLORS[p.kind] ?? [115, 115, 115], 170)
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
    data: feats,
    visible,
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    getLineColor: (f) => withAlpha(INFRA_COLORS[f.properties.kind] ?? [150, 150, 150], 200),
    getFillColor: (f) => withAlpha(INFRA_COLORS[f.properties.kind] ?? [150, 150, 150], 200),
    pointRadiusUnits: 'pixels',
    getPointRadius: 4,
    getDashArray: [4, 3],
    dashJustified: true,
    extensions: [new PathStyleExtension({ dash: true })],
  })
}

export function amenitiesLayer(infra: InfraFeature[], added: InfraFeature[], visible: boolean) {
  const kinds: Partial<Record<InfraKind, true>> = { ev_charger: true, school: true, clinic: true, park: true, grocery: true }
  const feats = [...infra, ...added].filter((f) => kinds[f.kind]).map((f) => feature(f.geometry, f))
  return new GeoJsonLayer<InfraFeature>({
    id: 'amenities',
    data: feats,
    visible,
    stroked: true,
    filled: true,
    pickable: true,
    lineWidthUnits: 'pixels',
    getLineWidth: (f) => (f.properties.attrs.proposed ? 3 : 1),
    getLineColor: (f) => (f.properties.attrs.proposed ? [255, 255, 255] : INFRA_COLORS[f.properties.kind] ?? [200, 200, 200]),
    getFillColor: (f) => withAlpha(INFRA_COLORS[f.properties.kind] ?? [200, 200, 200], f.properties.attrs.proposed ? 170 : 90),
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
    data: feats,
    visible,
    filled: true,
    stroked: true,
    getFillColor: [37, 99, 235, 60],
    getLineColor: [96, 165, 250, 140],
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
      data: feats,
      visible,
      pickable: true,
      filled: true,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => (f.properties.kind === 'brt' ? 9 : f.properties.kind === 'on_demand_zone' ? 2 : 4),
      getLineColor: (f) =>
        f.properties.kind === 'brt' ? [16, 185, 129] : f.properties.kind === 'on_demand_zone' ? [168, 85, 247] : [20, 184, 166],
      getFillColor: [168, 85, 247, 40],
      getDashArray: (f: Feat<Route>) => (f.properties.kind === 'on_demand_zone' ? [6, 4] : [0, 0]),
      dashJustified: true,
      extensions: [new PathStyleExtension({ dash: true })],
    }),
    new ScatterplotLayer<Stop>({
      id: 'proposed_stops',
      data: stops,
      visible,
      pickable: true,
      getPosition: (s) => s.lonlat,
      radiusUnits: 'pixels',
      getRadius: (s) => (s.id === selectedStop ? 8 : s.route_ids.some((r) => proposedRouteIds.has(r)) ? 5 : 3),
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: [20, 184, 166],
      getFillColor: (s) => (s.id === selectedStop ? [255, 255, 255] : [10, 10, 10]),
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
    data: feats,
    visible,
    pickable: true,
    filled: true,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: (f) => (f.properties.parcel.id === selectedId ? 3 : 0.5),
    getLineColor: (f) => (f.properties.parcel.id === selectedId ? [255, 255, 255] : [255, 255, 255, 40]),
    getFillColor: (f) => (f.properties.underused ? withAlpha(AMBER, 130) : [255, 255, 255, 8]),
    updateTriggers: { getLineWidth: selectedId, getLineColor: selectedId },
  })
}

export interface BuildingDatum {
  building: Building
  conversion: ConversionCandidate | undefined
  polygon: number[][][]
}

function polygonsOf(g: Geometry): number[][][][] {
  if (g.type === 'Polygon') return [g.coordinates as number[][][]]
  if (g.type === 'MultiPolygon') return g.coordinates as number[][][][]
  return []
}

export function flattenBuildings(buildings: Building[], conversions: ConversionCandidate[]): BuildingDatum[] {
  const conv = new Map(conversions.map((c) => [c.building_id, c]))
  const out: BuildingDatum[] = []
  for (const b of buildings) {
    for (const polygon of polygonsOf(b.footprint)) out.push({ building: b, conversion: conv.get(b.id), polygon })
  }
  return out
}

/**
 * Existing buildings: grey; conversion candidates coloured by best use with opacity by overall score.
 * Extrusion height = stories × story_height_ft (factor); without the factor, buildings stay flat.
 */
export function buildingsLayer(data: BuildingDatum[], storyHeightFt: number | null, visible: boolean, selectedId?: string) {
  return new PolygonLayer<BuildingDatum>({
    id: 'buildings',
    data,
    visible,
    pickable: true,
    extruded: storyHeightFt !== null,
    wireframe: false,
    filled: true,
    stroked: true,
    lineWidthUnits: 'pixels',
    getPolygon: (d) => d.polygon,
    getElevation: (d) => (storyHeightFt !== null ? (d.building.stories.value ?? 0) * storyHeightFt * FT_TO_M : 0),
    getFillColor: (d) => {
      if (d.building.id === selectedId) return [255, 255, 255, 230]
      if (!d.conversion) return [90, 90, 90, 150]
      return withAlpha(USE_COLORS[d.conversion.best_use], Math.round(255 * Math.max(0.15, d.conversion.overall)))
    },
    getLineColor: [20, 20, 20, 200],
    getLineWidth: 0.5,
    updateTriggers: { getFillColor: selectedId, getElevation: storyHeightFt },
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
      getLineColor: (f) => (f.properties.strategy ? STRATEGY_COLORS[f.properties.strategy] : [255, 255, 255]),
    }),
    new TextLayer<SiteDatum>({
      id: 'site_labels',
      data: data.filter((d) => d.centroid),
      visible,
      getPosition: (d) => d.centroid as LonLat,
      getText: (d) => d.letter,
      getSize: 18,
      getColor: [255, 255, 255],
      fontWeight: 700,
      outlineWidth: 3,
      outlineColor: [0, 0, 0, 255],
      fontSettings: { sdf: true },
      billboard: true,
      getPixelOffset: [0, -14],
    }),
  ]
}

export function newBuildingsLayer(sites: Site[], visible: boolean) {
  const data = sites.filter((s) => s.kind === 'new_build' && s.status === 'pursue').map((s) => feature(s.geometry, s))
  return new GeoJsonLayer<Site>({
    id: 'new_buildings',
    data,
    visible,
    pickable: true,
    extruded: true,
    filled: true,
    getElevation: (f) => f.properties.height_ft * FT_TO_M,
    getFillColor: [96, 165, 250, 200],
    getLineColor: [191, 219, 254],
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
