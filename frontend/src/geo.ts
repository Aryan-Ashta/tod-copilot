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
