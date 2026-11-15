import type { Plan } from './types'

/** Up to 3 addressed parcels where 2+ paths are eligible with different homes: the less often recommended path
 *  first (the surprising pick), then the building's best reuse score, then the larger homes gain. Plan data only. */
export function bothLawExamples(plan: Partial<Plan>): { id: string; label: string; at: [number, number] }[] {
  const envs = plan.envelopes ?? []
  const centroid = plan.precomputed?.centroid ?? {}
  const parcels = new Map((plan.parcels ?? []).map((p) => [p.id, p]))
  const recCount = new Map<string, number>()
  for (const e of envs) if (e.recommended_path) recCount.set(e.recommended_path, (recCount.get(e.recommended_path) ?? 0) + 1)
  const reuseScore = new Map<string, number>()
  const parcelOf = new Map((plan.buildings ?? []).map((b) => [b.id, b.parcel_id]))
  for (const c of plan.conversions ?? []) {
    const pid = parcelOf.get(c.building_id)
    if (pid) reuseScore.set(pid, Math.max(reuseScore.get(pid) ?? 0, c.overall))
  }
  return envs
    .flatMap((e) => {
      const el = e.paths.filter((p) => p.eligible && p.homes != null)
      const homes = el.map((p) => p.homes as number)
      const addr = parcels.get(e.parcel_id)?.address.value
      const at = centroid[e.parcel_id]
      if (el.length < 2 || new Set(homes).size < 2 || !e.recommended_path || !addr || !at) return []
      return [{ id: e.parcel_id, label: addr, at, rarity: recCount.get(e.recommended_path) ?? 0,
                score: reuseScore.get(e.parcel_id) ?? 0, gain: Math.max(...homes) - Math.min(...homes) }]
    })
    .sort((a, b) => a.rarity - b.rarity || b.score - a.score || b.gain - a.gain)
    .slice(0, 3)
}
