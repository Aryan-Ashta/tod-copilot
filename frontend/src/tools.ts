// Click-twice tiles in edit mode: which parcels or buildings an armed tile can land on. Mirrors the checks the
// backend makes when it applies a place_tile edit (backend/models/rescore.py `_apply`), so the map highlights only
// targets the rescore will accept, and leaves out targets the tile would not change: a park on a park, a stop where
// a stop already stands, homes where the plan already builds them, a conversion to the use the building already has.
// The server stays authoritative; this only decides what to highlight.
import { TILES } from './components/TileTray'
import { outerRing, pointInRing } from './geo'
import type { InfraFeature, Plan, TileKind } from './types'

/** What a tile is placed on: a parcel (Homes, Park, Stop) or a building (conversions). */
export const toolTarget = (tool: TileKind): 'parcel' | 'building' => TILES.find((t) => t.kind === tool)?.target ?? 'parcel'

const CONVERT_USE = { convert_residential: 'residential', convert_hotel: 'hotel' } as const

const inPlan = (status: string) => status === 'pursue' || status === 'watch'

/**
 * Parcel ids (Homes, Park, Stop) or building ids (conversions) the tile can be placed on. `parksAdded`: proposed parks
 * from the rescore (they are not in `plan.infrastructure`).
 */
export function validTargets(plan: Partial<Plan>, tool: TileKind, parksAdded: InfraFeature[] = []): Set<string> {
  const out = new Set<string>()
  const pre = plan.precomputed
  const sites = (plan.sites ?? []).filter((s) => inPlan(s.status))
  if (tool === 'convert_residential' || tool === 'convert_hotel') {
    const use = CONVERT_USE[tool]
    const buildings = new Map((plan.buildings ?? []).map((b) => [b.id, b]))
    const converted = new Set(sites.filter((s) => s.kind === 'conversion' && s.building_id).map((s) => s.building_id!))
    for (const c of plan.conversions ?? []) {
      const b = buildings.get(c.building_id)
      if (!b || (c.scores_by_use[use]?.legal ?? 0) <= 0) continue
      // already that use, as it stands or as the plan converts it
      if (b.property_type.value === use || (converted.has(c.building_id) && c.best_use === use)) continue
      out.add(c.building_id)
    }
    return out
  }
  const centroid = pre?.centroid ?? {}
  if (tool === 'homes') {
    const built = new Set(sites.filter((s) => s.kind === 'new_build').flatMap((s) => s.parcel_ids))
    for (const p of plan.parcels ?? []) {
      if ((pre?.homes_by_parcel[p.id] ?? 0) > 0 && !pre?.in_flood[p.id] && !built.has(p.id)) out.add(p.id)
    }
    return out
  }
  if (tool === 'park') {
    const proposed = new Set(parksAdded.map((f) => f.attrs.parcel_id).filter((id): id is string => typeof id === 'string'))
    const parkRings = (plan.infrastructure ?? [])
      .filter((f) => f.kind === 'park')
      .map((f) => outerRing(f.geometry))
      .filter((r): r is [number, number][] => !!r && r.length > 2)
    for (const p of plan.parcels ?? []) {
      const c = centroid[p.id]
      if (proposed.has(p.id) || (c && parkRings.some((r) => pointInRing(c, r)))) continue
      out.add(p.id)
    }
    return out
  }
  // stop: a parcel with a location and no stop of the plan standing on it
  const stops = (plan.transit?.stops ?? []).map((s) => s.lonlat)
  for (const p of plan.parcels ?? []) {
    if (!centroid[p.id]) continue
    const ring = outerRing(p.geometry)
    if (ring && stops.some((s) => pointInRing(s, ring))) continue
    out.add(p.id)
  }
  return out
}
