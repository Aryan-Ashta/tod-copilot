import { useEffect, useRef, useState } from 'react'
import { Map as MlMap, Marker, NavigationControl, type GeoJSONSource } from 'maplibre-gl'
import { TerraDraw, TerraDrawFreehandLineStringMode, TerraDrawPolygonMode, TerraDrawRectangleMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { metros } from '../api'
import { BASE_STYLE } from './MapView'
import { localeColor, localeShortName } from './LocalePosters'
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
// Above this zoom the reader is looking at one area; city labels would only sit on top of it.
const CITY_MAX_ZOOM = 9

interface City {
  name: string
  lonlat: [number, number]
}

function localeOutlines(locales: Locale[], selected: string | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: locales.map((l) => {
      const [w, s, e, n] = l.bbox
      return {
        type: 'Feature',
        properties: { id: l.id, color: localeColor(l.id), width: l.id === selected ? 2.5 : 1.5, fill: l.id === selected ? 0.1 : 0.05 },
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
  // Re-places the city labels after the area pins change (set by the city effect).
  const relayoutCities = useRef<() => void>(() => {})
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
      bounds: US_VIEW,
      maxBounds: US_LIMIT,
      renderWorldCopies: false,
      attributionControl: { compact: true },
    })
    // Offline: tile fetches fail; keep them silent.
    map.on('error', () => {})
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-left')
    map.on('load', () => {
      // State lines (US Census cartographic boundaries; scripts/build_us_reference.py), under everything else.
      map.addSource('states', { type: 'geojson', data: '/geo/us-states.geojson', attribution: 'States and cities: US Census Bureau' })
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
      // Supported counties (thin grey) and their principal cities (dashed, brighter), under the recorded boxes.
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
      draw.start()
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

  // Outlines plus one HTML pin per recorded area at its centre (the base style has no glyphs for symbol layers).
  // Clicking a pin selects that area, but only while nothing is drawn or being drawn.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    ;(map.getSource('locales') as GeoJSONSource | undefined)?.setData(localeOutlines(locales, selectedLocale))
    const markers = locales.map((l) => {
      const on = l.id === selectedLocale
      const color = localeColor(l.id)
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'flex items-center gap-2 cursor-pointer'
      el.style.zIndex = '2' // above the city markers
      el.dataset.areaPin = ''
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
      name.textContent = localeShortName(l)
      el.append(dot, name)
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const draw = drawRef.current
        if (!draw || draw.getMode() !== 'static' || draw.getSnapshot().length > 0) return
        onLocaleRef.current(l.id)
      })
      const [w, s, e, n] = l.bbox
      return new Marker({ element: el, anchor: 'left', offset: [-7, 0] }).setLngLat([(w + e) / 2, (s + n) / 2]).addTo(map)
    })
    relayoutCities.current()
    return () => markers.forEach((m) => m.remove())
  }, [locales, selectedLocale, ready])

  // Each state's most populous city: a dot always, its name only where it fits. Bigger cities claim space first, and
  // the area pins' labels are already taken. Hidden past CITY_MAX_ZOOM.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    let markers: { marker: Marker; label: HTMLElement }[] = []
    let frame = 0
    let live = true
    const layout = () => {
      frame = 0
      const box = map.getContainer().getBoundingClientRect()
      const show = map.getZoom() < CITY_MAX_ZOOM
      const taken = [...map.getContainer().querySelectorAll('[data-area-pin]')].map((el) => el.getBoundingClientRect())
      for (const { marker, label } of markers) {
        marker.getElement().style.display = show ? '' : 'none'
        if (!show) continue
        const r = label.getBoundingClientRect()
        const inside = r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom
        const fits = inside && !taken.some((t) => r.left < t.right + 3 && r.right > t.left - 3 && r.top < t.bottom + 3 && r.bottom > t.top - 3)
        label.style.visibility = fits ? 'visible' : 'hidden'
        if (fits) taken.push(r)
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(layout)
    }
    relayoutCities.current = schedule
    fetch('/geo/us-largest-cities.json')
      .then((r) => r.json() as Promise<{ cities: City[] }>)
      .then(({ cities }) => {
        if (!live) return
        markers = cities.map((c) => {
          const el = document.createElement('div')
          el.className = 'pointer-events-none flex items-center gap-1'
          const dot = document.createElement('span')
          dot.className = 'block h-1.5 w-1.5 shrink-0 rounded-full bg-ink ring-2 ring-paper'
          const label = document.createElement('span')
          label.className = 'text-[11.5px] font-semibold whitespace-nowrap text-ink/80 [text-shadow:0_0_3px_#EDEFEA,0_0_3px_#EDEFEA,0_0_6px_#EDEFEA]'
          label.textContent = c.name
          el.append(dot, label)
          return { marker: new Marker({ element: el, anchor: 'left', offset: [-3, 0] }).setLngLat(c.lonlat).addTo(map), label }
        })
        layout()
      })
      .catch(() => {
        // reference labels are a guide only
      })
    map.on('move', schedule)
    return () => {
      live = false
      cancelAnimationFrame(frame)
      map.off('move', schedule)
      relayoutCities.current = () => {}
      markers.forEach((m) => m.marker.remove())
    }
  }, [ready])

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
    drawRef.current?.setMode(m === 'freehand' ? 'freehand-linestring' : m)
    setMode(m)
  }
  const clear = () => {
    drawRef.current?.clear()
    drawRef.current?.setMode('static')
    setMode(null)
    onBoundary(null)
  }

  const btn = 'ctl px-3 py-1 text-[13px]'
  const hint =
    mode === 'freehand'
      ? 'Press and drag around the area; release to close it'
      : mode === 'polygon'
        ? 'Click to add corners; click the first corner to finish'
        : mode === 'rectangle'
          ? 'Press and drag across the map; release to finish'
          : 'Pick a pin, or draw your own area'

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-rule bg-paper px-3 py-2.5">
        {(
          [
            ['freehand', 'Draw freehand'],
            ['rectangle', 'Draw rectangle'],
            ['polygon', 'Draw polygon'],
          ] as const
        ).map(([m, label]) => (
          <button key={m} type="button" disabled={!ready} onClick={() => startMode(m)} className={btn} aria-pressed={mode === m}>
            {label}
          </button>
        ))}
        <button type="button" disabled={!ready} onClick={clear} className={btn}>
          Clear
        </button>
        <span className={`ml-auto text-[13px] ${mode ? 'font-semibold text-ink' : 'text-slate'}`} aria-live="polite">
          {hint}
        </span>
      </div>
      <div ref={containerRef} className="h-[420px] w-full" />
    </div>
  )
}
