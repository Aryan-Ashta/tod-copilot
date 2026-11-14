import { usePlan } from '../state/PlanContext'
import { fmtDelta, fmtNum, fmtUsd } from '../format'
import FactorHover from './FactorHover'
import type { TargetKey, TargetScore } from '../types'

/** Targets where less is better (the bar reads as exposure, red when it misses the target). */
const LOWER_IS_BETTER: Partial<Record<TargetKey, true>> = { flood_exposure: true }

/** Scoreboard fields whose base-plan deltas the rescore returns (backend/models/rescore.py), per target. */
const DELTA_KEY: Partial<Record<TargetKey, string>> = {
  transport_co2: 'transport_co2_tonnes_per_year',
  embodied_co2_saved: 'embodied_co2_saved_tonnes',
  walk_access: 'walk_access_pct',
}

const clampPct = (v: number) => Math.min(100, Math.max(0, v))

/**
 * A share of new homes on a true 0–100% scale: the fill is the value, an ink tick marks the target, a dashed tick
 * the base plan once something has been edited.
 */
function ShareGauge({ t, base }: { t: TargetScore; base: number | null }) {
  const lower = LOWER_IS_BETTER[t.key]
  const misses = t.target !== null && (lower ? t.value > t.target : t.value < t.target)
  return (
    <div className="relative mt-1.5 h-2 bg-rule/70" aria-hidden>
      {[25, 50, 75].map((q) => (
        <span key={q} className="absolute inset-y-0 w-px bg-paper" style={{ left: `${q}%` }} />
      ))}
      <span
        className={`absolute inset-y-0 left-0 ${misses ? 'bg-gap' : lower ? 'bg-slate' : 'bg-green'}`}
        style={{ width: `${clampPct(t.value)}%` }}
      />
      {base !== null && base !== t.value && (
        <span className="absolute -inset-y-1 border-l border-dashed border-ink" style={{ left: `${clampPct(base)}%` }} />
      )}
      {t.target !== null && <span className="absolute -inset-y-1 w-0.5 bg-ink" style={{ left: `calc(${clampPct(t.target)}% - 1px)` }} />}
    </div>
  )
}

// Base plan's position on the change bar; room to the right shows growth.
const BASE_AT = 2 / 3

/**
 * A quantity with no natural maximum (tonnes, MWh) gets no bar of its own: a full-height bar would claim a scale it
 * does not have. Once the plan is edited it gets a change bar instead: the dashed tick is the base plan, the fill
 * this plan, so growth runs right of the tick and loss stops short of it.
 */
function ChangeBar({ t, base }: { t: TargetScore; base: number }) {
  const share = Math.min(1, (t.value / base) * BASE_AT)
  const tone = t.value > base ? 'bg-green' : t.value < base ? 'bg-gap' : 'bg-slate'
  return (
    <div className="relative mt-1.5 h-2 bg-rule/70" aria-hidden>
      <span className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${share * 100}%` }} />
      <span className="absolute -inset-y-1 border-l border-dashed border-ink" style={{ left: `${BASE_AT * 100}%` }} />
    </div>
  )
}

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
  const required = (state.plan.stacks ?? [])
    .filter((x) => funded.has(x.site_id))
    .reduce((a, x) => a + Math.max(x.funding_required_usd, 0), 0)
  return (
    <p className={`text-amber-200 ${className}`}>
      Counts {inPlan.length} sites in the plan ({watch} on watch: no price, or the owner will not sell) · funding
      required for the {funded.size} funded sites {fmtUsd(required)}
    </p>
  )
}

/**
 * Each target with its value and a graphic only where the number has a scale: shares of new homes on a 0–100% gauge
 * with the target marked; tonnes and MWh as a change against the base plan once the plan has been edited.
 * `row` lays the targets side by side for the strip along the bottom of the plan map.
 */
export default function TargetBars({ row = false }: { row?: boolean }) {
  const { state } = usePlan()
  const targets = state.plan.targets
  const edited = state.edits.length > 0
  const base = new Map((state.basePlan?.targets ?? []).map((t) => [t.key, t.value]))
  if (!targets) return <p className="text-sm text-slate italic">Waiting for the sustainability agent…</p>
  return (
    <>
      <TargetScope className={row ? 'mb-1.5 text-xs' : 'mb-3 text-sm'} />
      <ul className={row ? 'grid grid-cols-5 divide-x divide-rule text-xs' : 'divide-y divide-rule text-sm'}>
        {targets.map((t) => {
          const b = edited ? base.get(t.key) ?? null : null
          const share = t.unit.startsWith('%')
          const lower = LOWER_IS_BETTER[t.key]
          const misses = t.target !== null && (lower ? t.value > t.target : t.value < t.target)
          const deltaKey = DELTA_KEY[t.key]
          const delta = edited && deltaKey ? state.deltas[deltaKey] : undefined
          return (
            <li key={t.key} className={row ? 'px-2 first:pl-0 last:pr-0' : 'py-2'}>
              <FactorHover keys={t.factor_keys}>
                <span>{TARGET_LABELS[t.key]}</span>
              </FactorHover>
              <div className={`font-semibold tabular-nums ${misses ? 'text-gap' : ''}`}>
                {fmtNum(t.value, 1)} {t.unit}
                {t.target !== null && (
                  <span className="font-normal text-slate"> · {misses ? 'target' : 'meets target'} {fmtNum(t.target, 1)}</span>
                )}
                {delta !== undefined && <span className="ml-1 font-normal text-slate">({fmtDelta(delta, 1)} vs base)</span>}
              </div>
              {share ? <ShareGauge t={t} base={b} /> : b !== null && b > 0 && <ChangeBar t={t} base={b} />}
            </li>
          )
        })}
      </ul>
    </>
  )
}
