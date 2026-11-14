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

/** Outer-ring vertices of every polygon (holes lie inside them), for framing a boundary on screen. */
export function boundaryPoints(g: Geometry): Ring {
  return polygons(g).flatMap((poly) => poly[0] ?? [])
}

/** The first polygon's outer ring (a footprint's outline), or null for non-polygons. */
export function outerRing(g: Geometry): Ring | null {
  return polygons(g)[0]?.[0] ?? null
}
