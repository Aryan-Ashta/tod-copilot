import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject } from 'react'
import { Map as MlMap, NavigationControl, type IControl, type StyleSpecification } from 'maplibre-gl'
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { PickingInfo } from '@deck.gl/core'
import { GeoJsonLayer } from '@deck.gl/layers'
import { geometryBounds } from '../geo'
import { usePlan, type PlanAction } from '../state/PlanContext'
import { useApp } from '../state/AppContext'
import {
  amenitiesLayer,
  buildingsLayer,
  flattenBuildings,
  floodLayer,
  newBuildingsLayer,
  parcelsLayer,
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
import type { Building, ConversionCandidate, DealKind, InfraFeature, Parcel, Route, Site, Station, Stop } from '../types'
import { fmtNum, humanize } from '../format'

export interface MapHandle {
  /** Pick the top object under a viewport (client) point, restricted to the given deck layer ids. */
  pick: (clientX: number, clientY: number, layerIds: string[]) => Picked | null
}

// Esri's dark gray canvas needs no key (Carto's dark tiles now watermark "API KEY REQUIRED").
// Source maxzoom: past it MapLibre overzooms the last real tile. The dark canvas serves "Map data not yet
// available" placeholders (HTTP 200) from z17; World_Imagery has real tiles to z19 downtown.
export const BASE_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    dark: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 16,
      attribution: 'Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors',
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
    { id: 'background', type: 'background', paint: { 'background-color': '#0a0a0a' } },
    { id: 'base_dark', type: 'raster', source: 'dark' },
    { id: 'aerial', type: 'raster', source: 'aerial', layout: { visibility: 'none' } },
  ],
}

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
      return `New building · ${fmtNum(p.site.homes)} homes · ${fmtNum(p.site.height_ft)} ft`
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

function selectFromPick(info: PickingInfo, dispatch: Dispatch<PlanAction>) {
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

export default function MapView({ handleRef, large = false }: { handleRef?: RefObject<MapHandle | null>; large?: boolean }) {
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
      pitch: 45,
      attributionControl: { compact: true },
    })
    // Offline: tile fetches fail; a listener keeps them silent while fixture layers still draw.
    map.on('error', () => {})
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-left')
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onClick: (info) => selectFromPick(info, dispatch),
      getTooltip: (info) => {
        const text = tooltipFor(info)
        return text
          ? { text, style: { background: '#171717', color: '#f5f5f5', fontSize: large ? '16px' : '12px', whiteSpace: 'pre' } }
          : null
      },
    })
    map.addControl(overlay as unknown as IControl)
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
  useEffect(() => {
    const map = mapRef.current
    if (!map || !locale) return
    const [a, b, c, d] = (locale.boundary && geometryBounds(locale.boundary)) || locale.bbox
    map.fitBounds(
      [
        [a, b],
        [c, d],
      ],
      { padding: 40, duration: 0, pitch: 45 },
    )
  }, [locale, loaded])

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

  const lTransit = useMemo(() => transitExistingLayer(infra, stations, L.transit_existing), [infra, stations, L.transit_existing])
  const lWalk = useMemo(() => walkBikeLayer(infra, L.walk_bike), [infra, L.walk_bike])
  const lUtil = useMemo(() => utilitiesLayer(infra, L.utilities), [infra, L.utilities])
  const lAmen = useMemo(() => amenitiesLayer(infra, state.infraAdded, L.amenities), [infra, state.infraAdded, L.amenities])
  const lFlood = useMemo(() => floodLayer(infra, L.flood), [infra, L.flood])
  const boundary = locale?.boundary
  const lBoundary = useMemo(
    () =>
      boundary
        ? new GeoJsonLayer({
            id: 'boundary',
            data: { type: 'Feature', geometry: boundary, properties: {} } as never,
            stroked: true,
            filled: false,
            getLineColor: [255, 255, 255, 255],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
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
    map.flyTo({ center: flyTo, zoom: Math.max(map.getZoom(), 16), duration: 1200 })
  }, [flyTo, loaded])
  const lBuildings = useMemo(
    () => buildingsLayer(buildingData, storyHeightFt, L.buildings || large, sel.buildingId),
    [buildingData, storyHeightFt, L.buildings, large, sel.buildingId],
  )
  const lSites = useMemo(() => sitesLayer(siteData, L.sites), [siteData, L.sites])
  const lNew = useMemo(() => newBuildingsLayer(sites, L.new_buildings), [sites, L.new_buildings])

  useEffect(() => {
    overlayRef.current?.setProps({
      layers: [...lTransit, lWalk, lUtil, lAmen, lFlood, lBoundary, ...lProp, lParcels, lSelParcel, lBuildings, ...lSites, lNew],
    })
  }, [lTransit, lWalk, lUtil, lAmen, lFlood, lBoundary, lProp, lParcels, lSelParcel, lBuildings, lSites, lNew, large])

  // maplibre's own CSS sets `.maplibregl-map { position: relative }`, so the map gets a sized inner box.
  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}
