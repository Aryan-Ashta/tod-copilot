import { useEffect, useRef, useState } from 'react'
import { Map as MlMap, Marker, NavigationControl, type GeoJSONSource } from 'maplibre-gl'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
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

const tierColor = (l: Locale) => (l.data_tier === 'costar_full' ? '#38bdf8' : '#f59e0b')

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
          new TerraDrawPolygonMode({ styles: { fillColor: '#ffffff', fillOpacity: 0.1, outlineColor: '#ffffff', outlineWidth: 2 } }),
          new TerraDrawRectangleMode({ styles: { fillColor: '#ffffff', fillOpacity: 0.1, outlineColor: '#ffffff', outlineWidth: 2 } }),
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
      el.style.cssText = `color:${tierColor(l)};font:600 11px system-ui;text-shadow:0 0 3px #000;white-space:nowrap;pointer-events:none`
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

  const btn = (active: boolean) =>
    `rounded border px-2.5 py-1 text-xs ${active ? 'border-sky-500 bg-sky-900 text-sky-100' : 'border-neutral-700 bg-neutral-900/90 text-neutral-200 hover:bg-neutral-800'}`

  return (
    <div className="relative h-[420px] overflow-hidden rounded-lg border border-neutral-800">
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute top-2 left-2 z-10 flex gap-1.5">
        <button type="button" disabled={!ready} onClick={() => startMode('polygon')} className={btn(mode === 'polygon')}>
          Draw polygon
        </button>
        <button type="button" disabled={!ready} onClick={() => startMode('rectangle')} className={btn(mode === 'rectangle')}>
          Draw rectangle
        </button>
        <button type="button" disabled={!ready} onClick={clear} className={btn(false)}>
          Clear
        </button>
      </div>
      {mode && (
        <div className="absolute right-2 bottom-2 z-10 rounded bg-neutral-900/90 px-2 py-1 text-[11px] text-neutral-300">
          {mode === 'polygon' ? 'Click to add corners; click the first corner to finish' : 'Click two opposite corners'}
        </div>
      )}
    </div>
  )
}
