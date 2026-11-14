// Display formatting only. No computation of plan numbers happens here.
import type { Geometry, LonLat, Parcel, Building } from './types'

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}k`
  return `${sign}$${a.toFixed(0)}`
}

/** Signed delta with a real minus sign, e.g. "+12" / "−48". */
export function fmtDelta(v: number, digits = 0): string {
  const r = Number(v.toFixed(digits))
  if (r === 0) return '±0'
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toLocaleString('en-US', { maximumFractionDigits: digits })}`
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return fmtNum(v, 2)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}

export const humanize = (s: string) => s.replace(/_/g, ' ')

const SOURCE_LABELS: Record<string, string> = {
  costar_fixture: 'CoStar (fixture)',
  costar: 'CoStar',
  matterport: 'Matterport',
  vexcel: 'Vexcel',
  county_parcels: 'county records',
  derived: 'derived',
  osm: 'OSM',
  fema: 'FEMA',
  gtfs: 'GTFS',
  corpus: 'corpus',
  census_lodes_acs: 'Census LODES/ACS',
  afdc: 'NREL AFDC',
  pvwatts: 'NREL PVWatts',
  fcc: 'FCC',
}

export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? humanize(source)

/** Rough centroid (vertex mean of the outer ring(s)) for label/marker placement only. */
export function geometryCentroid(g: Geometry | null | undefined): LonLat | null {
  if (!g) return null
  const pts: number[][] = []
  const walk = (c: unknown, depth: number) => {
    if (!Array.isArray(c)) return
    if (typeof c[0] === 'number') {
      pts.push(c as number[])
      return
    }
    // For polygons only take the outer ring.
    if (depth === 0 && g.type === 'Polygon') return walk(c[0], depth + 1)
    if (depth === 0 && g.type === 'MultiPolygon') return c.forEach((p) => Array.isArray(p) && walk(p[0], depth + 1))
    c.forEach((x) => walk(x, depth + 1))
  }
  if (g.type === 'GeometryCollection') {
    for (const sub of g.geometries ?? []) {
      const c = geometryCentroid(sub)
      if (c) return c
    }
    return null
  }
  walk(g.coordinates, 0)
  if (!pts.length) return null
  let x = 0
  let y = 0
  for (const p of pts) {
    x += p[0]
    y += p[1]
  }
  return [x / pts.length, y / pts.length]
}

/** Great-circle distance in metres (display/selection only). */
export function haversineM(a: LonLat, b: LonLat): number {
  const R = 6371008.8
  const toRad = Math.PI / 180
  const dLat = (b[1] - a[1]) * toRad
  const dLon = (b[0] - a[0]) * toRad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

export function parcelLabel(p: Parcel | undefined, id: string): string {
  return p?.address.value || `parcel ${id}`
}

export function buildingLabel(b: Building | undefined, id: string): string {
  return b?.name.value || `building ${id}`
}
