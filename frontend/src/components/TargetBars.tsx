import { memo } from 'react'
import { usePlan } from '../state/PlanContext'
import { fmtNum, fmtUsd } from '../format'
import FactorHover from './FactorHover'
import { IsoBox, IsoGhost, ISO, isoViewBox } from '../iso'
import type { TargetKey } from '../types'

// One small iso column per target: height 0-30 world units for 0-100% of max(value, base), the base plan as a
// dashed ghost column. Columns keep each row short enough for the panel (a bar along x would run diagonally).
const COL = 9
const COL_H = 30
const COL_VB = isoViewBox([{ x: 0, y: 0, w: COL, d: COL, h: COL_H }], 2)
const IsoColumn = memo(function IsoColumn({ pct, basePct, color, label }: { pct: number; basePct: number | null; color: string; label: string }) {
  return (
    <svg viewBox={COL_VB} className="block h-11 w-auto shrink-0" role="img" aria-label={label}>
      <IsoBox x={0} y={0} w={COL} d={COL} h={0.01} color={ISO.rule} stroke={false} shadow={false} />
      {pct > 0 && <IsoBox x={0} y={0} w={COL} d={COL} h={(Math.max(pct, 2) / 100) * COL_H} color={color} sw={0.5} />}
      {basePct !== null && basePct !== pct && <IsoGhost x={0} y={0} w={COL} d={COL} h={(Math.max(basePct, 2) / 100) * COL_H} sw={0.5} />}
    </svg>
  )
})

export const TARGET_LABELS: Record<TargetKey, string> = {
  transport_co2: 'Transport CO₂ avoided',
  embodied_co2_saved: 'Embodied carbon saved',
  rooftop_solar: 'Rooftop solar',
  walk_access: 'Walk access',
  flood_exposure: 'Flood exposure',
}

/** Targets and the scoreboard count every site in the plan (funded or on watch); reserve and passed sites are out. */
export function TargetScope({ className = '' }: { className?: string }) {
  const { state } = usePlan()
  const inPlan = (state.plan.sites ?? []).filter((s) => s.status === 'pursue' || s.status === 'watch')
  if (!inPlan.length) return null
  const funded = new Set(inPlan.filter((s) => s.status === 'pursue').map((s) => s.id))
  const watch = inPlan.filter((s) => s.status === 'watch').length
  const gap = (state.plan.stacks ?? [])
    .filter((x) => funded.has(x.site_id))
    .reduce((a, x) => a + Math.max(x.gap_usd, 0), 0)
  return (
    <p className={`text-amber-200 ${className}`}>
      Counts {inPlan.length} sites in the plan ({watch} on watch: no price, or the owner will not sell) · funding gap of
      the {funded.size} funded sites {fmtUsd(gap)}
    </p>
  )
}

/**
 * Each target as a small iso bar with a direct label; with edits, the base plan shows as a dashed ghost bar.
 * `row` lays the targets side by side for the strip along the bottom of the plan map.
 */
export default function TargetBars({ row = false }: { row?: boolean }) {
  const { state } = usePlan()
  const targets = state.plan.targets
  const base = new Map((state.basePlan?.targets ?? []).map((t) => [t.key, t.value]))
  if (!targets) return <p className="text-sm text-slate italic">Waiting for the sustainability agent…</p>
  return (
    <>
      <TargetScope className={row ? 'mb-1.5 text-xs' : 'mb-3 text-sm'} />
      <ul className={row ? 'grid grid-cols-5 divide-x divide-rule text-xs' : 'divide-y divide-rule text-sm'}>
        {targets.map((t) => {
          const b = base.get(t.key) ?? t.value
          const max = Math.max(Math.abs(t.value), Math.abs(b))
          const pct = max > 0 ? (Math.abs(t.value) / max) * 100 : 0
          const basePct = max > 0 ? (Math.abs(b) / max) * 100 : 0
          const missesTarget = t.target !== null && t.key === 'flood_exposure' && t.value > t.target
          const value = `${fmtNum(t.value, 1)} ${t.unit}`
          return (
            <li key={t.key} className={`flex items-end ${row ? 'gap-2 px-2 first:pl-0 last:pr-0' : 'gap-3 py-2'}`}>
              <IsoColumn
                pct={pct}
                basePct={state.edits.length > 0 ? basePct : null}
                color={missesTarget ? ISO.gap : ISO.green}
                label={`${TARGET_LABELS[t.key]}: ${value}`}
              />
              <div className="min-w-0 flex-1 pb-0.5">
                <FactorHover keys={t.factor_keys}>
                  <span>{TARGET_LABELS[t.key]}</span>
                </FactorHover>
                <div className={`font-semibold tabular-nums ${missesTarget ? 'text-gap' : ''}`}>
                  {value}
                  {t.target !== null && <span className="font-normal text-slate"> · target {fmtNum(t.target, 1)}</span>}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )
}
