// Plan screen: what the map emphasises when an agent is picked in the agent list. Per agent, overlay layers built
// from the agents' suggestions (`state.plan`, applied or not), the map layers it speaks to (the rest fade), the box
// its contributions span (MapView eases the camera there) and a caption: what it found and what it unlocks in
// meeting mode. Pure: counts come straight from plan data, nothing here is a planning figure.
import { GeoJsonLayer, IconLayer, PolygonLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers'
import { PathStyleExtension } from '@deck.gl/extensions'
import type { Color, Layer } from '@deck.gl/core'
import { pointInRing, type BBox } from './geo'
import {
  edgesLayer,
  feature,
  FLAT,
  FT_TO_M,
  grownRing,
  INFRA_COLORS,
  INK,
  isProposedRoute,
  MATTE,
  pushEdges,
  routeColor,
  routeKey,
  siteLetters,
  storeyElevation,
  STRATEGY_COLORS,
  TEAL,
  USE_COLORS,
  withAlpha,
  type BuildingDatum,
  type EdgePath,
  type LayerKey,
  type TransitLine,
} from './mapLayers'
import { REDUCED_MOTION } from './construction'
import { fmtNum, geometryCentroid, haversineM, humanize } from './format'
import { validTargets } from './tools'
import { transitFleet, type VehicleLine } from './vehicles'
import { AGENT_LABELS, type AgentName, type DealKind, type Geometry, type InfraKind, type LonLat, type Plan, type Route, type Site, type Stop } from './types'

export interface FocusInput {
  /** The agents' suggestions. */
  plan: Partial<Plan>
  /** What the map shows: existing conditions + the user's edits. */
  current: Partial<Plan>
  /** The map's flattened buildings (footprints resolved), for shells over conversion candidates. */
  buildings: BuildingDatum[]
  storyHeightFt: number | null
  /** Feed lines by route key, for route colours. */
  lines: ReadonlyMap<string, TransitLine>
  /** The locale's bbox: contributions outside it (county-wide utility areas) do not pull the camera away. */
  frame: BBox | null
  /** A factor's number for the plan's locale (factors.yaml), null when absent or not loaded. */
  factor?: (key: string) => number | null
}

export interface FocusCaption {
  title: string
  summary: string
  /** Shown after "Unlocks:". */
  unlocks: string
}

export interface AgentFocus {
  /** Ground overlays, drawn over the ground layers and under the buildings. */
  layers: Layer[]
  /** Overlays that stand on or float over buildings (shells, labels), drawn last. */
  above: Layer[]
  /** Box the contributions span, or null to frame the whole locale. */
  bbox: BBox | null
  /** Map layers that stay at full strength; the rest fade. */
  emphasize: LayerKey[]
  caption: FocusCaption
  /** Moving ground overlays at clock `ms` (performance.now()), drawn with `layers`; absent when nothing moves
   *  (always with reduced motion, when `layers` carries the still version). */
  animate?: (ms: number) => Layer[]
}

// ---------------------------------------------------------------- geometry

function addCoords(box: BBox, c: unknown) {
  if (!Array.isArray(c)) return
  if (typeof c[0] === 'number' && typeof c[1] === 'number') {
    box[0] = Math.min(box[0], c[0])
    box[1] = Math.min(box[1], c[1])
    box[2] = Math.max(box[2], c[0])
    box[3] = Math.max(box[3], c[1])
    return
  }
  for (const x of c) addCoords(box, x)
}

function addGeometry(box: BBox, g: Geometry | null | undefined) {
  if (!g) return
  if (g.type === 'GeometryCollection') for (const s of g.geometries ?? []) addGeometry(box, s)
  else addCoords(box, g.coordinates)
}

/** The box, clipped to the frame; null when empty or wholly outside it. */
function finish(box: BBox, frame: BBox | null): BBox | null {
  const b: BBox = frame
    ? [Math.max(box[0], frame[0]), Math.max(box[1], frame[1]), Math.min(box[2], frame[2]), Math.min(box[3], frame[3])]
    : box
  return b[0] <= b[2] && b[1] <= b[3] && Number.isFinite(b[0]) ? b : null
}

function boxOf(geoms: (Geometry | null | undefined)[], frame: BBox | null): BBox | null {
  const box: BBox = [Infinity, Infinity, -Infinity, -Infinity]
  for (const g of geoms) addGeometry(box, g)
  return finish(box, frame)
}

/** A breathing halo: the layer's opacity swings gently (cheap: no attribute recompute). */
function breathing(layer: Layer, periodMs = 1600, low = 0.45) {
  return (ms: number) => [layer.clone({ opacity: low + (1 - low) * (0.5 + 0.5 * Math.sin((ms / periodMs) * 2 * Math.PI)) })]
}

// ---------------------------------------------------------------- shared pieces

const GREEN: Color = [46, 125, 91]
const RED: Color = [185, 58, 46]
const GREY: Color = [154, 160, 154]
const AMBER: Color = [227, 180, 72]
const SITE_FILL: Color = [169, 191, 231]
const PAPER: Color = [237, 239, 234, 255]

const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`

/** Site letters (pursued sites) over their footprints. */
function siteLabels(id: string, sites: Site[]) {
  const letters = siteLetters(sites)
  const data = sites
    .map((s) => ({ letter: letters.get(s.id), at: geometryCentroid(s.geometry) }))
    .filter((d): d is { letter: string; at: LonLat } => !!d.letter && !!d.at)
  return new TextLayer<{ letter: string; at: LonLat }>({
    id,
    parameters: FLAT,
    data,
    getPosition: (d) => d.at,
    getText: (d) => d.letter,
    getSize: 18,
    getColor: INK,
    fontWeight: 700,
    outlineWidth: 4,
    outlineColor: PAPER,
    fontSettings: { sdf: true },
    billboard: true,
    getPixelOffset: [0, -14],
  })
}

/** Site footprints in a per-site colour; `dashed` draws them as ghosts (not built yet). */
function siteFootprints(id: string, sites: Site[], color: (s: Site) => Color, dashed: boolean, fillAlpha = 110) {
  return new GeoJsonLayer<Site, { getDashArray?: unknown; dashJustified?: boolean }>({
    id,
    parameters: FLAT,
    data: sites.map((s) => feature(s.geometry, s)),
    filled: true,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2.5,
    getLineColor: (f) => withAlpha(color(f.properties), 255),
    getFillColor: (f) => withAlpha(color(f.properties), f.properties.status === 'pursue' ? fillAlpha : fillAlpha / 2),
    getDashArray: dashed ? [4, 2.5] : [0, 0],
    dashJustified: true,
    extensions: [new PathStyleExtension({ dash: true })],
  })
}

/** Lots a Homes tile can land on, as a faint green wash. */
function homesLots(id: string, plan: Partial<Plan>, homes: ReadonlySet<string>) {
  return new GeoJsonLayer({
    id,
    parameters: FLAT,
    data: (plan.parcels ?? []).filter((p) => homes.has(p.id)).map((p) => feature(p.geometry, p)),
    filled: true,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 1,
    getLineColor: withAlpha(GREEN, 150),
    getFillColor: withAlpha(GREEN, 45),
  })
}

const countBy = <T,>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1)
  return m
}

// ---------------------------------------------------------------- per agent

const AMENITY_KINDS: Partial<Record<InfraKind, true>> = {
  ev_charger: true,
  school: true,
  clinic: true,
  park: true,
  grocery: true,
  affordable_housing: true,
}
const UTILITY_KINDS: Partial<Record<InfraKind, true>> = { water_main: true, sewer_main: true, power_substation: true }

function infrastructure({ plan, frame }: FocusInput): AgentFocus {
  const infra = plan.infrastructure ?? []
  const amenities = infra.filter((f) => AMENITY_KINDS[f.kind])
  const utilities = infra.filter((f) => UTILITY_KINDS[f.kind])
  const walk = infra.filter((f) => f.kind === 'sidewalk' || f.kind === 'bike_lane')
  const points = amenities
    .map((f) => ({ at: geometryCentroid(f.geometry), c: INFRA_COLORS[f.kind] ?? GREY }))
    .filter((d): d is { at: LonLat; c: Color } => d.at !== null)
  const halo = new ScatterplotLayer<{ at: LonLat; c: Color }>({
    id: 'agent_amenity_halo',
    parameters: FLAT,
    data: points,
    getPosition: (d) => d.at,
    radiusUnits: 'pixels',
    getRadius: 11,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    getLineColor: (d) => withAlpha(d.c, 230),
    getFillColor: (d) => withAlpha(d.c, 50),
  })
  return {
    layers: REDUCED_MOTION ? [halo] : [],
    above: [],
    bbox: boxOf([...amenities, ...walk].map((f) => f.geometry), frame),
    emphasize: ['amenities', 'utilities', 'walk_bike'],
    caption: {
      title: AGENT_LABELS.infrastructure,
      summary: `${plural(amenities.length, 'amenity', 'amenities')} · ${plural(walk.length, 'sidewalk or bike segment', 'sidewalk and bike segments')} · ${plural(utilities.length, 'utility feature')} mapped`,
      unlocks: `Park tiles on ${plural((plan.parcels ?? []).length, 'lot')} in Meeting mode`,
    },
    animate: REDUCED_MOTION ? undefined : breathing(halo),
  }
}

function transitNetwork({ plan, current, lines, frame }: FocusInput): AgentFocus {
  const transit = plan.transit
  const proposed = (transit?.routes ?? []).filter(isProposedRoute)
  const stops = transit?.stops ?? []
  const shownRoutes = new Set((current.transit?.routes ?? []).map((r) => r.id))
  const shownStops = new Set((current.transit?.stops ?? []).map((s) => s.id))
  const ghostRoutes = proposed.filter((r) => !shownRoutes.has(r.id))
  const ghostStops = stops.filter((s) => !shownStops.has(s.id))
  const width = (r: Route) => (r.kind === 'brt' ? 8 : r.kind === 'on_demand_zone' ? 2 : 4.5)
  const data = ghostRoutes.map((r) => feature(r.geometry, { r, c: routeColor(r, lines) }))
  const layers: Layer[] = [
    new GeoJsonLayer<{ r: Route; c: Color }>({
      id: 'agent_ghost_casing',
      parameters: FLAT,
      data,
      filled: false,
      lineWidthUnits: 'pixels',
      lineCapRounded: true,
      lineJointRounded: true,
      getLineWidth: (f) => width(f.properties.r) + 3,
      getLineColor: [255, 255, 255, 170],
    }),
    new GeoJsonLayer<{ r: Route; c: Color }, { getDashArray?: unknown; dashJustified?: boolean }>({
      id: 'agent_ghost_routes',
      parameters: FLAT,
      data,
      filled: true,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (f) => width(f.properties.r),
      getLineColor: (f) => withAlpha(f.properties.c, 210),
      getFillColor: (f) => withAlpha(f.properties.c, 22),
      getDashArray: [3, 2],
      dashJustified: true,
      extensions: [new PathStyleExtension({ dash: true })],
    }),
    new ScatterplotLayer<Stop>({
      id: 'agent_ghost_stops',
      parameters: FLAT,
      data: ghostStops,
      getPosition: (s) => s.lonlat,
      radiusUnits: 'meters',
      getRadius: 8,
      radiusMinPixels: 3,
      radiusMaxPixels: 9,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: TEAL,
      getFillColor: [255, 255, 255, 210],
    }),
  ]
  // vehicles on every feed line and on the plan's new service (see-through where it is not on the map yet)
  const services = [...new Map([...proposed, ...(current.transit?.routes ?? []).filter(isProposedRoute)].map((r) => [r.id, r])).values()]
  const vehicleLines: VehicleLine[] = [
    ...[...lines.values()].map((l) => ({ ...l, ghost: false })),
    ...services
      .filter((r) => r.kind !== 'on_demand_zone')
      .map((r) => ({
        key: r.id,
        mode: 'bus' as const,
        geometry: r.geometry,
        color: routeColor(r, lines),
        headwayMin: r.headway_min,
        ghost: !shownRoutes.has(r.id),
      })),
  ]
  const fleet = transitFleet('agent_vehicles', vehicleLines, frame)
  const keys = new Set(proposed.map((r) => routeKey(r.id)))
  const coverage = transit
    ? ` · coverage ${fmtNum(transit.coverage_baseline_pct, 1)}% → ${fmtNum(transit.coverage_pct, 1)}%`
    : ''
  return {
    layers: REDUCED_MOTION && fleet ? [...layers, ...fleet.at(0)] : layers,
    above: [],
    bbox: boxOf([...proposed.map((r) => r.geometry), ...stops.map((s) => ({ type: 'Point', coordinates: s.lonlat }))], frame),
    emphasize: ['transit_existing', 'proposed_transit'],
    caption: {
      title: AGENT_LABELS.transit_network,
      summary: `${plural(keys.size, 'new or upgraded route')} · ${plural(stops.length, 'stop')}${coverage}`,
      unlocks: `Stop tiles on ${plural(validTargets(plan, 'stop').size, 'lot')} in Meeting mode`,
    },
    animate: REDUCED_MOTION || !fleet ? undefined : fleet.at,
  }
}

type EnvelopeClass = 'eligible' | 'ineligible' | 'uncovered'
const ENVELOPE_COLORS: Record<EnvelopeClass, Color> = { eligible: GREEN, ineligible: RED, uncovered: GREY }

function zoning({ plan, frame }: FocusInput): AgentFocus {
  const parcels = new Map((plan.parcels ?? []).map((p) => [p.id, p]))
  const rows = (plan.envelopes ?? []).flatMap((e) => {
    const p = parcels.get(e.parcel_id)
    if (!p) return []
    const cls: EnvelopeClass = !e.covered ? 'uncovered' : e.paths.some((x) => x.eligible === true) ? 'eligible' : 'ineligible'
    return [{ geometry: p.geometry, cls }]
  })
  const n = countBy(rows, (r) => r.cls)
  const homes = validTargets(plan, 'homes').size
  return {
    layers: [
      new GeoJsonLayer<{ cls: EnvelopeClass }>({
        id: 'agent_envelopes',
        parameters: FLAT,
        data: rows.map((r) => feature(r.geometry, { cls: r.cls })),
        filled: true,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1.2,
        getLineColor: (f) => withAlpha(ENVELOPE_COLORS[f.properties.cls], 220),
        getFillColor: (f) => withAlpha(ENVELOPE_COLORS[f.properties.cls], f.properties.cls === 'uncovered' ? 60 : 115),
      }),
    ],
    above: [],
    bbox: boxOf(rows.filter((r) => r.cls !== 'uncovered').map((r) => r.geometry), frame),
    emphasize: ['parcels'],
    caption: {
      title: AGENT_LABELS.zoning_legislation,
      summary: `${plural(n.get('eligible') ?? 0, 'lot')} with an eligible legal path · ${fmtNum(n.get('ineligible') ?? 0)} without · ${fmtNum(n.get('uncovered') ?? 0)} not covered`,
      unlocks: `Homes tiles on ${plural(homes, 'eligible lot')} in Meeting mode`,
    },
  }
}

function site({ plan, frame }: FocusInput): AgentFocus {
  const sites = (plan.sites ?? []).filter((s) => s.status !== 'pass')
  const homes = validTargets(plan, 'homes')
  const n = countBy(sites, (s) => s.status)
  return {
    layers: [homesLots('agent_homes_lots', plan, homes), siteFootprints('agent_site_ghosts', sites, () => SITE_FILL, true)],
    above: [siteLabels('agent_site_labels', sites)],
    bbox: boxOf(sites.map((s) => s.geometry), frame),
    emphasize: ['sites', 'new_buildings'],
    caption: {
      title: AGENT_LABELS.site,
      summary: `${plural(n.get('pursue') ?? 0, 'site')} to pursue · ${fmtNum(n.get('watch') ?? 0)} on watch · ${fmtNum(n.get('reserve') ?? 0)} in reserve`,
      unlocks: `Homes tiles on ${plural(homes.size, 'lot')} · Apply agent suggestions builds these sites`,
    },
  }
}

const HALO_GROW = 1.3
const SHELL_GROW = 1.04
const SHELL_LIFT_M = 0.8

function buildingReuse({ plan, buildings, storyHeightFt, frame }: FocusInput): AgentFocus {
  const cands = (plan.conversions ?? []).filter((c) => c.best_use !== 'keep_current')
  const useOf = new Map(cands.map((c) => [c.building_id, c.best_use]))
  const glow = buildings.filter((d) => useOf.has(d.building.id))
  const color = (d: BuildingDatum) => USE_COLORS[useOf.get(d.building.id)!]
  const halo = new PolygonLayer<BuildingDatum>({
    id: 'agent_reuse_halo',
    parameters: FLAT,
    data: glow,
    filled: true,
    stroked: false,
    getPolygon: (d) => grownRing(d.polygon, HALO_GROW),
    getFillColor: (d) => withAlpha(color(d), 90),
  })
  const shells = glow.map((d) => ({ d, ring: grownRing(d.polygon, SHELL_GROW) }))
  const top = (s: (typeof shells)[number]) => (storyHeightFt !== null ? storeyElevation(s.d.building, storyHeightFt) + SHELL_LIFT_M : 0)
  const shell = new PolygonLayer<(typeof shells)[number]>({
    id: 'agent_reuse_shells',
    data: shells,
    extruded: storyHeightFt !== null,
    filled: true,
    material: MATTE,
    getPolygon: (s) => s.ring,
    getElevation: top,
    getFillColor: (s) => withAlpha(color(s.d), 170),
  })
  const edges: EdgePath<BuildingDatum>[] = []
  for (const s of shells) pushEdges(edges, s.d, [s.ring], top(s))
  const shellEdges = edgesLayer('agent_reuse_shell_edges', edges, (d) => withAlpha(color(d), 255))
  const n = countBy(cands, (c) => c.best_use)
  const byUse = [...n].map(([u, k]) => `${fmtNum(k)} ${humanize(u)}`).join(' · ')
  return {
    layers: REDUCED_MOTION ? [halo] : [],
    above: [shell, shellEdges],
    bbox: boxOf(glow.map((d) => d.building.footprint), frame),
    // every other building fades: the shells over the candidates carry the emphasis
    emphasize: [],
    caption: {
      title: AGENT_LABELS.building_reuse,
      summary: `${plural((plan.conversions ?? []).length, 'building')} screened · ${fmtNum(cands.length)} with a better use${byUse ? `: ${byUse}` : ''}`,
      unlocks: `Convert to housing (${fmtNum(validTargets(plan, 'convert_residential').size)}) · Convert to hotel (${fmtNum(validTargets(plan, 'convert_hotel').size)}) in Meeting mode`,
    },
    animate: REDUCED_MOTION ? undefined : breathing(halo, 1400, 0.35),
  }
}

function landDeal({ plan, frame }: FocusInput): AgentFocus {
  const strategy = new Map<string, DealKind>((plan.deals ?? []).map((d) => [d.site_id, d.strategy]))
  const sites = (plan.sites ?? []).filter((s) => strategy.has(s.id))
  const n = countBy(sites, (s) => strategy.get(s.id)!)
  return {
    layers: [siteFootprints('agent_deal_sites', sites, (s) => STRATEGY_COLORS[strategy.get(s.id)!], false, 120)],
    above: [siteLabels('agent_deal_labels', sites)],
    bbox: boxOf(sites.map((s) => s.geometry), frame),
    emphasize: ['sites', 'new_buildings'],
    caption: {
      title: AGENT_LABELS.land_deal,
      summary: [...n].map(([k, v]) => `${fmtNum(v)} ${humanize(k)}`).join(' · ') || 'No deals yet',
      unlocks: 'Apply agent suggestions starts these deals · each Homes tile gets its own deal in Meeting mode',
    },
  }
}

function funding({ plan, frame }: FocusInput): AgentFocus {
  const pencils = new Map((plan.stacks ?? []).map((x) => [x.site_id, x.pencils]))
  const sites = (plan.sites ?? []).filter((s) => pencils.has(s.id))
  const ok = sites.filter((s) => pencils.get(s.id)).length
  return {
    layers: [siteFootprints('agent_funding_sites', sites, (s) => (pencils.get(s.id) ? GREEN : AMBER), false, 120)],
    above: [siteLabels('agent_funding_labels', sites)],
    bbox: boxOf(sites.map((s) => s.geometry), frame),
    emphasize: ['sites', 'new_buildings'],
    caption: {
      title: AGENT_LABELS.funding,
      summary: `${plural(ok, 'capital stack')} pencil · ${fmtNum(sites.length - ok)} need outside funding`,
      unlocks: 'Apply agent suggestions funds these sites · each Homes tile gets its own capital stack in Meeting mode',
    },
  }
}

// ---------------------------------------------------------------- sustainability: solar roofs, walk sheds, leaves
// Drawing only: where the plan's roofs, walks and carbon savings are. Tile sizes and timings are layout, not figures;
// every number shown is a target from the plan (backend/models/targets.py).

const M_PER_DEG = 111_320 // unit conversion, not a planning factor
const SOLAR_DARK: Color = [27, 48, 104]
const SOLAR_LIGHT: Color = [54, 90, 166]
const SOLAR_GLINT: Color = [216, 234, 255]
const NEW_BUILD_GHOST: Color = [169, 191, 231]
/** A roof gets at most this many panels (a big roof gets bigger tiles, not more), the map at most MAX_PANELS. */
const PANELS_PER_ROOF = 40
const MAX_PANELS = 900
const PANEL_L_M = 3.4 // along the roof's long side
const PANEL_W_M = 2.2 // up the tilt
const PANEL_GAP_M = 0.6
const ROW_GAP_M = 1.2
const ROOF_INSET_M = 1.2
const PANEL_LIFT_M = 0.6
const PANEL_TILT = 0.3 // rise per metre up the panel
const SHIMMER_MS = 3600
const SHIMMER_BAND = 0.16
const SHED_MS = 5200
const LEAF_MS = 5600
const LEAF_RISE_M = 36
const LEAF_PX = 18
const MAX_SHED_SITES = 6
const MAX_LEAF_SITES = 8
const LEAVES_PER_SITE = 3
/** Frames per second the per-panel colours are recomputed at (the sweep is slow; 60 would only cost). */
const SHIMMER_FPS = 24

interface RoofPanel {
  poly: [number, number, number][]
  /** 0: the lower strip of the panel, 1: the upper (the two tones read as tilt). */
  tone: 0 | 1
  /** Position along the shimmer sweep, 0..1 across all panels. */
  s: number
}

const mixColor = (a: Color, b: Color, t: number): Color => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

/** Rows of panels on one roof ring (lon/lat) at `z` m, aligned to its longest side and inset from its edges. */
function roofPanels(out: RoofPanel[], ring: number[][], z: number, cap: number) {
  if (ring.length < 4 || cap <= 0) return
  const [lon0, lat0] = ring[0]
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180)
  const pts = ring.map(([x, y]) => [(x - lon0) * kx, (y - lat0) * M_PER_DEG] as [number, number])
  let [ex, ey, longest, area] = [1, 0, 0, 0]
  for (let i = 0; i + 1 < pts.length; i++) {
    const [dx, dy] = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]]
    const l = Math.hypot(dx, dy)
    if (l > longest) [ex, ey, longest] = [dx / l, dy / l, l]
    area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
  }
  area = Math.abs(area) / 2
  const [nx, ny] = [-ey, ex]
  const k = Math.max(1, Math.sqrt(area / (PANELS_PER_ROOF * (PANEL_L_M + PANEL_GAP_M) * (PANEL_W_M + ROW_GAP_M))))
  const [L, W, gu, gv] = [PANEL_L_M * k, PANEL_W_M * k, PANEL_GAP_M * k, ROW_GAP_M * k]
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity]
  for (const [x, y] of pts) {
    const [u, v] = [x * ex + y * ey, x * nx + y * ny]
    ;[u0, u1, v0, v1] = [Math.min(u0, u), Math.max(u1, u), Math.min(v0, v), Math.max(v1, v)]
  }
  const m = ROOF_INSET_M
  const nu = Math.floor((u1 - u0 - 2 * m + gu) / (L + gu))
  const nv = Math.floor((v1 - v0 - 2 * m + gv) / (W + gv))
  if (nu < 1 || nv < 1) return
  // the grid centred on the roof's box; tiles whose inset rectangle leaves the outline are skipped
  const su = u0 + (u1 - u0 - (nu * (L + gu) - gu)) / 2
  const sv = v0 + (v1 - v0 - (nv * (W + gv) - gv)) / 2
  const local = (u: number, v: number): [number, number] => [u * ex + v * nx, u * ey + v * ny]
  const lonlat = (u: number, v: number, h: number): [number, number, number] => {
    const [x, y] = local(u, v)
    return [lon0 + x / kx, lat0 + y / M_PER_DEG, h]
  }
  let n = 0
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      if (n >= cap) return
      const [u, v] = [su + iu * (L + gu), sv + iv * (W + gv)]
      const corners: [number, number][] = [[u - m, v - m], [u + L + m, v - m], [u + L + m, v + W + m], [u - m, v + W + m]]
      if (!corners.every(([a, b]) => pointInRing(local(a, b), pts))) continue
      for (const tone of [0, 1] as const) {
        const [a, b] = [v + (tone * W) / 2, v + ((tone + 1) * W) / 2]
        const [za, zb] = [z + PANEL_LIFT_M + (a - v) * PANEL_TILT, z + PANEL_LIFT_M + (b - v) * PANEL_TILT]
        out.push({ poly: [lonlat(u, a, za), lonlat(u + L, a, za), lonlat(u + L, b, zb), lonlat(u, b, zb)], tone, s: 0 })
      }
      n++
    }
  }
}

/** Outer rings of a Polygon/MultiPolygon. */
function outerRings(g: Geometry): number[][][] {
  if (g.type === 'Polygon') return [(g.coordinates as number[][][])[0]]
  if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).map((p) => p[0])
  return []
}

const LEAF_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
  '<path fill-rule="evenodd" fill="#fff" d="M8 56C8 26 28 8 58 6C58 36 40 56 8 56Z M13 52.5L44 21.5L45.5 23L14.5 54Z"/></svg>'
const LEAF_ICON = { id: 'leaf', url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(LEAF_SVG)}`, width: 64, height: 64, mask: true }

interface Shed {
  at: LonLat
  kind: 'frequent_stop' | 'park'
  /** Every site this stop or park is nearest to walks to its kind within the walk target. */
  met: boolean
}

interface Leaf {
  at: LonLat
  z: number
  phase: number
}

function sustainability({ plan, current, buildings, storyHeightFt, frame, factor }: FocusInput): AgentFocus {
  const inFlood = plan.precomputed?.in_flood ?? {}
  const walkM = plan.precomputed?.walk_m ?? {}
  const infra = plan.infrastructure ?? []
  const zones = infra.filter((f) => f.kind === 'flood_zone')
  const sites = (plan.sites ?? []).filter((s) => s.status !== 'pass')
  const flooded = sites.filter((s) => s.parcel_ids.some((p) => inFlood[p]))
  const target = (key: string) => plan.targets?.find((t) => t.key === key)
  const walk = target('walk_access')
  const co2 = target('transport_co2')
  const solar = target('rooftop_solar')
  // in plan = pursue or watch, as the targets count them (rescore.py in_plan, site_target)
  const inPlan = sites.filter((s) => s.status === 'pursue' || s.status === 'watch').sort((a, b) => b.homes - a.homes)
  const speed = factor?.('walk_speed_m_per_s') ?? null
  const minutes = factor?.('walk_minutes_target') ?? null
  const thr = speed !== null && minutes !== null ? speed * 60 * minutes : null
  const walks = (s: Site, kind: string) => {
    const d = walkM[s.kind === 'conversion' && s.building_id ? s.building_id : s.parcel_ids[0]]?.[kind]
    return thr !== null && d !== null && d !== undefined && d <= thr
  }

  // ---- rooftop solar: the roofs the rooftop_solar target counts (converted buildings, new builds' roofs)
  const byBuilding = new Map<string, BuildingDatum[]>()
  for (const d of buildings) byBuilding.set(d.building.id, [...(byBuilding.get(d.building.id) ?? []), d])
  const shown = new Set((current.sites ?? []).filter((s) => s.status !== 'pass').map((s) => s.id))
  const roofs: { ring: number[][]; z: number }[] = []
  const roofZ = new Map<string, number>()
  const ghosts: { ring: number[][]; h: number }[] = []
  for (const s of inPlan) {
    if (s.kind === 'conversion') {
      for (const d of (s.building_id && byBuilding.get(s.building_id)) || []) {
        const z = storeyElevation(d.building, storyHeightFt)
        roofs.push({ ring: d.polygon[0], z })
        roofZ.set(s.id, Math.max(roofZ.get(s.id) ?? 0, z))
      }
    } else {
      const h = s.height_ft * FT_TO_M
      for (const ring of outerRings(s.geometry)) {
        roofs.push({ ring, z: h })
        // a suggested building not on the map yet stands as a see-through block under its panels
        if (!shown.has(s.id)) ghosts.push({ ring, h })
      }
      roofZ.set(s.id, h)
    }
  }
  const panels: RoofPanel[] = []
  for (const r of roofs) roofPanels(panels, r.ring, r.z, Math.min(PANELS_PER_ROOF, MAX_PANELS - panels.length / 2))
  if (panels.length) {
    const kx = Math.cos((panels[0].poly[0][1] * Math.PI) / 180)
    const raw = panels.map((p) => p.poly[0][0] * kx + p.poly[0][1])
    const lo = Math.min(...raw)
    const span = Math.max(...raw) - lo || 1
    panels.forEach((p, i) => (p.s = (raw[i] - lo) / span))
  }
  const panelLayer = (sweep: number | null, tick: number) =>
    new SolidPolygonLayer<RoofPanel>({
      id: 'agent_solar_panels',
      data: panels,
      filled: true,
      extruded: false,
      getPolygon: (p) => p.poly,
      getFillColor: (p) => {
        const base = p.tone ? SOLAR_LIGHT : SOLAR_DARK
        if (sweep === null) return base
        const d = Math.abs(p.s - sweep) / SHIMMER_BAND
        return d >= 1 ? base : mixColor(base, SOLAR_GLINT, 0.8 * (1 - d) ** 2)
      },
      updateTriggers: { getFillColor: tick },
    })
  const ghostLayer = new PolygonLayer<{ ring: number[][]; h: number }>({
    id: 'agent_solar_ghosts',
    data: ghosts,
    extruded: true,
    filled: true,
    material: MATTE,
    getPolygon: (g) => g.ring,
    getElevation: (g) => g.h,
    getFillColor: withAlpha(NEW_BUILD_GHOST, 90),
  })

  // ---- walk sheds: the frequent stop and the park nearest each in-plan site, a walk-target ring around each
  const freqMax = factor?.('readiness_frequent_headway_max_min') ?? null
  const stops = infra
    .filter((f) => {
      if (f.kind !== 'bus_stop') return false
      const hw = f.attrs.peak_headway_min
      return f.attrs.rail === true || (freqMax !== null && typeof hw === 'number' && hw <= freqMax)
    })
    .map((f) => geometryCentroid(f.geometry))
    .filter((p): p is LonLat => p !== null)
  const parks = infra
    .filter((f) => f.kind === 'park')
    .map((f) => geometryCentroid(f.geometry))
    .filter((p): p is LonLat => p !== null)
  const sheds = new Map<string, Shed>()
  if (thr !== null) {
    for (const s of inPlan.slice(0, MAX_SHED_SITES)) {
      const c = geometryCentroid(s.geometry)
      if (!c) continue
      for (const [kind, pool] of [['frequent_stop', stops], ['park', parks]] as const) {
        let best: LonLat | null = null
        let bestD = Infinity
        for (const p of pool) {
          const d = haversineM(c, p)
          if (d < bestD) [best, bestD] = [p, d]
        }
        if (!best) continue
        const key = `${kind}:${best[0]},${best[1]}`
        sheds.set(key, { at: best, kind, met: (sheds.get(key)?.met ?? true) && walks(s, kind) })
      }
    }
  }
  const shedData = [...sheds.values()]
  const shedColor = (d: Shed) => (d.met ? GREEN : AMBER)
  const shedDisks = new ScatterplotLayer<Shed>({
    id: 'agent_walk_sheds',
    parameters: FLAT,
    data: shedData,
    getPosition: (d) => d.at,
    radiusUnits: 'meters',
    getRadius: thr ?? 0,
    filled: true,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 1.5,
    getLineColor: (d) => withAlpha(shedColor(d), 120),
    getFillColor: (d) => withAlpha(shedColor(d), 12),
  })
  const shedCentres = new ScatterplotLayer<Shed>({
    id: 'agent_walk_shed_centres',
    parameters: FLAT,
    data: shedData,
    getPosition: (d) => d.at,
    radiusUnits: 'pixels',
    getRadius: 5,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    getLineColor: [255, 255, 255, 230],
    getFillColor: (d) => (d.kind === 'park' ? (INFRA_COLORS.park ?? GREEN) : TEAL),
  })
  const ripples = ['agent_walk_ripple_a', 'agent_walk_ripple_b'].map(
    (id) =>
      new ScatterplotLayer<Shed>({
        id,
        parameters: FLAT,
        data: shedData,
        getPosition: (d) => d.at,
        radiusUnits: 'meters',
        getRadius: thr ?? 0,
        filled: false,
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 2.5,
        getLineColor: (d) => withAlpha(shedColor(d), 220),
      }),
  )

  // ---- leaves rising over the sites that save carbon: homes near frequent transit (transport CO2) or a conversion
  const conv = new Map((plan.conversions ?? []).map((c) => [c.building_id, c.best_use]))
  const leafSites = inPlan
    .filter((s) => walks(s, 'frequent_stop') || (s.kind === 'conversion' && !!s.building_id && (conv.get(s.building_id) ?? 'keep_current') !== 'keep_current'))
    .slice(0, MAX_LEAF_SITES)
  const leaves: Leaf[] = []
  leafSites.forEach((s, i) => {
    const at = geometryCentroid(s.geometry)
    if (!at) return
    for (let j = 0; j < LEAVES_PER_SITE; j++) leaves.push({ at, z: (roofZ.get(s.id) ?? 0) + 3, phase: (i * 0.37 + j / LEAVES_PER_SITE) % 1 })
  })
  const leafLayer = (ms: number | null) => {
    const t = (l: Leaf) => (ms === null ? 0.5 : (ms / LEAF_MS + l.phase) % 1)
    return new IconLayer<Leaf>({
      id: 'agent_leaves',
      data: leaves,
      getIcon: () => LEAF_ICON,
      getPosition: (l) => {
        const k = t(l)
        const sway = (Math.sin((k * 1.5 + l.phase) * 2 * Math.PI) * 4) / (M_PER_DEG * Math.cos((l.at[1] * Math.PI) / 180))
        return [l.at[0] + sway, l.at[1], l.z + k * LEAF_RISE_M]
      },
      // a leaf grows in and shrinks away rather than fading, so it never half-writes depth over the buildings behind
      getSize: (l) => LEAF_PX * Math.sin(Math.PI * t(l)),
      sizeUnits: 'pixels',
      getColor: [46, 125, 91, 235],
      billboard: true,
      updateTriggers: { getPosition: ms, getSize: ms },
    })
  }

  const parts = [
    `${plural(zones.length, 'flood zone')} · ${plural(flooded.length, 'suggested site')} in a flood zone`,
    co2 && `transport ${fmtNum(co2.value, 1)} ${co2.unit}`,
    solar && `rooftop solar ${fmtNum(solar.value, 1)} ${solar.unit}`,
    walk && `walk access ${fmtNum(walk.value, 1)} ${walk.unit}`,
  ].filter(Boolean)
  return {
    layers: [siteFootprints('agent_flood_sites', flooded, () => RED, false, 130), shedDisks, shedCentres],
    above: [ghostLayer, ...(REDUCED_MOTION ? [panelLayer(null, 0), leafLayer(null)] : [])],
    bbox: boxOf(
      inPlan.length || flooded.length ? [...inPlan, ...flooded].map((s) => s.geometry) : zones.map((f) => f.geometry),
      frame,
    ),
    emphasize: ['flood', 'walk_bike', 'amenities'],
    caption: {
      title: AGENT_LABELS.sustainability_health,
      summary: parts.join(' · '),
      unlocks: 'Homes tiles stay off flood-zone lots · Park tiles add walkable green space in Meeting mode',
    },
    animate: REDUCED_MOTION
      ? undefined
      : (ms) => {
          const tick = Math.floor((ms * SHIMMER_FPS) / 1000)
          const sweep = ((ms % SHIMMER_MS) / SHIMMER_MS) * (1 + 2 * SHIMMER_BAND) - SHIMMER_BAND
          const out: Layer[] = ripples.map((l, i) => {
            const k = (ms / SHED_MS + i / ripples.length) % 1
            return l.clone({ radiusScale: 0.08 + 0.92 * k, opacity: 0.9 * (1 - k) })
          })
          if (panels.length) out.push(panelLayer(sweep, tick))
          if (leaves.length) out.push(leafLayer((tick * 1000) / SHIMMER_FPS))
          return out
        },
  }
}

const BUILDERS: Record<Exclude<AgentName, 'coordinator'>, (i: FocusInput) => AgentFocus> = {
  infrastructure,
  transit_network: transitNetwork,
  zoning_legislation: zoning,
  site,
  building_reuse: buildingReuse,
  land_deal: landDeal,
  funding,
  sustainability_health: sustainability,
}

/** The agent's emphasis on the map; null for the coordinator (it has no layer of its own). */
export function agentFocus(agent: AgentName, input: FocusInput): AgentFocus | null {
  return agent === 'coordinator' ? null : BUILDERS[agent](input)
}
