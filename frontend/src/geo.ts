// Small client-side geometry helpers for drawn boundaries. The server's checks are authoritative.
import type { Geometry } from './types'

export type BBox = [number, number, number, number]
type Ring = [number, number][]

/** Outer + hole rings of every polygon in a Polygon/MultiPolygon. */
function polygons(g: Geometry): Ring[][] {
  if (g.type === 'Polygon') return [g.coordinates as Ring[]]
  if (g.type === 'MultiPolygon') return g.coordinates as Ring[][]
  return []
}

export function geometryBounds(g: Geometry): BBox | null {
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity
  for (const poly of polygons(g))
    for (const ring of poly)
      for (const [x, y] of ring) {
        w = Math.min(w, x)
        s = Math.min(s, y)
        e = Math.max(e, x)
        n = Math.max(n, y)
      }
  return Number.isFinite(w) ? [w, s, e, n] : null
}

/** Area in km² by an equirectangular projection at the mean latitude (same formula as backend `_dist`). */
export function areaKm2(g: Geometry): number {
  const b = geometryBounds(g)
  if (!b) return 0
  const k = Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180) * 111320
  const ringArea = (r: Ring) => {
    let a = 0
    for (let i = 0; i < r.length - 1; i++) a += r[i][0] * k * (r[i + 1][1] * 110540) - r[i + 1][0] * k * (r[i][1] * 110540)
    return Math.abs(a) / 2
  }
  let m2 = 0
  for (const poly of polygons(g)) poly.forEach((r, i) => (m2 += i === 0 ? ringArea(r) : -ringArea(r)))
  return m2 / 1e6
}

/** Relation of a boundary to a bbox: fully inside, overlapping its edge, or outside. Uses the boundary's vertices and bounds. */
export function relationToBBox(g: Geometry, bbox: BBox): 'within' | 'crosses' | 'outside' {
  const b = geometryBounds(g)
  if (!b) return 'outside'
  const [w, s, e, n] = bbox
  if (b[0] >= w && b[1] >= s && b[2] <= e && b[3] <= n) return 'within'
  if (b[2] < w || b[0] > e || b[3] < s || b[1] > n) return 'outside'
  return 'crosses'
}
