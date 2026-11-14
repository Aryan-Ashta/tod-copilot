import { useEffect, useRef, useState } from 'react'
import { Map as MlMap, Marker, NavigationControl, type GeoJSONSource } from 'maplibre-gl'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { metros } from '../api'
import { BASE_STYLE } from './MapView'
import type { Locale } from '../types'
import type { BBox } from '../geo'

export interface PolygonGeometry {
  type: 'Polygon'
  coordinates: [number, number][][]
}

interface Props {
  locales: Locale[]
  selectedLocale: string | null
  boundary: PolygonGeometry | null
  onBoundary: (b: PolygonGeometry | null) => void
  onLocale: (id: string | null) => void
  flyTo: BBox | null
}

type DrawMode = 'polygon' | 'rectangle'

// Text-safe on paper: blue 5.1:1, dark mustard 4.6:1.
const tierColor = (l: Locale) => (l.data_tier === 'costar_full' ? '#2F5BD3' : '#8A6512')

function localeOutlines(locales: Locale[], selected: string | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: locales.map((l) => {
      const [w, s, e, n] = l.bbox
      return {
        type: 'Feature',
        properties: { id: l.id, color: tierColor(l), width: l.id === selected ? 3 : 1.5 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      }
    }),
  }
}

/** Map for choosing a recorded locale or drawing one boundary (polygon or rectangle) with terra-draw. */
export default function AreaPicker({ locales, selectedLocale, boundary, onBoundary, onLocale, flyTo }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const drawRef = useRef<TerraDraw | null>(null)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<DrawMode | null>(null)
  // Latest callbacks for the long-lived map/draw listeners.
  const onBoundaryRef = useRef(onBoundary)
  const onLocaleRef = useRef(onLocale)
  useEffect(() => {
    onBoundaryRef.current = onBoundary
    onLocaleRef.current = onLocale
  })

  useEffect(() => {
    if (!containerRef.current) return
    const map = new MlMap({
      container: containerRef.current,
      style: BASE_STYLE,
      center: [-98.5, 37.5],
      zoom: 3,
      attributionControl: { compact: true },
    })
    // Offline: tile fetches fail; keep them silent.
    map.on('error', () => {})
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-left')
    map.on('load', () => {
      // Onboarded counties (thin grey) and cities (dashed, brighter), under the recorded boxes. A guide only: any US
      // county can be drawn in; area_check validates the drawing.
      map.addSource('metros', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: 'metros-fill',
        type: 'fill',
        source: 'metros',
        filter: ['==', ['get', 'kind'], 'county'],
        paint: { 'fill-color': '#1C2230', 'fill-opacity': 0.04 },
      })
      map.addLayer({
        id: 'metros-county',
        type: 'line',
        source: 'metros',
        filter: ['==', ['get', 'kind'], 'county'],
        paint: { 'line-color': '#1C2230', 'line-width': 1 },
      })
      map.addLayer({
        id: 'metros-city',
        type: 'line',
        source: 'metros',
        filter: ['==', ['get', 'kind'], 'place'],
        paint: { 'line-color': '#5F6778', 'line-width': 1.2, 'line-dasharray': [3, 2] },
      })
      metros()
        .then((fc) => (map.getSource('metros') as GeoJSONSource | undefined)?.setData(fc as GeoJSON.FeatureCollection))
        .catch(() => {
          // outlines are a guide only; area_check still validates drawings
        })
      map.addSource('locales', { type: 'geojson', data: localeOutlines([], null) })
      map.addLayer({ id: 'locales-fill', type: 'fill', source: 'locales', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.06 } })
      map.addLayer({
        id: 'locales-line',
        type: 'line',
        source: 'locales',
        paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
      })
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawPolygonMode({ styles: { fillColor: '#2F5BD3', fillOpacity: 0.1, outlineColor: '#1C2230', outlineWidth: 2 } }),
          new TerraDrawRectangleMode({ styles: { fillColor: '#2F5BD3', fillOpacity: 0.1, outlineColor: '#1C2230', outlineWidth: 2 } }),
        ],
      })
      draw.start()
      draw.on('finish', (id) => {
        const snapshot = draw.getSnapshot()
        const others = snapshot.filter((f) => f.id !== id).map((f) => f.id as string)
        if (others.length) draw.removeFeatures(others)
        const done = snapshot.find((f) => f.id === id)
        if (done?.geometry.type === 'Polygon') onBoundaryRef.current(done.geometry as PolygonGeometry)
        // Back to static so map panning works again; the drawn feature stays.
        draw.setMode('static')
        setMode(null)
      })
      drawRef.current = draw
      setReady(true)
    })
    // Clicking a recorded outline selects that locale, but only while nothing is drawn or being drawn:
    // the click that finishes a drawing also reaches this handler and must not clear the new boundary.
    map.on('click', 'locales-fill', (e) => {
      const draw = drawRef.current
      if (!draw || draw.getMode() !== 'static' || draw.getSnapshot().length > 0) return
      const id = e.features?.[0]?.properties?.id
      if (typeof id === 'string') onLocaleRef.current(id)
    })
    mapRef.current = map
    return () => {
      drawRef.current?.stop()
      drawRef.current = null
      mapRef.current = null
      map.remove()
    }
  }, [])

  // Outlines plus HTML name labels (the base style has no glyphs for symbol layers).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    ;(map.getSource('locales') as GeoJSONSource | undefined)?.setData(localeOutlines(locales, selectedLocale))
    const markers = locales.map((l) => {
      const el = document.createElement('div')
      el.textContent = l.name
      el.style.cssText = `color:${tierColor(l)};font:600 12px Archivo Variable,system-ui;text-shadow:0 0 3px #EDEFEA,0 0 3px #EDEFEA;white-space:nowrap;pointer-events:none`
      return new Marker({ element: el, anchor: 'bottom-left' }).setLngLat([l.bbox[0], l.bbox[3]]).addTo(map)
    })
    return () => markers.forEach((m) => m.remove())
  }, [locales, selectedLocale, ready])

  useEffect(() => {
    if (!flyTo || !mapRef.current) return
    const [w, s, e, n] = flyTo
    mapRef.current.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 40 },
    )
  }, [flyTo])

  // Parent cleared the boundary (e.g. picked a locale card): remove drawings.
  useEffect(() => {
    if (!boundary && ready) drawRef.current?.clear()
  }, [boundary, ready])

  const startMode = (m: DrawMode) => {
    drawRef.current?.setMode(m)
    setMode(m)
  }
  const clear = () => {
    drawRef.current?.clear()
    drawRef.current?.setMode('static')
    setMode(null)
    onBoundary(null)
  }

  // the site's .ctl button; aria-pressed fills it ink while a drawing mode is on
  const btn = 'ctl bg-paper px-2.5 py-1 text-xs'

  return (
    <div className="relative h-[420px] overflow-hidden">
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute top-3 left-3 z-10 flex gap-2">
        <button type="button" disabled={!ready} onClick={() => startMode('polygon')} className={btn} aria-pressed={mode === 'polygon'}>
          Draw polygon
        </button>
        <button type="button" disabled={!ready} onClick={() => startMode('rectangle')} className={btn} aria-pressed={mode === 'rectangle'}>
          Draw rectangle
        </button>
        <button type="button" disabled={!ready} onClick={clear} className={btn}>
          Clear
        </button>
      </div>
      {mode && (
        <div className="absolute right-3 bottom-3 z-10 border border-rule bg-paper px-2 py-1 text-xs text-slate">
          {mode === 'polygon' ? 'Click to add corners; click the first corner to finish' : 'Click two opposite corners'}
        </div>
      )}
    </div>
  )
}
