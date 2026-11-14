// Overlapping building footprints, resolved for drawing. The building sources overlap: OSM maps a building and its
// parts (or a podium and its tower) as separate outlines, and two records can describe one building. Extruded on the
// map, coplanar roofs and walls z-fight (striped faces). Each building keeps only the part of its footprint that a
// higher-ranked building does not already cover; a building left with almost nothing is a duplicate and is not drawn.
// Display only: the plan's buildings, scores and counts are unchanged.
import { difference, type MultiPolygon, type Polygon } from 'polygon-clipping'
import type { Building, ConversionCandidate, Geometry } from './types'

/** A building left with less than this share of its own footprint is a duplicate of what covers it. */
const MIN_KEEP_SHARE = 0.2
/** Leftover pieces smaller than this share of the original are slivers from near-coincident edges. */
const MIN_PIECE_SHARE = 0.02

type BBox = [number, number, number, number]

function polygonsOf(g: Geometry): MultiPolygon {
  if (g.type === 'Polygon') return [g.coordinates as Polygon]
  if (g.type === 'MultiPolygon') return g.coordinates as MultiPolygon
  return []
}

const ringArea = (r: [number, number][]) => {
  let a = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1])
  return Math.abs(a) / 2
}
// degrees²: only ever compared as ratios within one building
const polygonArea = (p: Polygon) => ringArea(p[0]) - p.slice(1).reduce((s, h) => s + ringArea(h), 0)
const area = (m: MultiPolygon) => m.reduce((s, p) => s + polygonArea(p), 0)

function bboxOf(m: MultiPolygon): BBox {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const p of m) for (const [x, y] of p[0]) [w, s, e, n] = [Math.min(w, x), Math.min(s, y), Math.max(e, x), Math.max(n, y)]
  return [w, s, e, n]
}
const touches = (a: BBox, b: BBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
// Fields the CoStar extract fills for a building; one sourced from CoStar marks a CoStar building record.
const COSTAR_FIELDS = ['property_type', 'building_class', 'rentable_area_sqft', 'stories', 'name'] as const
const isCostar = (b: Building) => COSTAR_FIELDS.some((k) => b[k].prov.source === 'costar')

/**
 * Who keeps a contested footprint: CoStar buildings first (the licensed record is the authoritative one), then
 * conversion candidates with a use change (by overall score), then other scored candidates, then named buildings,
 * then taller ones; id last so the result never depends on input order.
 */
function rankKey(b: Building, c: ConversionCandidate | undefined): (number | string)[] {
  const tier = c && c.best_use !== 'keep_current' ? 0 : c ? 1 : 2
  return [isCostar(b) ? 0 : 1, tier, -(c?.overall ?? 0), b.name.value ? 0 : 1, -(b.stories.value ?? 0), b.id]
}
function compareKeys(a: (number | string)[], b: (number | string)[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  return 0
}

/** Footprint polygons to draw per building id; a building missing from the map is a duplicate and not drawn. */
export function separateFootprints(buildings: Building[], conversions: ConversionCandidate[]): Map<string, MultiPolygon> {
  const conv = new Map(conversions.map((c) => [c.building_id, c]))
  const ranked = buildings
    .map((b) => ({ b, key: rankKey(b, conv.get(b.id)), shape: polygonsOf(b.footprint) }))
    .sort((x, y) => compareKeys(x.key, y.key))
  const kept: { shape: MultiPolygon; box: BBox }[] = []
  const out = new Map<string, MultiPolygon>()
  for (const { b, shape } of ranked) {
    if (!shape.length) continue
    const box = bboxOf(shape)
    const over = kept.filter((k) => touches(box, k.box)).map((k) => k.shape)
    let mine = shape
    if (over.length) {
      try {
        const own = area(shape)
        const left = difference(shape, ...over).filter((p) => polygonArea(p) >= own * MIN_PIECE_SHARE)
        if (area(left) < own * MIN_KEEP_SHARE) continue
        mine = left
      } catch {
        // a degenerate outline the clipper rejects: draw it whole rather than lose it
      }
    }
    out.set(b.id, mine)
    kept.push({ shape: mine, box })
  }
  return out
}
