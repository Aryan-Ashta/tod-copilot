import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject } from 'react'
import { Map as MlMap, NavigationControl, type IControl, type LayerSpecification, type MapMouseEvent, type StyleSpecification } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { AmbientLight, DirectionalLight, LightingEffect, MapView as DeckMapView, type Color, type Layer, type PickingInfo } from '@deck.gl/core'
import { GeoJsonLayer } from '@deck.gl/layers'
import { boundaryPoints, outerRing, pointInRing, type BBox } from '../geo'
import {
  buildDuration,
  CLEARED_MS,
  constructionLayer,
  fountainAt,
  fountainDropsLayer,
  parkDecorLayers,
  progress,
  REDUCED_MOTION,
  riseShare,
  STAGGER_MS,
  type Build,
} from '../construction'
import { usePlan, type PlanAction } from '../state/PlanContext'
import { useApp } from '../state/AppContext'
import {
  amenitiesLayer,
  buildingsLayer,
  demolitionLayer,
  feedStopsLayer,
  flattenBuildings,
  floodLayer,
  FT_TO_M,
  greenPlots,
  isProposedRoute,
  ISO_FOV_DEG,
  lawnLayer,
  lineLabel,
  newBuildingsLayer,
  parcelsLayer,
  selectedBuildingLayer,
  selectedParcelLayer,
  proposedTransitLayer,
  pursuedSites,
  routeKey,
  sitesLayer,
  stationsLayer,
  stopsLayer,
  TILE_COLORS,
  toolBuildingsLayer,
  toolParcelsLayer,
  transitExistingLayer,
  transitKeyColors,
  transitLines,
  utilitiesLayer,
  walkBikeLayer,
  decodePick,
  type LayerKey,
  type Picked,
  type TransitFocus,
} from '../mapLayers'
import { agentFocus } from '../agentFocus'
import { toolTarget, validTargets } from '../tools'
import { AGENTS } from '../types'
import type { Building, ConversionCandidate, DealKind, Geometry, InfraFeature, LonLat, Parcel, Route, Site, Station, Stop } from '../types'
import { buildingLabel, fmtNum, geometryCentroid, humanize, parcelLabel } from '../format'

export interface MapHandle {
  /** Pick the top object under a viewport (client) point, restricted to the given deck layer ids. */
  pick: (clientX: number, clientY: number, layerIds: string[]) => Picked | null
}

// The base: a pale paper map drawn from OpenFreeMap's keyless OpenMapTiles vectors, so it stays sharp at the plan
// zooms (16–18.5) and on HiDPI screens, where raster bases (Esri's canvas stops at z16; CARTO's rasters now need a
// key) were upscaled into blur. No labels, so no glyphs or sprites to fetch; only ground, water, buildings and
// streets in the iso figures' greys, under the deck layers. The TileJSON URL follows OpenFreeMap's planet releases.
// World_Imagery has real tiles to z19 downtown.
type LineWidth = NonNullable<Extract<LayerSpecification, { type: 'line' }>['paint']>['line-width']
type Expr = Extract<LineWidth, unknown[]>
// Street widths at z20 in CSS px by OpenMapTiles class (about 7.7 px per metre at z20 in Houston), halving per zoom
// level below so a street keeps its ground width.
const STREET_W20: Expr = ['match', ['get', 'class'], 'motorway', 180, ['trunk', 'primary'], 150, ['secondary', 'tertiary'], 120, 'minor', 90, 54]
const streets = (id: string, color: string, edgePx: number): LayerSpecification => ({
  id,
  type: 'line',
  source: 'base',
  'source-layer': 'transportation',
  // the area picker's country-wide view stays clear of a mesh of highways
  minzoom: 11,
  filter: [
    'all',
    ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'busway'], true, false],
    ['!=', ['get', 'brunnel'], 'tunnel'],
  ],
  layout: { 'line-cap': 'round', 'line-join': 'round' },
  paint: {
    'line-color': color,
    'line-width': ['interpolate', ['exponential', 2], ['zoom'], 12, ['+', edgePx / 2, ['/', STREET_W20, 256]], 20, ['+', edgePx, STREET_W20]],
  },
})
export const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    base: {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
      attribution:
        '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
    },
    aerial: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 19,
      attribution: 'Imagery © Esri',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#EDEFEA' } },
    {
      id: 'base_green',
      type: 'fill',
      source: 'base',
      'source-layer': 'park',
      paint: { 'fill-color': '#E1E7DE' },
    },
    {
      id: 'base_landcover',
      type: 'fill',
      source: 'base',
      'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['grass', 'wood', 'farmland'], true, false],
      paint: { 'fill-color': '#E1E7DE', 'fill-opacity': 0.8 },
    },
    {
      id: 'base_water',
      type: 'fill',
      source: 'base',
      'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': '#D3DDE0' },
    },
    {
      id: 'base_waterway',
      type: 'line',
      source: 'base',
      'source-layer': 'waterway',
      paint: { 'line-color': '#D3DDE0', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.75, 20, 12] },
    },
    {
      id: 'base_buildings',
      type: 'fill',
      source: 'base',
      'source-layer': 'building',
      minzoom: 14,
      paint: { 'fill-color': '#E3E5E0', 'fill-outline-color': '#D6D9D3' },
    },
    streets('base_street_edges', '#D6D9D3', 3),
    streets('base_streets', '#F8F8F5', 0),
    {
      id: 'base_rail',
      type: 'line',
      source: 'base',
      'source-layer': 'transportation',
      minzoom: 13,
      filter: ['all', ['match', ['get', 'class'], ['rail', 'transit'], true, false], ['!=', ['get', 'brunnel'], 'tunnel']],
      paint: { 'line-color': '#C9CEC6', 'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 0.75, 20, 4] },
    },
    { id: 'aerial', type: 'raster', source: 'aerial', layout: { visibility: 'none' } },
  ],
}
/** The base map's own layers: the Base map layer toggle shows and hides them together. */
const BASE_LAYER_IDS = BASE_STYLE.layers.filter((l) => l.id.startsWith('base_')).map((l) => l.id)

// The iso look on a real map: looking north-west from 60° pitch (the 2:1 figures' 30° ground angle) with a narrow
// field of view (mapLayers ISO_FOV_DEG) so verticals stay close to parallel. MapLibre has no orthographic camera;
// 10° is near enough.
export const ISO_CAMERA = { bearing: -45, pitch: 60 }
const FIT_MAX_POINTS = 400 // boundary vertices projected per fit step; plenty to bound a walk-shed outline

/** Pixels of the map covered by overlay panels on each side; the plan is framed in the rest. */
export interface MapInsets {
  top: number
  right: number
  bottom: number
  left: number
}
const NO_INSETS: MapInsets = { top: 24, right: 24, bottom: 24, left: 24 }

/** Points to frame: the drawn boundary's vertices (thinned), else the locale's bbox corners. */
function outlinePoints(g: Geometry | null | undefined, bbox: BBox): [number, number][] {
  const pts = g ? boundaryPoints(g) : []
  if (!pts.length) {
    const [a, b, c, d] = bbox
    return [[a, b], [c, b], [c, d], [a, d]]
  }
  const step = Math.ceil(pts.length / FIT_MAX_POINTS)
  return step > 1 ? pts.filter((_, i) => i % step === 0) : pts
}

/**
 * Frame `pts` in the iso camera inside the part of the map the panels leave free. cameraForBounds fits a top-down
 * view; at 60° pitch the far half compresses and the frame centre drifts, so start there and correct zoom and centre
 * from the projected extent until it fills the free rectangle (a few steps converge).
 */
function fitIso(map: MlMap, pts: [number, number][], insets: MapInsets, bearing = ISO_CAMERA.bearing, maxZoom = Infinity) {
  const { clientWidth: w, clientHeight: h } = map.getContainer()
  const fw = w - insets.left - insets.right
  const fh = h - insets.top - insets.bottom
  if (fw <= 0 || fh <= 0) return
  const lons = pts.map((p) => p[0])
  const lats = pts.map((p) => p[1])
  const cam = map.cameraForBounds(
    [
      [Math.min(...lons), Math.min(...lats)],
      [Math.max(...lons), Math.max(...lats)],
    ],
    { bearing },
  )
  if (!cam) return
  map.jumpTo({ ...cam, pitch: ISO_CAMERA.pitch, bearing })
  const extent = () => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const p of pts) {
      const s = map.project(p)
      x0 = Math.min(x0, s.x)
      y0 = Math.min(y0, s.y)
      x1 = Math.max(x1, s.x)
      y1 = Math.max(y1, s.y)
    }
    return { x0, y0, x1, y1 }
  }
  for (let i = 0; i < 5; i++) {
    let e = extent()
    const scale = Math.min(fw / Math.max(e.x1 - e.x0, 1), fh / Math.max(e.y1 - e.y0, 1))
    map.jumpTo({ zoom: Math.min(maxZoom, map.getZoom() + Math.log2(scale)) })
    e = extent()
    const from = map.unproject([(e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2])
    const to = map.unproject([insets.left + fw / 2, insets.top + fh / 2])
    const c = map.getCenter()
    map.jumpTo({ center: [c.lng + from.lng - to.lng, c.lat + from.lat - to.lat] })
  }
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
// Agent emphasis: the camera eases this long, never closer than FOCUS_MAX_ZOOM (one building would fill the map),
// with this much more margin than the panels need, and nudged off the iso bearing so the shift reads as intentional.
const FOCUS_EASE_MS = 1200
const FOCUS_MAX_ZOOM = 17.5
const FOCUS_MARGIN_PX = 24
const FOCUS_BEARING_NUDGE_DEG = 6

/**
 * Ease the iso camera to frame `pts`: fitIso finds the target on the live map (synchronous jumps, never painted),
 * the map jumps back and eases there.
 */
function easeIso(map: MlMap, pts: [number, number][], insets: MapInsets, bearing: number, maxZoom = Infinity) {
  const camera = () => ({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() })
  map.stop()
  const from = camera()
  fitIso(map, pts, insets, bearing, maxZoom)
  const to = camera()
  map.jumpTo(from)
  map.easeTo({ ...to, duration: REDUCED_MOTION ? 0 : FOCUS_EASE_MS, easing: easeInOutCubic })
}

// One key light from the south-south-west and above: tops lightest, south faces (screen-left) mid, east faces
// (screen-right) darkest, as in the iso figures.
const LIGHTING = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.0 }),
  key: new DirectionalLight({ color: [255, 255, 255], intensity: 0.9, direction: [0.35, 1, -2.2] }),
})

const NO_INFRA: InfraFeature[] = []
const NO_STATIONS: Station[] = []
const NO_ROUTES: Route[] = []
const NO_STOPS: Stop[] = []
const NO_PARCELS: Parcel[] = []
const NO_BUILDINGS: Building[] = []
const NO_CONV: ConversionCandidate[] = []
const NO_SITES: Site[] = []

// ---------------------------------------------------------------- layer fades
// Layers fade per group: an armed tile dims ordinary parcels and buildings, an agent's emphasis dims the layers it
// does not speak to; its overlays ('agent') and the tile's targets ('tool') fade in. Opacity is a uniform, so a fade
// clones the memoized layers with a new opacity each frame and never recomputes their attributes.
type FadeGroup = LayerKey | 'tool' | 'agent'
const FADE_GROUPS: FadeGroup[] = [
  'walk_bike',
  'utilities',
  'amenities',
  'flood',
  'parcels',
  'transit_existing',
  'proposed_transit',
  'buildings',
  'sites',
  'new_buildings',
  'tool',
  'agent',
]
type Fades = Record<FadeGroup, number>
const REST: Fades = Object.fromEntries(FADE_GROUPS.map((g) => [g, g === 'tool' || g === 'agent' ? 0 : 1])) as Fades
const FADE_MS = REDUCED_MOTION ? 0 : 400
/** The green-space slider: buildings and lawns ease to a new share over this long; the planting fades in over the
 *  part of it after DECOR_FADE_FROM. */
const GREEN_MS = 700
const DECOR_FADE_FROM = 0.55
/** Opacity of the layers an agent's emphasis leaves out. */
const FOCUS_DIM = 0.15
/** Opacity of everything that is not a target while a parcel or a building tile is armed: the targets must stand out
 *  even when nearly every lot is one. */
const TOOL_DIM: Record<'parcel' | 'building', Partial<Record<FadeGroup, number>>> = {
  parcel: {
    parcels: 0.15,
    buildings: 0.3,
    sites: 0.4,
    new_buildings: 0.4,
    transit_existing: 0.25,
    proposed_transit: 0.25,
    walk_bike: 0.25,
    utilities: 0.2,
    amenities: 0.35,
    flood: 0.35,
  },
  building: {
    parcels: 0.15,
    buildings: 0.22,
    sites: 0.35,
    new_buildings: 0.35,
    transit_existing: 0.25,
    proposed_transit: 0.25,
    walk_bike: 0.25,
    utilities: 0.2,
    amenities: 0.35,
    flood: 0.35,
  },
}
const TOOL_LAYER_ID = { parcel: 'tool_parcels', building: 'tool_buildings' } as const
/** An armed tile's targets breathe between these opacities, once per PULSE_MS. */
const PULSE_MS = 1100
const PULSE_LOW = 0.55
/** Finished parks' fountains play on at about 30 fps: their droplets read as moving water without a full-rate loop. */
const SPRAY_FRAME_MS = 33
/** The animation loop gives up on the pulse (targets stay lit, still) after this many frames in a row slower than
 *  SLOW_FRAME_MS: every frame redraws the whole map, which a software-rendered or weak GPU cannot afford. Fades end
 *  on their own either way. */
const SLOW_FRAME_MS = 100
const SLOW_FRAMES = 3

// ---------------------------------------------------------------- placement pings
const PING_MS = 720
const PING_PX = 96

interface Ping {
  id: number
  /** Map-container pixels. */
  x: number
  y: number
  ok: boolean
  /** CSS colour of the tile placed. */
  color: string
  /** Degrees: each spark lands at its own slight angle. */
  rot: number
}

const cssColor = (c: Color) => `rgb(${c[0]} ${c[1]} ${c[2]})`
const SPARK_DIRS = [0, 72, 144, 216, 288]

/**
 * A placed tile's 'ping': two rings ripple out, a four-point star pops (overshoot, then settle) at a slight random
 * angle and five sparks fly off. A miss: a small red ring that shakes its head. Reduced motion: the marks only show
 * and fade. `onDone` once every part has finished (not on a timer, so a busy frame never cuts the ping short).
 */
function PlacePing({ ping, onDone }: { ping: Ping; onDone: (id: number) => void }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    const anims: Animation[] = []
    const run = (sel: string, frames: Keyframe[], opts: KeyframeAnimationOptions) =>
      svg.querySelectorAll<SVGElement>(sel).forEach((el) => anims.push(el.animate(frames, { fill: 'both', ...opts })))
    if (REDUCED_MOTION) {
      anims.push(svg.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: PING_MS, fill: 'both' }))
    } else if (ping.ok) {
      const ripple = [
        { transform: 'scale(0.15)', opacity: 0.95 },
        { transform: 'scale(1)', opacity: 0 },
      ]
      run('.r1', ripple, { duration: 560, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' })
      run('.r2', ripple, { duration: 560, delay: 140, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' })
      const r = ping.rot
      run(
        '.star',
        [
          { transform: `rotate(${r - 45}deg) scale(0)`, opacity: 1 },
          { transform: `rotate(${r + 6}deg) scale(1.3)`, opacity: 1, offset: 0.38 },
          { transform: `rotate(${r}deg) scale(1)`, opacity: 1, offset: 0.62 },
          { transform: `rotate(${r + 8}deg) scale(0.85)`, opacity: 0 },
        ],
        { duration: PING_MS, easing: 'ease-out' },
      )
      svg.querySelectorAll<SVGElement>('.spark').forEach((el, i) => {
        const a = ((SPARK_DIRS[i] + r) * Math.PI) / 180
        const [dx, dy] = [Math.cos(a) * 30, Math.sin(a) * 30]
        anims.push(
          el.animate(
            [
              { transform: 'translate(0px, 0px) scale(0.4)', opacity: 0 },
              { transform: `translate(${dx * 0.5}px, ${dy * 0.5}px) scale(1)`, opacity: 1, offset: 0.35 },
              { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 },
            ],
            { duration: 560, delay: 90, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'both' },
          ),
        )
      })
    } else {
      run(
        '.nope',
        [
          { transform: 'translateX(0) scale(0.5)', opacity: 0 },
          { transform: 'translateX(-5px) scale(1.05)', opacity: 1, offset: 0.2 },
          { transform: 'translateX(5px) scale(1)', opacity: 1, offset: 0.38 },
          { transform: 'translateX(-3px) scale(1)', opacity: 1, offset: 0.54 },
          { transform: 'translateX(0) scale(1)', opacity: 1, offset: 0.7 },
          { transform: 'translateX(0) scale(0.9)', opacity: 0 },
        ],
        { duration: 560, easing: 'ease-out' },
      )
    }
    let live = true
    Promise.all(anims.map((a) => a.finished)).then(
      () => live && onDone(ping.id),
      () => {}, // cancelled on unmount
    )
    return () => {
      live = false
      anims.forEach((a) => a.cancel())
    }
  }, [ping, onDone])
  const box = { transformBox: 'fill-box', transformOrigin: 'center' } as const
  const c = PING_PX / 2
  return (
    <svg
      ref={ref}
      width={PING_PX}
      height={PING_PX}
      viewBox={`0 0 ${PING_PX} ${PING_PX}`}
      className="pointer-events-none absolute z-20 overflow-visible"
      style={{ left: ping.x - c, top: ping.y - c }}
      aria-hidden
    >
      {ping.ok ? (
        <>
          <circle className="r1" cx={c} cy={c} r={40} fill="none" stroke="#1c2230" strokeWidth={2} style={box} />
          <circle className="r2" cx={c} cy={c} r={40} fill="none" stroke={ping.color} strokeWidth={3} style={box} />
          {SPARK_DIRS.map((d) => (
            <circle key={d} className="spark" cx={c} cy={c} r={2.5} fill={d % 144 === 0 ? '#e3b448' : ping.color} style={box} />
          ))}
          <path
            className="star"
            d={`M${c} ${c - 15}C${c + 2} ${c - 4} ${c + 4} ${c - 2} ${c + 15} ${c}C${c + 4} ${c + 2} ${c + 2} ${c + 4} ${c} ${c + 15}C${c - 2} ${c + 4} ${c - 4} ${c + 2} ${c - 15} ${c}C${c - 4} ${c - 2} ${c - 2} ${c - 4} ${c} ${c - 15}Z`}
            fill="#e3b448"
            stroke="#1c2230"
            strokeWidth={1.5}
            strokeLinejoin="round"
            style={box}
          />
        </>
      ) : (
        <g className="nope" style={box}>
          <circle cx={c} cy={c} r={13} fill="rgb(185 58 46 / 0.12)" stroke="#b93a2e" strokeWidth={2.5} />
          <path d={`M${c - 4.5} ${c - 4.5}L${c + 4.5} ${c + 4.5}M${c + 4.5} ${c - 4.5}L${c - 4.5} ${c + 4.5}`} stroke="#b93a2e" strokeWidth={2.5} strokeLinecap="round" />
        </g>
      )}
    </svg>
  )
}

function tooltipFor(info: PickingInfo): string | null {
  const p = decodePick(info)
  if (!p) return null
  switch (p.layer) {
    case 'parcels':
      return `${p.parcel.address.value ?? `parcel ${p.parcel.id}`}\n${humanize(p.parcel.land_use.value ?? 'land use missing')}`
    case 'buildings': {
      const name = p.building.name.value ?? `building ${p.building.id}`
      if (!p.conversion) return `${name}\n${humanize(p.building.property_type.value ?? 'type missing')}`
      return `${name}\nbest use: ${humanize(p.conversion.best_use)} · overall ${fmtNum(p.conversion.overall, 2)}`
    }
    case 'sites': {
      const d = p.site
      return `Site ${d.letter} · ${humanize(d.site.kind)} · ${fmtNum(d.site.homes)} homes${d.strategy ? ` · ${humanize(d.strategy)}` : ''}`
    }
    case 'new_buildings':
      return `New building · ${fmtNum(p.site.homes)} homes · ${fmtNum(p.site.height_ft)} ft${p.site.status === 'watch' ? '\non watch: does not pencil yet' : ''}`
    case 'stops':
      return `${p.stop.name ?? `Stop ${p.stop.id}`}\n${fmtNum(p.stop.riders_per_day_low)}–${fmtNum(p.stop.riders_per_day_high)} riders/day (est.)`
    case 'proposed_routes': {
      const r = p.route.route
      return `${p.route.name}\n${humanize(r.kind)} · phase ${r.phase}${r.headway_min ? ` · every ${r.headway_min} min` : ''}`
    }
    case 'transit_lines': {
      const l = p.line
      return `${lineLabel(l)}\n${l.mode === 'rail' ? 'rail' : 'bus'} · existing${l.headwayMin ? ` · every ${l.headwayMin} min at peak` : ''}`
    }
    case 'stations':
      return `${p.station.name}${p.station.note ? `\n${p.station.note}` : ''}`
    case 'amenities': {
      const f = p.feature
      const name = typeof f.attrs.name === 'string' ? `${f.attrs.name} · ` : ''
      if (f.kind === 'affordable_housing')
        return `${name}${fmtNum(f.attrs.li_units as number | null)} affordable of ${fmtNum(f.attrs.units as number | null)} homes (HUD LIHTC)`
      return `${name}${humanize(f.kind)}${f.attrs.proposed ? ' (proposed)' : ''}`
    }
  }
}

function selectFromPick(info: PickingInfo | null, dispatch: Dispatch<PlanAction>) {
  const p = decodePick(info)
  switch (p?.layer) {
    case 'parcels':
      return dispatch({ type: 'select', selected: { parcelId: p.parcel.id } })
    case 'buildings':
      return dispatch({ type: 'select', selected: { buildingId: p.building.id, parcelId: p.building.parcel_id } })
    case 'sites':
    case 'new_buildings': {
      const s = p.layer === 'sites' ? p.site.site : p.site
      return dispatch({ type: 'select', selected: { parcelId: s.parcel_ids[0], buildingId: s.building_id ?? undefined } })
    }
    case 'stops':
      return dispatch({ type: 'select', selected: { stopId: p.stop.id } })
    case 'transit_lines':
      return dispatch({ type: 'select', selected: { routeKey: p.line.key } })
    case 'proposed_routes':
      return dispatch({ type: 'select', selected: { routeKey: p.route.key } })
    case undefined:
      return dispatch({ type: 'select', selected: {} })
  }
}

/** Route keys a hovered object puts in focus: a line its own, a stop the routes that serve it. '|'-joined. */
function focusKeysOf(p: Picked | null): string {
  switch (p?.layer) {
    case 'transit_lines':
      return p.line.key
    case 'proposed_routes':
      return p.route.key
    case 'stops':
      return p.stop.route_ids.join('|')
    default:
      return ''
  }
}

export default function MapView({
  handleRef,
  large = false,
  insets = NO_INSETS,
  agentFocus: focusAgents = false,
}: {
  handleRef?: RefObject<MapHandle | null>
  large?: boolean
  /** Room the screen's overlay panels take, so the initial frame keeps the plan uncovered. */
  insets?: MapInsets
  /** Plan screen: picking an agent in the agent list emphasises its contributions and eases the camera to them. */
  agentFocus?: boolean
}) {
  const { state, dispatch, addEdit } = usePlan()
  const { factorNumber } = useApp()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [hoverKeys, setHoverKeys] = useState('')
  // MapLibre's click handler is bound once at map creation; it calls through this to see the current render.
  const clickRef = useRef<(e: MapMouseEvent) => void>(() => {})

  useEffect(() => {
    if (!containerRef.current) return
    const map = new MlMap({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [-95.37, 29.75],
      zoom: 14,
      ...ISO_CAMERA,
      attributionControl: { compact: true },
      // deck draws into this same WebGL context (interleaved), so multisampling smooths its strokes and building
      // edges too; the canvas renders at the device pixel ratio (MapLibre's default `pixelRatio`), which deck
      // follows in interleaved mode (its own useDevicePixels does not apply there).
      canvasContextAttributes: { antialias: true },
    })
    // Offline: tile fetches fail; a listener keeps them silent while fixture layers still draw.
    map.on('error', () => {})
    map.setVerticalFieldOfView(ISO_FOV_DEG)
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-left')
    const overlay = new MapboxOverlay({
      interleaved: true,
      // deck builds its camera from the map's centre/zoom/pitch but assumes MapLibre's default field of view; with
      // the narrow iso FOV the overlay slid against the base map as it moved. Same FOV, same projection. The id is
      // the one @deck.gl/mapbox looks up for the base map's view (its props type pins `views` to null; runtime takes it).
      views: new DeckMapView({ id: 'mapbox', fovy: ISO_FOV_DEG }) as never,
      layers: [],
      effects: [LIGHTING],
      pickingRadius: 4,
      onHover: (info) => setHoverKeys(focusKeysOf(decodePick(info))),
      // deck sets the canvas cursor every frame; while a tile is armed only its targets are pickable (compose below),
      // so the pointer shows exactly over what a click would place the tile on
      getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
      getTooltip: (info) => {
        const text = tooltipFor(info)
        return text
          ? {
              text,
              style: {
                background: '#EDEFEA',
                color: '#1C2230',
                border: '1px solid #D3D7D0',
                borderRadius: '10px',
                fontFamily: 'inherit',
                fontSize: large ? '16px' : '12px',
                whiteSpace: 'pre-wrap',
                maxWidth: large ? '420px' : '320px',
                maxHeight: '200px',
                overflow: 'hidden',
              },
            }
          : null
      },
    })
    map.addControl(overlay as unknown as IControl)
    // Clicks go through MapLibre's own click event and a deck pick at that point. Deck's interleaved onClick
    // (its own gesture recognizer on the shared canvas) fired only for the first click after load.
    map.on('click', (e) => clickRef.current(e))
    map.on('load', () => setLoaded(true))
    mapRef.current = map
    overlayRef.current = overlay
    return () => {
      overlayRef.current = null
      mapRef.current = null
      map.remove()
    }
  }, [large])

  // Picking handle for meeting-mode drops.
  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      pick: (clientX, clientY, layerIds) => {
        const map = mapRef.current
        const overlay = overlayRef.current
        if (!map || !overlay) return null
        const r = map.getCanvas().getBoundingClientRect()
        return decodePick(overlay.pickObject({ x: clientX - r.left, y: clientY - r.top, radius: 4, layerIds }))
      },
    }
  }, [handleRef])

  const locale = state.locale
  const { top, right, bottom, left } = insets
  useEffect(() => {
    const map = mapRef.current
    if (!map || !locale) return
    fitIso(map, outlinePoints(locale.boundary, locale.bbox), { top, right, bottom, left })
  }, [locale, loaded, top, right, bottom, left])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    for (const id of BASE_LAYER_IDS) map.setLayoutProperty(id, 'visibility', state.layers.base_dark ? 'visible' : 'none')
    map.setLayoutProperty('aerial', 'visibility', state.layers.aerial ? 'visible' : 'none')
  }, [loaded, state.layers.base_dark, state.layers.aerial])

  const plan = state.current
  const suggestions = state.plan
  const infra = plan.infrastructure ?? NO_INFRA
  const stations = locale?.stations ?? NO_STATIONS
  const routes = plan.transit?.routes ?? NO_ROUTES
  const stops = plan.transit?.stops ?? NO_STOPS
  const parcels = plan.parcels ?? NO_PARCELS
  const buildings = plan.buildings ?? NO_BUILDINGS
  const conversions = plan.conversions ?? NO_CONV
  const sites = plan.sites ?? NO_SITES
  const deals = plan.deals
  const L = state.layers
  const sel = state.selected
  const storyHeightFt = factorNumber('story_height_ft')

  const strategyBySite = useMemo(() => new Map<string, DealKind>((deals ?? []).map((d) => [d.site_id, d.strategy])), [deals])
  const buildingData = useMemo(() => flattenBuildings(buildings, conversions), [buildings, conversions])
  const siteData = useMemo(() => pursuedSites(sites, strategyBySite), [sites, strategyBySite])

  // Green-space slider: its edit moves `value × slider_max_open_space_share` of every in-plan new build's homes into
  // open space (rescore.py). Each such building shrinks to the far side of its plot and a lawn with trees takes the
  // rest (mapLayers greenPlots); the share on screen eases to a new value, the planting fades in once it settles.
  const sliderValue = state.edits.find((e) => e.edit.kind === 'slider')?.edit.value ?? 0
  const maxOpenShare = factorNumber('slider_max_open_space_share')
  const greenTarget = maxOpenShare === null ? 0 : Math.min(1, Math.max(0, sliderValue)) * maxOpenShare
  // `to`: the share this tween heads for; until its first frame the state still describes the previous one
  const [green, setGreen] = useState({ share: greenTarget, t: 1, to: greenTarget })
  const greenShown = useRef(greenTarget)
  useEffect(() => {
    const from = greenShown.current
    if (from === greenTarget) return
    const t0 = performance.now()
    let id = 0
    const tick = () => {
      const t = REDUCED_MOTION ? 1 : Math.min(1, (performance.now() - t0) / GREEN_MS)
      const share = t === 1 ? greenTarget : from + (greenTarget - from) * easeInOutCubic(t)
      greenShown.current = share
      setGreen({ share, t, to: greenTarget })
      if (t < 1) id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [greenTarget])
  const settledPlots = useMemo(() => greenPlots(sites, greenTarget), [sites, greenTarget])
  const plots = useMemo(
    () => (green.share === greenTarget ? settledPlots : greenPlots(sites, green.share)),
    [green.share, greenTarget, settledPlots, sites],
  )
  /** Where each new building will stand once the slider settles: construction scaffolds that footprint. */
  const buildRings = useMemo(
    () => new Map(settledPlots.map((p) => [p.site.id, p.building[0] as [number, number][]])),
    [settledPlots],
  )

  // Construction staging (construction.ts): a build starts when it first shows on this map (an agent result in a
  // live run or replay, a dropped tile, the New buildings layer switched on); the clock ticks only meanwhile.
  // Buildings on a parcel that gets a new build or a park come down first; what replaces them starts once cleared.
  const builds = useRef(new Map<string, Build>())
  const [stage, setStage] = useState<{ builds: ReadonlyMap<string, Build>; clock: number }>({ builds: new Map(), clock: 0 })
  const raf = useRef(0)
  const showNew = L.new_buildings
  const infraAdded = state.infraAdded
  useEffect(() => {
    if (!loaded) return
    const want = new Map<string, Omit<Build, 'start'>>()
    const byId = new Map(buildings.map((b) => [b.id, b]))
    const useOf = new Map(conversions.map((c) => [c.building_id, c.best_use]))
    const heightOf = (b: Building) => (storyHeightFt === null ? 0 : (b.stories.value ?? 0) * storyHeightFt * FT_TO_M)
    // plots being cleared: their outline and the parcel ids that whatever replaces the buildings waits on
    const clearing: { ring: [number, number][]; parcels: string[] }[] = []
    const kept = new Set<string>() // buildings a conversion keeps
    for (const s of sites) {
      if (s.status === 'pass') continue
      if (s.kind === 'new_build' && showNew) {
        const ring = outerRing(s.geometry)
        if (ring) clearing.push({ ring, parcels: s.parcel_ids })
        const footprint = buildRings.get(s.id) ?? ring
        if (footprint) want.set(`new:${s.id}`, { kind: 'new', ring: footprint, heightM: s.height_ft * FT_TO_M, parcels: s.parcel_ids })
      } else if (s.kind === 'conversion' && s.building_id) {
        kept.add(s.building_id)
        // keyed by the new use, so a Convert tile on a candidate wraps it again
        const b = byId.get(s.building_id)
        const use = useOf.get(s.building_id)
        const ring = b && outerRing(b.footprint)
        if (b && ring && use && use !== 'keep_current' && storyHeightFt !== null) {
          want.set(`conv:${b.id}:${use}`, { kind: 'convert', ring, heightM: heightOf(b), parcels: [] })
        }
      }
    }
    for (const f of infraAdded) {
      const pid = f.attrs.parcel_id
      const ring = outerRing(f.geometry)
      if (f.kind !== 'park' || typeof pid !== 'string' || !ring) continue
      clearing.push({ ring, parcels: [pid] })
      want.set(`park:${pid}`, { kind: 'park', ring, heightM: 0, parcels: [pid] })
    }
    // a building comes down when it is on a cleared parcel by id, or its footprint centre falls inside a cleared plot
    // (parcel links miss buildings that straddle parcels or were matched to a neighbour)
    for (const b of buildings) {
      const ring = outerRing(b.footprint)
      const c = geometryCentroid(b.footprint)
      if (kept.has(b.id) || !ring) continue
      const plot = clearing.find((p) => (b.parcel_id && p.parcels.includes(b.parcel_id)) || (c && pointInRing(c, p.ring)))
      if (plot) want.set(`demo:${b.id}`, { kind: 'demolish', ring, heightM: heightOf(b), parcels: plot.parcels })
    }
    const m = builds.current
    let changed = false
    for (const k of [...m.keys()]) if (!want.has(k)) changed = m.delete(k)
    const t0 = performance.now()
    let demolished = 0
    let added = 0
    // demolitions first, so the builds and parks that follow can wait for their plots
    for (const [k, v] of want) if (v.kind === 'demolish' && !m.has(k)) m.set(k, { ...v, start: t0 + demolished++ * STAGGER_MS })
    const clearedAt = (parcels: string[]) =>
      Math.max(t0, ...[...m.values()].filter((d) => d.kind === 'demolish' && d.parcels.some((p) => parcels.includes(p))).map((d) => d.start + CLEARED_MS))
    for (const [k, v] of want) {
      if (v.kind !== 'demolish' && !m.has(k)) m.set(k, { ...v, start: Math.max(t0 + added++ * STAGGER_MS, clearedAt(v.parcels)) })
    }
    added += demolished
    if (!added && !changed) return
    setStage({ builds: new Map(m), clock: t0 })
    if (!added || REDUCED_MOTION) return
    cancelAnimationFrame(raf.current)
    const tick = () => {
      const now = performance.now()
      setStage((s) => ({ ...s, clock: now }))
      if ([...m.values()].some((b) => now < b.start + buildDuration(b.kind))) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [loaded, sites, buildings, conversions, infraAdded, showNew, storyHeightFt, buildRings])
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const demolitions = useMemo(
    () => new Map([...stage.builds].filter(([k]) => k.startsWith('demo:')).map(([k, b]) => [k.slice('demo:'.length), b])),
    [stage.builds],
  )
  const hidden = useMemo(() => new Set(demolitions.keys()), [demolitions])
  // proposed parks still being laid out: construction.ts draws them until done, then the amenities layer takes over
  const pendingKey = [...stage.builds]
    .filter(([k, b]) => k.startsWith('park:') && progress(b, stage.clock) < 1)
    .map(([k]) => k.slice('park:'.length))
    .join('|')
  const pendingParks = useMemo(() => new Set(pendingKey ? pendingKey.split('|') : []), [pendingKey])

  // Transit focus: a hovered line or stop on the map, else a route hovered in the transit card, else the selected
  // route, else the routes serving the selected stop. Kept as a '|'-joined string so equal focus keeps the layers.
  const selStop = sel.stopId ? stops.find((s) => s.id === sel.stopId) : undefined
  const focusSpec = hoverKeys || state.hoverRouteKey || sel.routeKey || selStop?.route_ids.join('|') || ''
  const focus: TransitFocus = useMemo(() => (focusSpec ? new Set(focusSpec.split('|')) : null), [focusSpec])
  const lines = useMemo(() => transitLines(infra), [infra])
  const lineIndex = useMemo(() => new Map(lines.map((l) => [l.key, l])), [lines])
  const keyColors = useMemo(() => transitKeyColors(lines, routes), [lines, routes])
  const proposedKeys = useMemo(() => new Set(routes.filter(isProposedRoute).map((r) => routeKey(r.id))), [routes])
  const lTransit = useMemo(() => transitExistingLayer(lines, L.transit_existing, focus), [lines, L.transit_existing, focus])
  const lFeedStops = useMemo(
    () => feedStopsLayer(infra, L.transit_existing && stops.length === 0),
    [infra, L.transit_existing, stops.length],
  )
  const lStations = useMemo(() => stationsLayer(stations, L.transit_existing), [stations, L.transit_existing])
  const lWalk = useMemo(() => walkBikeLayer(infra, L.walk_bike), [infra, L.walk_bike])
  const lUtil = useMemo(() => utilitiesLayer(infra, L.utilities), [infra, L.utilities])
  const lAmen = useMemo(
    () => amenitiesLayer(infra, infraAdded, L.amenities, pendingParks),
    [infra, infraAdded, L.amenities, pendingParks],
  )
  const lFlood = useMemo(() => floodLayer(infra, L.flood), [infra, L.flood])
  const boundary = locale?.boundary
  // Drawn-area outline in ink: the paper base map would swallow a white line.
  const lBoundary = useMemo(
    () =>
      boundary
        ? new GeoJsonLayer({
            id: 'boundary',
            data: { type: 'Feature', geometry: boundary, properties: {} } as never,
            stroked: true,
            filled: false,
            getLineColor: [28, 34, 48, 200],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            parameters: { depthWriteEnabled: false, depthCompare: 'always' },
          })
        : null,
    [boundary],
  )
  const lProp = useMemo(
    () => proposedTransitLayer(routes, lineIndex, L.proposed_transit, focus),
    [routes, lineIndex, L.proposed_transit, focus],
  )
  const lStops = useMemo(
    () => stopsLayer(stops, proposedKeys, keyColors, { existing: L.transit_existing, proposed: L.proposed_transit }, focus, sel.stopId),
    [stops, proposedKeys, keyColors, L.transit_existing, L.proposed_transit, focus, sel.stopId],
  )
  const lParcels = useMemo(() => parcelsLayer(parcels, L.parcels || large, sel.parcelId), [parcels, L.parcels, large, sel.parcelId])
  // the selected parcel stays outlined even when the parcels layer is off (card links can select any parcel)
  const lSelParcel = useMemo(() => selectedParcelLayer(parcels, sel.parcelId), [parcels, sel.parcelId])
  const flyTo = sel.flyTo
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded || !flyTo) return
    // land the target in the middle of the part the panels leave free, not under them
    const offset: [number, number] = [(left - right) / 2, (top - bottom) / 2]
    map.flyTo({ center: flyTo, offset, zoom: Math.max(map.getZoom(), 16), duration: 1200 })
  }, [flyTo, loaded, top, right, bottom, left])
  const lBuildings = useMemo(
    () => buildingsLayer(buildingData, storyHeightFt, L.buildings || large, hidden),
    [buildingData, storyHeightFt, L.buildings, large, hidden],
  )
  const lDemo = useMemo(
    () => demolitionLayer(buildingData, storyHeightFt, demolitions, stage.clock),
    [buildingData, storyHeightFt, demolitions, stage.clock],
  )
  const lSelBuilding = useMemo(
    () => selectedBuildingLayer(buildingData, storyHeightFt, sel.buildingId),
    [buildingData, storyHeightFt, sel.buildingId],
  )
  const lSites = useMemo(() => sitesLayer(siteData, L.sites), [siteData, L.sites])
  const lNew = useMemo(() => {
    const rise = (siteId: string) => {
      const b = stage.builds.get(`new:${siteId}`)
      return b ? riseShare(b, stage.clock) : 1
    }
    return newBuildingsLayer(plots, showNew, rise, stage.clock)
  }, [plots, showNew, stage])
  const lLawns = useMemo(() => lawnLayer(plots, showNew), [plots, showNew])
  // trees for the settled lawns (no fountains: a lawn beside a home is not a park), faded in over the end of the
  // slider's ease (hidden while it moves)
  const decor = useMemo(
    () =>
      parkDecorLayers(
        'green_decor',
        settledPlots.flatMap((p) => (p.lawn ? [{ key: p.key, ring: p.lawn[0] as [number, number][] }] : [])),
        { fountains: false },
      ),
    [settledPlots],
  )
  const decorAlpha = green.to === greenTarget ? Math.min(1, Math.max(0, (green.t - DECOR_FADE_FROM) / (1 - DECOR_FADE_FROM))) : 0
  const lDecor = useMemo(
    () => decor.map((l) => l.clone({ opacity: l.props.opacity * decorAlpha, visible: showNew && decorAlpha > 0 })),
    [decor, decorAlpha, showNew],
  )
  const lBuild = useMemo(() => constructionLayer(stage.builds.values(), stage.clock), [stage])
  // New parks with a fountain: its droplets play for as long as the park stands. They are a layer of their own, built
  // at compose time, so the spray loop below redraws them without touching the construction layers.
  const fountains = useMemo(
    () => [...stage.builds.values()].flatMap((b) => {
      const at = fountainAt(b)
      return at ? [{ b, at }] : []
    }),
    [stage.builds],
  )
  const fountainsDone = fountains.some(({ b }) => progress(b, stage.clock) >= 1)

  // ---------------------------------------------------------------- click-twice tiles
  // The tray arms a tile (state.tool); its valid targets (tools.ts, the backend's own checks) light up in the tile's
  // colour and pulse, the rest dims. Clicking a target places the tile; anywhere else shakes a small red 'nope'.
  const tool = state.tool
  const toolOn = tool ? toolTarget(tool) : null
  // existing + edits, with the agents' plan filling any field the current view lacks (before the first rescore)
  const toolPlan = useMemo(() => ({ ...suggestions, ...plan }), [suggestions, plan])
  const valid = useMemo(() => (tool ? validTargets(toolPlan, tool, infraAdded) : null), [tool, toolPlan, infraAdded])
  const lToolParcels = useMemo(
    () => (tool && valid && toolOn === 'parcel' ? toolParcelsLayer(parcels, valid, TILE_COLORS[tool]) : null),
    [tool, valid, toolOn, parcels],
  )
  const lToolBuildings = useMemo(
    () => (tool && valid && toolOn === 'building' ? toolBuildingsLayer(buildingData, storyHeightFt, valid, TILE_COLORS[tool]) : null),
    [tool, valid, toolOn, buildingData, storyHeightFt],
  )

  const [pings, setPings] = useState<Ping[]>([])
  const pingSeq = useRef(0)
  const ping = useCallback((p: Omit<Ping, 'id'>) => {
    const id = ++pingSeq.current
    setPings((ps) => [...ps, { ...p, id }])
  }, [])
  const pingDone = useCallback((id: number) => setPings((ps) => ps.filter((x) => x.id !== id)), [])

  const centroids = toolPlan.precomputed?.centroid
  useEffect(() => {
    clickRef.current = (e) => {
      const map = mapRef.current
      const overlay = overlayRef.current
      if (!map || !overlay) return
      const at = { x: e.point.x, y: e.point.y, radius: 4 }
      if (!tool || !toolOn) return selectFromPick(overlay.pickObject(at), dispatch)
      // only the highlighted targets count: a building standing in front of a lot does not block it
      const p = decodePick(overlay.pickObject({ ...at, layerIds: [TOOL_LAYER_ID[toolOn]] }))
      let target: { id: string; where: string; c: LonLat | null } | null = null
      if (p?.layer === 'parcels') {
        const id = p.parcel.id
        target = { id, where: parcelLabel(p.parcel, id), c: centroids?.[id] ?? geometryCentroid(p.parcel.geometry) }
      } else if (p?.layer === 'buildings') {
        const id = p.building.id
        target = { id, where: buildingLabel(p.building, id), c: geometryCentroid(p.building.footprint) }
      }
      if (!target) {
        ping({ x: e.point.x, y: e.point.y, ok: false, color: '', rot: 0 })
        return
      }
      addEdit({ kind: 'place_tile', tile: tool, target_id: target.id }, target.where)
      dispatch({ type: 'tool', tool: null })
      const s = target.c ? map.project(target.c) : e.point
      ping({ x: s.x, y: s.y, ok: true, color: cssColor(TILE_COLORS[tool]), rot: Math.random() * 40 - 20 })
    }
  }, [tool, toolOn, centroids, addEdit, dispatch, ping])

  // ---------------------------------------------------------------- agent emphasis (plan screen)
  // Each pick in the agent list (state.agentPick counts them; the value at mount is ignored) emphasises the selected
  // agent's contributions, eases the camera to them and shows a caption; its ✕ clears the emphasis.
  const pick = state.agentPick
  const [mountPick] = useState(pick)
  const [clearedPick, setClearedPick] = useState<number | null>(null)
  const picked = focusAgents && pick !== mountPick
  const selectedAgent = state.selectedAgent
  const frame = locale?.bbox ?? null
  const agentView = useMemo(
    () =>
      picked
        ? agentFocus(selectedAgent, {
            plan: suggestions,
            current: plan,
            buildings: buildingData,
            storyHeightFt,
            lines: lineIndex,
            frame,
            factor: (k) => factorNumber(k, locale?.id),
          })
        : null,
    [picked, selectedAgent, suggestions, plan, buildingData, storyHeightFt, lineIndex, frame, factorNumber, locale?.id],
  )
  /** The emphasis in force: null before the first pick, for the coordinator and once cleared (its overlays fade out). */
  const focusView = clearedPick !== pick ? agentView : null

  const cameraPick = useRef(mountPick)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded || !picked || cameraPick.current === pick) return
    cameraPick.current = pick
    if (!agentView) return
    const b = agentView.bbox
    const pts: [number, number][] | null = b
      ? [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]
      : locale
        ? outlinePoints(locale.boundary, locale.bbox)
        : null
    if (!pts) return
    const i = AGENTS.indexOf(selectedAgent as (typeof AGENTS)[number])
    const bearing = ISO_CAMERA.bearing + (i % 2 === 0 ? -1 : 1) * FOCUS_BEARING_NUDGE_DEG
    const m = FOCUS_MARGIN_PX
    easeIso(map, pts, { top: top + m, right: right + m, bottom: bottom + m, left: left + m }, bearing, FOCUS_MAX_ZOOM)
  }, [pick, picked, loaded, agentView, selectedAgent, locale, top, right, bottom, left])

  const clearFocus = () => {
    setClearedPick(pick)
    const map = mapRef.current
    if (map && locale) easeIso(map, outlinePoints(locale.boundary, locale.bbox), { top, right, bottom, left }, ISO_CAMERA.bearing)
  }

  // ---------------------------------------------------------------- compose + animate
  // null: no emphasis in force; '' : emphasis that keeps no map layer (its overlays carry it)
  const emphKey = focusView ? focusView.emphasize.join(',') : null
  const fadeTargets = useMemo((): Fades => {
    const emph = new Set(emphKey ? emphKey.split(',') : [])
    const t = { ...REST }
    for (const g of FADE_GROUPS) if (emphKey !== null && g !== 'tool' && g !== 'agent' && !emph.has(g)) t[g] = FOCUS_DIM
    if (toolOn) for (const [g, v] of Object.entries(TOOL_DIM[toolOn]) as [FadeGroup, number][]) t[g] *= v
    t.tool = toolOn ? 1 : 0
    t.agent = emphKey !== null ? 1 : 0
    return t
  }, [emphKey, toolOn])

  const tween = useRef({ from: REST, to: REST, start: 0 })
  const fadeAt = useCallback((now: number): Fades => {
    const { from, to, start } = tween.current
    const e = FADE_MS ? easeInOutCubic(Math.min(1, Math.max(0, (now - start) / FADE_MS))) : 1
    return Object.fromEntries(FADE_GROUPS.map((g) => [g, from[g] + (to[g] - from[g]) * e])) as Fades
  }, [])

  // One rAF loop for every overlay animation: fades, the armed tile's pulse, agent overlays that move. It pushes
  // layers straight to deck (no React render per frame) and stops when nothing moves.
  const composeRef = useRef<(now: number) => Layer[]>(() => [])
  const anim = useRef({ raf: 0, until: 0, live: false, last: 0, slowRun: 0, starved: false })
  const push = useCallback(() => overlayRef.current?.setProps({ layers: composeRef.current(performance.now()) }), [])
  const kick = useCallback(() => {
    const a = anim.current
    if (a.raf) return
    a.last = 0
    const loop = (t: number) => {
      a.slowRun = a.last && t - a.last > SLOW_FRAME_MS ? a.slowRun + 1 : 0
      a.last = t
      if (a.slowRun >= SLOW_FRAMES) a.starved = true
      push()
      a.raf = (a.live && !a.starved) || performance.now() < a.until ? requestAnimationFrame(loop) : 0
    }
    a.raf = requestAnimationFrame(loop)
  }, [push])
  // reset the handle too: StrictMode re-runs effects, and a stale handle would keep kick() from ever starting the loop
  useEffect(() => {
    const a = anim.current
    return () => {
      cancelAnimationFrame(a.raf)
      a.raf = 0
    }
  }, [])

  useEffect(() => {
    const now = performance.now()
    tween.current = { from: fadeAt(now), to: fadeTargets, start: now }
    anim.current.until = now + FADE_MS
    kick()
  }, [fadeTargets, fadeAt, kick])
  // a fresh pick fades its overlays in, even when the previous agent's were already showing
  useEffect(() => {
    if (!picked) return
    const now = performance.now()
    tween.current = { from: { ...fadeAt(now), agent: 0 }, to: tween.current.to, start: now }
    anim.current.until = now + FADE_MS
    kick()
  }, [pick, picked, fadeAt, kick])

  const live = !REDUCED_MOTION && (toolOn !== null || focusView?.animate !== undefined)
  useEffect(() => {
    anim.current.live = live
    if (live) kick()
  }, [live, kick])

  // Finished parks' fountains play on after the stage clock stops: a light loop (one redraw per SPRAY_FRAME_MS) pushes
  // the layers to deck while such a fountain is in view, and only the droplet layer is rebuilt for it. None runs
  // without one, with reduced motion (the spray holds still), while the main loop already redraws every frame, or
  // once that loop found the map too slow to animate.
  useEffect(() => {
    if (REDUCED_MOTION || !fountainsDone) return
    let id = 0
    let last = 0
    const tick = (t: number) => {
      const a = anim.current
      if (a.starved) return
      id = requestAnimationFrame(tick)
      if (a.raf || t - last < SPRAY_FRAME_MS) return
      last = t
      const view = mapRef.current?.getBounds()
      const now = performance.now()
      if (view && fountains.some(({ b, at }) => progress(b, now) >= 1 && view.contains(at))) push()
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [fountainsDone, fountains, push])

  // Transit draws over the other ground layers (parcels, sidewalks) so lines stay legible; buildings still hide it.
  useEffect(() => {
    const emph = new Set<FadeGroup>(focusView?.emphasize ?? [])
    composeRef.current = (now) => {
      const v = fadeAt(now)
      const out: Layer[] = []
      // a layer in faded groups takes the strongest of their opacities; an emphasised layer shows even if toggled off
      const armed = lToolParcels !== null || lToolBuildings !== null
      const add = (l: Layer | null, ...groups: FadeGroup[]) => {
        if (!l) return
        const o = groups.length ? Math.max(...groups.map((g) => v[g])) : 1
        const show = groups.some((g) => emph.has(g)) && !l.props.visible
        // armed: only the targets answer hover and clicks, whatever stands in front of them
        const mute = armed && l.props.pickable
        const props = { ...(o === 1 ? {} : { opacity: l.props.opacity * o }), ...(show ? { visible: true } : {}), ...(mute ? { pickable: false } : {}) }
        out.push(o === 1 && !show && !mute ? l : l.clone(props))
      }
      const still = REDUCED_MOTION || anim.current.starved
      const pulse = still ? 1 : PULSE_LOW + (1 - PULSE_LOW) * (0.5 + 0.5 * Math.cos((now / PULSE_MS) * 2 * Math.PI))
      const addTool = (l: Layer | null) => {
        if (l && v.tool > 0) out.push(l.clone({ opacity: v.tool * pulse }))
      }
      const agent = agentView && v.agent > 0 ? v.agent : 0
      const addAgent = (ls: Layer[]) => {
        if (agent) for (const l of ls) out.push(l.clone({ opacity: l.props.opacity * agent }))
      }

      add(lWalk, 'walk_bike')
      add(lUtil, 'utilities')
      add(lAmen, 'amenities')
      add(lFlood, 'flood')
      add(lBoundary)
      add(lParcels, 'parcels')
      add(lSelParcel, 'parcels')
      add(lLawns, 'new_buildings')
      lTransit.forEach((l) => add(l, 'transit_existing'))
      add(lFeedStops, 'transit_existing')
      lProp.forEach((l) => add(l, 'proposed_transit'))
      add(lStops, 'transit_existing', 'proposed_transit')
      add(lStations, 'transit_existing')
      addTool(lToolParcels)
      if (agentView) {
        addAgent(agentView.layers)
        if (agentView.animate) addAgent(agentView.animate(now))
      }
      lBuildings.forEach((l) => add(l, 'buildings'))
      lDemo.forEach((l) => add(l, 'buildings'))
      lSelBuilding.forEach((l) => add(l, 'buildings'))
      lToolBuildings?.forEach((l) => addTool(l))
      lSites.forEach((l) => add(l, 'sites'))
      lNew.forEach((l) => add(l, 'new_buildings'))
      lDecor.forEach((l) => add(l, 'new_buildings'))
      lBuild.forEach((l) => add(l))
      if (fountains.length) add(fountainDropsLayer(fountains.map((f) => f.b), now))
      if (agentView) addAgent(agentView.above)
      return out
    }
    push()
  }, [
    lWalk, lUtil, lAmen, lFlood, lBoundary, lParcels, lSelParcel, lLawns, lTransit, lFeedStops, lProp, lStops, lStations,
    lBuildings, lDemo, lSelBuilding, lSites, lNew, lDecor, lBuild, fountains, lToolParcels, lToolBuildings, agentView,
    focusView, fadeAt, push, large,
  ])

  const caption = focusView?.caption ?? null

  // maplibre's own CSS sets `.maplibregl-map { position: relative }`, so the map gets a sized inner box.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
      {pings.map((p) => (
        <PlacePing key={p.id} ping={p} onDone={pingDone} />
      ))}
      {caption && (
        <div
          key={pick}
          role="status"
          // bottom-left, just above the panels along the map's bottom edge: clear of everything floating at the top
          style={{ bottom: bottom + 32 }}
          className="pop-in absolute left-3 z-20 w-max max-w-[min(30rem,calc(100%-1.5rem))] rounded-[12px] border-[1.5px] border-ink bg-paper py-2.5 pr-2.5 pl-3.5 shadow-[1.5px_1.5px_0_var(--color-ink),0_8px_24px_rgb(28_34_48/.12)]"
        >
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] leading-tight font-bold">{caption.title}</div>
              <div className="mt-0.5 text-[13px] leading-snug text-slate">{caption.summary}</div>
              <div className="mt-1 text-[13px] leading-snug">
                <span className="font-semibold">Unlocks:</span> {caption.unlocks}
              </div>
            </div>
            <button
              type="button"
              onClick={clearFocus}
              aria-label="Clear agent emphasis"
              title="Clear emphasis"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[13px] text-slate transition-colors duration-150 hover:bg-ink/[0.07] hover:text-ink"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
