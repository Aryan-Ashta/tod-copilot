// Click-twice tiles in meeting mode: which parcels or buildings an armed tile can land on. Mirrors the checks the
// backend makes when it applies a place_tile edit (backend/models/rescore.py `_apply`), so the map highlights only
// targets the rescore will accept. The server stays authoritative; this only decides what to highlight.
import { TILES } from './components/TileTray'
import type { Plan, TileKind } from './types'

/** What a tile is placed on: a parcel (Homes, Park, Stop) or a building (conversions). */
export const toolTarget = (tool: TileKind): 'parcel' | 'building' => TILES.find((t) => t.kind === tool)?.target ?? 'parcel'

const CONVERT_USE = { convert_residential: 'residential', convert_hotel: 'hotel' } as const

/** Parcel ids (Homes, Park, Stop) or building ids (conversions) the tile can be placed on. */
export function validTargets(plan: Partial<Plan>, tool: TileKind): Set<string> {
  const out = new Set<string>()
  const pre = plan.precomputed
  if (tool === 'convert_residential' || tool === 'convert_hotel') {
    const use = CONVERT_USE[tool]
    const buildings = new Set((plan.buildings ?? []).map((b) => b.id))
    for (const c of plan.conversions ?? []) {
      if (buildings.has(c.building_id) && (c.scores_by_use[use]?.legal ?? 0) > 0) out.add(c.building_id)
    }
    return out
  }
  for (const p of plan.parcels ?? []) {
    if (tool === 'park') out.add(p.id)
    else if (tool === 'stop') {
      if (pre?.centroid[p.id]) out.add(p.id)
    } else if ((pre?.homes_by_parcel[p.id] ?? 0) > 0 && !pre?.in_flood[p.id]) out.add(p.id)
  }
  return out
}
