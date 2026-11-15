// Plan screen: what the map emphasises when an agent is picked in the agent list. Per agent, overlay layers built
// from the agents' suggestions (`state.plan`, applied or not), the map layers it speaks to (the rest fade), the box
// its contributions span (MapView eases the camera there) and a caption: what it found and what it unlocks in
// meeting mode. Pure: counts come straight from plan data, nothing here is a planning figure.
import { GeoJsonLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { PathStyleExtension } from '@deck.gl/extensions'
import type { Color, Layer } from '@deck.gl/core'
import type { BBox } from './geo'
import {
  edgesLayer,
  feature,
  FLAT,
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
import { fmtNum, geometryCentroid, humanize } from './format'
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

// ---------------------------------------------------------------- sustainability: flood zones, in-plan sites in them
// Every number shown is a target from the plan (backend/models/targets.py).

function sustainability({ plan, frame }: FocusInput): AgentFocus {
  const inFlood = plan.precomputed?.in_flood ?? {}
  const zones = (plan.infrastructure ?? []).filter((f) => f.kind === 'flood_zone')
  const sites = (plan.sites ?? []).filter((s) => s.status !== 'pass')
  const flooded = sites.filter((s) => s.parcel_ids.some((p) => inFlood[p]))
  const target = (key: string) => plan.targets?.find((t) => t.key === key)
  const walk = target('walk_access')
  const co2 = target('transport_co2')
  const solar = target('rooftop_solar')
  const parts = [
    `${plural(zones.length, 'flood zone')} · ${plural(flooded.length, 'suggested site')} in a flood zone`,
    co2 && `transport ${fmtNum(co2.value, 1)} ${co2.unit}`,
    solar && `rooftop solar ${fmtNum(solar.value, 1)} ${solar.unit}`,
    walk && `walk access ${fmtNum(walk.value, 1)} ${walk.unit}`,
  ].filter(Boolean)
  return {
    layers: [siteFootprints('agent_flood_sites', flooded, () => RED, false, 130)],
    above: [],
    bbox: boxOf(flooded.length ? flooded.map((s) => s.geometry) : zones.map((f) => f.geometry), frame),
    emphasize: ['flood'],
    caption: {
      title: AGENT_LABELS.sustainability_health,
      summary: parts.join(' · '),
      unlocks: 'Homes tiles stay off flood-zone lots · Park tiles add walkable green space in Edit mode',
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
