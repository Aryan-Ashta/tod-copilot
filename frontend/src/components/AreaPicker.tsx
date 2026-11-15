import { useEffect, useRef, useState } from 'react'
import { Map as MlMap, Marker, NavigationControl, type GeoJSONSource } from 'maplibre-gl'
import { TerraDraw, TerraDrawFreehandLineStringMode, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { metros } from '../api'
import { ATTRIBUTION, BASE_STYLE, collapseAttribution } from './MapView'
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
  /** Screen space covered by other UI; the US view and fly-tos centre in what is left. */
  padding?: { top: number; right: number; bottom: number; left: number }
}

const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 }

type DrawMode = 'freehand' | 'polygon' | 'rectangle'

// The map opens on the lower 48 states and cannot pan or zoom out past them (every supported area is there).
const US_VIEW: [[number, number], [number, number]] = [
  [-125, 24],
  [-66.5, 49.5],
]
const US_LIMIT: [[number, number], [number, number]] = [
  [-135, 15],
  [-55, 56],
]
const DRAW_STYLE = { fillColor: '#2F5BD3', fillOpacity: 0.1, outlineColor: '#1C2230', outlineWidth: 2 } as const
// Recorded areas left off this map (no pin, no outline).
const NOT_ON_MAP: Record<string, true> = { brevard_cocoa: true }
// Pin colour and short name per recorded area; others get blue and their full name.
const PIN: Record<string, { color: string; name: string }> = {
  houston_downtown: { color: '#2E7D5B', name: 'Houston Main St rail' },
  la_wilshire_koreatown: { color: '#2F5BD3', name: 'Wilshire Koreatown' },
}
const pinColor = (id: string) => PIN[id]?.color ?? '#2F5BD3'

function localeOutlines(locales: Locale[], selected: string | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: locales.map((l) => {
      const [w, s, e, n] = l.bbox
      return {
        type: 'Feature',
        properties: { id: l.id, color: pinColor(l.id), width: l.id === selected ? 2.5 : 1.5, fill: l.id === selected ? 0.1 : 0.05 },
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
export default function AreaPicker({ locales, selectedLocale, boundary, onBoundary, onLocale, flyTo, padding = NO_PADDING }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  const drawRef = useRef<TerraDraw | null>(null)
  const [ready, setReady] = useState(false)
  // Starts in pan: the map drags until a draw tool is picked.
  const [mode, setMode] = useState<DrawMode | null>(null)
  // Latest callbacks for the long-lived map/draw listeners.
  const onBoundaryRef = useRef(onBoundary)
  const onLocaleRef = useRef(onLocale)
  const paddingRef = useRef(padding)
  useEffect(() => {
    onBoundaryRef.current = onBoundary
    onLocaleRef.current = onLocale
    paddingRef.current = padding
  })

  useEffect(() => {
    if (!containerRef.current) return
    const map = new MlMap({
      container: containerRef.current,
      style: BASE_STYLE,
      // Opens a little wide and glides onto the US once loaded.
      bounds: US_LIMIT,
      fitBoundsOptions: { padding: paddingRef.current },
      maxBounds: US_LIMIT,
      renderWorldCopies: false,
      attributionControl: ATTRIBUTION,
    })
    // Offline: tile fetches fail; keep them silent.
    map.on('error', () => {})
    collapseAttribution(map)
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.on('load', () => {
      // State lines (US Census cartographic boundaries; scripts/build_us_reference.py), under everything else.
      map.addSource('states', { type: 'geojson', data: '/geo/us-states.geojson', attribution: 'States: US Census Bureau' })
      map.addLayer({
        id: 'states-line',
        type: 'line',
        source: 'states',
        paint: {
          'line-color': '#1C2230',
          'line-opacity': 0.4,
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 8, 1.6],
        },
      })
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
      map.addLayer({ id: 'locales-fill', type: 'fill', source: 'locales', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fill'] } })
      map.addLayer({
        id: 'locales-line',
        type: 'line',
        source: 'locales',
        paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] },
      })
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          // Freehand is traced as an open line (no closing edge back to the start, as on Zillow) and becomes a
          // polygon on release; rectangle also draws while the button is held.
          new TerraDrawFreehandLineStringMode({
            drawInteraction: 'click-drag',
            styles: { lineStringColor: '#1C2230', lineStringWidth: 2, closingPointOpacity: 0, closingPointOutlineOpacity: 0 },
          }),
          new TerraDrawPolygonMode({ styles: DRAW_STYLE }),
          new TerraDrawRectangleMode({ drawInteraction: 'click-drag', styles: DRAW_STYLE }),
        ],
      })
      draw.start() // terra-draw starts in 'static', so the map pans until a draw tool is picked
      draw.on('finish', (id) => {
        const snapshot = draw.getSnapshot()
        const others = snapshot.filter((f) => f.id !== id).map((f) => f.id as string)
        if (others.length) draw.removeFeatures(others)
        const done = snapshot.find((f) => f.id === id)
        let ring: PolygonGeometry | null = done?.geometry.type === 'Polygon' ? (done.geometry as PolygonGeometry) : null
        if (done?.geometry.type === 'LineString') {
          // Close the traced line into a polygon shown with the polygon mode's style; a tap or a scribble of
          // fewer than three points is dropped.
          draw.removeFeatures([id])
          const pts = done.geometry.coordinates as [number, number][]
          if (pts.length >= 3) {
            const polygon: PolygonGeometry = { type: 'Polygon', coordinates: [[...pts, pts[0]]] }
            const [added] = draw.addFeatures([{ type: 'Feature', geometry: polygon, properties: { mode: 'polygon' } }])
            if (added?.valid) ring = polygon
          }
        }
        if (ring) onBoundaryRef.current(ring)
        // Back to static so map panning works again; the drawn feature stays.
        draw.setMode('static')
        setMode(null)
      })
      drawRef.current = draw
      setReady(true)
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      map.fitBounds(US_VIEW, { padding: paddingRef.current, duration: still ? 0 : 2200, curve: 1.2 })
    })
    // Clicking a recorded outline selects that locale, but only while nothing is drawn or being drawn:
    // the click that finishes a drawing also reaches this handler and must not clear the new boundary.
    map.on('click', 'locales-fill', (e) => {
      const draw = drawRef.current
      if (!draw || draw.getSnapshot().length > 0) return
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

  // Outlines plus one HTML pin per recorded area at its centre (the base style has no glyphs for symbol layers).
  // Clicking a pin selects that area, but only while nothing is drawn or being drawn.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const shown = locales.filter((l) => !NOT_ON_MAP[l.id])
    ;(map.getSource('locales') as GeoJSONSource | undefined)?.setData(localeOutlines(shown, selectedLocale))
    const markers = shown.map((l) => {
      const on = l.id === selectedLocale
      const color = pinColor(l.id)
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'flex items-center gap-2 cursor-pointer'
      el.setAttribute('aria-label', `Pick ${l.name}`)
      el.setAttribute('aria-pressed', String(on))
      const dot = document.createElement('span')
      dot.className = 'relative block h-3.5 w-3.5 shrink-0 rounded-full border-[2.5px] border-white shadow-[0_1px_4px_rgb(28_34_48/.35)]'
      dot.style.background = color
      if (on) {
        const ring = document.createElement('span')
        ring.className = 'pin-pulse absolute -inset-2.5 rounded-full border-2'
        ring.style.borderColor = color
        dot.append(ring)
      }
      const name = document.createElement('span')
      name.className = `rounded-full bg-white px-2.5 py-1 text-[12.5px] whitespace-nowrap shadow-[0_1px_2px_rgb(28_34_48/.15),0_6px_16px_rgb(28_34_48/.14)] transition-transform hover:-translate-y-px ${on ? 'font-bold text-ink' : 'font-semibold text-slate'}`
      name.textContent = PIN[l.id]?.name ?? l.name
      el.append(dot, name)
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const draw = drawRef.current
        if (!draw || draw.getSnapshot().length > 0) return
        onLocaleRef.current(l.id)
      })
      const [w, s, e, n] = l.bbox
      return new Marker({ element: el, anchor: 'left', offset: [-7, 0] }).setLngLat([(w + e) / 2, (s + n) / 2]).addTo(map)
    })
    return () => markers.forEach((m) => m.remove())
  }, [locales, selectedLocale, ready])

  useEffect(() => {
    if (!flyTo || !mapRef.current) return
    const [w, s, e, n] = flyTo
    const p = paddingRef.current
    mapRef.current.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: { top: p.top + 40, right: p.right + 40, bottom: p.bottom + 40, left: p.left + 40 }, duration: 1600 },
    )
  }, [flyTo])

  // Parent cleared the boundary (e.g. picked a locale card): remove drawings.
  useEffect(() => {
    if (!boundary && ready) drawRef.current?.clear()
  }, [boundary, ready])

  // Pressing the active mode's button turns it off, so the map pans again.
  const startMode = (m: DrawMode) => {
    const next = m === mode ? null : m
    drawRef.current?.setMode(next === null ? 'static' : next === 'freehand' ? 'freehand-linestring' : next)
    setMode(next)
  }
  // Clear goes back to the default: nothing drawn, map panning.
  const clear = () => {
    drawRef.current?.clear()
    drawRef.current?.setMode('static')
    setMode(null)
    onBoundary(null)
  }

  const btn =
    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-slate transition-colors duration-150 hover:bg-ink/5 hover:text-ink disabled:opacity-40 aria-pressed:bg-ink aria-pressed:text-paper aria-pressed:hover:bg-ink aria-pressed:hover:text-paper'
  // only while a draw tool is on; panning needs no instructions
  const hint =
    mode === 'freehand'
      ? 'Press and drag around the area; release to close it'
      : mode === 'polygon'
        ? 'Click to add corners; click the first corner to finish'
        : mode === 'rectangle'
          ? 'Press and drag across the map; release to finish'
          : null

  // Fills its parent; the draw tools and the current hint float in the top-right corner.
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute z-10 flex flex-col items-end gap-2" style={{ top: 12, right: padding.right + 12 }}>
        <div className="flex items-center gap-0.5 rounded-full bg-paper/85 p-1 shadow-[0_4px_14px_rgb(28_34_48/.10)] backdrop-blur-md" role="group" aria-label="Draw tools">
          {(
            [
              ['freehand', 'Freehand', 'Draw freehand', <path key="i" d="M2.5 11c1.5-4 3-6 4.5-4.5s0 4 2 4 2.5-5 4.5-6" />],
              ['rectangle', 'Rectangle', 'Draw rectangle', <rect key="i" x="2.5" y="4" width="11" height="8" rx="1" />],
              ['polygon', 'Polygon', 'Draw polygon', <path key="i" d="M3 5l5-2.5 5.5 4-2.5 6.5H4.5z" />],
            ] as const
          ).map(([m, label, full, glyph]) => (
            <button
              key={m}
              type="button"
              disabled={!ready}
              onClick={() => startMode(m)}
              className={btn}
              aria-pressed={mode === m}
              aria-label={full}
              title={full}
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {glyph}
              </svg>
              {label}
            </button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-rule" aria-hidden />
          <button type="button" disabled={!ready} onClick={clear} className={btn}>
            Clear
          </button>
        </div>
        {hint && (
          <span
            key={mode ?? 'none'}
            className="hint-in rounded-full bg-ink/80 px-2.5 py-1 text-[12px] font-medium text-paper backdrop-blur-md"
            aria-live="polite"
          >
            {hint}
          </span>
        )}
      </div>
    </div>
  )
}
