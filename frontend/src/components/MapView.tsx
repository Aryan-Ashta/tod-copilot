import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject } from 'react'
import { Map as MlMap, NavigationControl, type IControl, type StyleSpecification } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import { AmbientLight, DirectionalLight, LightingEffect, MapView as DeckMapView, type PickingInfo } from '@deck.gl/core'
import { GeoJsonLayer } from '@deck.gl/layers'
import { boundaryPoints, outerRing, type BBox } from '../geo'
import {
  buildDuration,
  CLEARED_MS,
  constructionLayer,
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
  flattenBuildings,
  floodLayer,
  FT_TO_M,
  newBuildingsLayer,
  parcelsLayer,
  selectedBuildingLayer,
  selectedParcelLayer,
  proposedTransitLayer,
  pursuedSites,
  sitesLayer,
  transitExistingLayer,
  utilitiesLayer,
  walkBikeLayer,
  decodePick,
  type Picked,
} from '../mapLayers'
import type { Building, ConversionCandidate, DealKind, Geometry, InfraFeature, Parcel, Route, Site, Station, Stop } from '../types'
import { fmtNum, humanize } from '../format'

export interface MapHandle {
  /** Pick the top object under a viewport (client) point, restricted to the given deck layer ids. */
  pick: (clientX: number, clientY: number, layerIds: string[]) => Picked | null
}

// Esri's light gray canvas needs no key, matches the paper ground of the iso figures and keeps labels off the base.
// Source maxzoom: past it MapLibre overzooms the last real tile. The canvas serves "Map data not yet available"
// placeholders (HTTP 200) from z17; World_Imagery has real tiles to z19 downtown.
export const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    dark: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 16,
      attribution: 'Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS user community',
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
    { id: 'base_dark', type: 'raster', source: 'dark' },
    { id: 'aerial', type: 'raster', source: 'aerial', layout: { visibility: 'none' } },
  ],
}

// The iso look on a real map: looking north-west from 60° pitch (the 2:1 figures' 30° ground angle) with a narrow
// field of view so verticals stay close to parallel. MapLibre has no orthographic camera; 10° is near enough.
export const ISO_CAMERA = { bearing: -45, pitch: 60 }
const ISO_FOV_DEG = 10
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
function fitIso(map: MlMap, pts: [number, number][], insets: MapInsets) {
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
    { bearing: ISO_CAMERA.bearing },
  )
  if (!cam) return
  map.jumpTo({ ...cam, ...ISO_CAMERA })
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
    map.jumpTo({ zoom: map.getZoom() + Math.log2(scale) })
    e = extent()
    const from = map.unproject([(e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2])
    const to = map.unproject([insets.left + fw / 2, insets.top + fh / 2])
    const c = map.getCenter()
    map.jumpTo({ center: [c.lng + from.lng - to.lng, c.lat + from.lat - to.lat] })
  }
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
    case 'proposed_stops':
      return `${p.stop.name ?? `Stop ${p.stop.id}`}\n${fmtNum(p.stop.riders_per_day_low)}–${fmtNum(p.stop.riders_per_day_high)} riders/day (est.)`
    case 'proposed_routes':
      return `${humanize(p.route.kind)} · phase ${p.route.phase}${p.route.headway_min ? ` · every ${p.route.headway_min} min` : ''}`
    case 'stations':
      return `${p.station.name}${p.station.note ? `\n${p.station.note}` : ''}`
    case 'amenities': {
      const f = p.feature
      const name = typeof f.attrs.name === 'string' ? `${f.attrs.name} · ` : ''
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
    case 'proposed_stops':
      return dispatch({ type: 'select', selected: { stopId: p.stop.id } })
    case undefined:
      return dispatch({ type: 'select', selected: {} })
  }
}

export default function MapView({
  handleRef,
  large = false,
  insets = NO_INSETS,
}: {
  handleRef?: RefObject<MapHandle | null>
  large?: boolean
  /** Room the screen's overlay panels take, so the initial frame keeps the plan uncovered. */
  insets?: MapInsets
}) {
  const { state, dispatch } = usePlan()
  const { factorNumber } = useApp()
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const overlayRef = useRef<MapboxOverlay | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    const map = new MlMap({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [-95.37, 29.75],
      zoom: 14,
      ...ISO_CAMERA,
      attributionControl: { compact: true },
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
                whiteSpace: 'pre',
              },
            }
          : null
      },
    })
    map.addControl(overlay as unknown as IControl)
    // Clicks select through MapLibre's own click event and a deck pick at that point. Deck's interleaved onClick
    // (its own gesture recognizer on the shared canvas) fired only for the first click after load.
    map.on('click', (e) => selectFromPick(overlay.pickObject({ x: e.point.x, y: e.point.y, radius: 4 }), dispatch))
    map.on('load', () => setLoaded(true))
    mapRef.current = map
    overlayRef.current = overlay
    return () => {
      overlayRef.current = null
      mapRef.current = null
      map.remove()
    }
  }, [large, dispatch])

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
    map.setLayoutProperty('base_dark', 'visibility', state.layers.base_dark ? 'visible' : 'none')
    map.setLayoutProperty('aerial', 'visibility', state.layers.aerial ? 'visible' : 'none')
  }, [loaded, state.layers.base_dark, state.layers.aerial])

  const plan = state.plan
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
    const clearing = new Set<string>()
    const kept = new Set<string>() // buildings a conversion keeps
    for (const s of sites) {
      if (s.status === 'pass') continue
      if (s.kind === 'new_build' && showNew) {
        s.parcel_ids.forEach((p) => clearing.add(p))
        const ring = outerRing(s.geometry)
        if (ring) want.set(`new:${s.id}`, { kind: 'new', ring, heightM: s.height_ft * FT_TO_M, parcels: s.parcel_ids })
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
      clearing.add(pid)
      want.set(`park:${pid}`, { kind: 'park', ring, heightM: 0, parcels: [pid] })
    }
    for (const b of buildings) {
      const ring = outerRing(b.footprint)
      if (!b.parcel_id || !clearing.has(b.parcel_id) || kept.has(b.id) || !ring) continue
      want.set(`demo:${b.id}`, { kind: 'demolish', ring, heightM: heightOf(b), parcels: [b.parcel_id] })
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
  }, [loaded, sites, buildings, conversions, infraAdded, showNew, storyHeightFt])
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

  const lTransit = useMemo(() => transitExistingLayer(infra, stations, L.transit_existing), [infra, stations, L.transit_existing])
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
    () => proposedTransitLayer(routes, stops, L.proposed_transit, sel.stopId),
    [routes, stops, L.proposed_transit, sel.stopId],
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
    return newBuildingsLayer(sites, showNew, rise, stage.clock)
  }, [sites, showNew, stage])
  const lBuild = useMemo(() => constructionLayer(stage.builds.values(), stage.clock), [stage])

  useEffect(() => {
    overlayRef.current?.setProps({
      layers: [
        ...lTransit, lWalk, lUtil, lAmen, lFlood, lBoundary, ...lProp, lParcels, lSelParcel,
        lBuildings, lDemo, lSelBuilding, ...lSites, lNew, ...lBuild,
      ],
    })
  }, [lTransit, lWalk, lUtil, lAmen, lFlood, lBoundary, lProp, lParcels, lSelParcel, lBuildings, lDemo, lSelBuilding, lSites, lNew, lBuild, large])

  // maplibre's own CSS sets `.maplibregl-map { position: relative }`, so the map gets a sized inner box.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
