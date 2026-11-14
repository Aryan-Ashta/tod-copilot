import { usePlan } from '../state/PlanContext'
import { fmtNum } from '../format'
import FactorHover from './FactorHover'
import type { TargetKey } from '../types'

export const TARGET_LABELS: Record<TargetKey, string> = {
  transport_co2: 'Transport CO₂ avoided',
  embodied_co2_saved: 'Embodied carbon saved',
  rooftop_solar: 'Rooftop solar',
  walk_access: 'Walk access',
  flood_exposure: 'Flood exposure',
}

/** Each target as a bar; the tick marks the base plan's value so edits show their effect. */
export default function TargetBars({ compact = false }: { compact?: boolean }) {
  const { state } = usePlan()
  const targets = state.plan.targets
  const base = new Map((state.basePlan?.targets ?? []).map((t) => [t.key, t.value]))
  if (!targets) return <p className="text-sm text-neutral-500 italic">Waiting for the sustainability agent…</p>
  return (
    <ul className={compact ? 'space-y-1.5' : 'space-y-3'}>
      {targets.map((t) => {
        const b = base.get(t.key) ?? t.value
        const max = Math.max(Math.abs(t.value), Math.abs(b))
        const pct = max > 0 ? (Math.abs(t.value) / max) * 100 : 0
        const basePct = max > 0 ? (Math.abs(b) / max) * 100 : 0
        const missesTarget = t.target !== null && t.key === 'flood_exposure' && t.value > t.target
        return (
          <li key={t.key} className="text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <FactorHover keys={t.factor_keys}>
                <span className="text-neutral-300">{TARGET_LABELS[t.key]}</span>
              </FactorHover>
              <span className={`tabular-nums ${missesTarget ? 'text-rose-300' : 'text-neutral-100'}`}>
                {fmtNum(t.value, 1)} {t.unit}
                {t.target !== null && <span className="text-neutral-500"> · target {fmtNum(t.target, 1)}</span>}
              </span>
            </div>
            <div className="relative mt-0.5 h-1.5 rounded bg-neutral-800">
              <div
                className={`h-full rounded transition-[width] duration-500 ${missesTarget ? 'bg-rose-500' : 'bg-emerald-500'}`}
                style={{ width: `${pct}%` }}
              />
              {state.edits.length > 0 && (
                <div className="absolute top-[-2px] h-2.5 w-px bg-white" style={{ left: `${basePct}%` }} title="base plan" />
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
