import { usePlan, statValue, type PlanState } from '../state/PlanContext'
import { fmtDelta, fmtNum, fmtUsd } from '../format'
import AnimatedNumber from './AnimatedNumber'
import FactorHover from './FactorHover'
import type { ScoreSnapshot, TargetKey, TargetScore } from '../types'

/** Targets where less is better (the bar reads as exposure, red when it misses the target). */
const LOWER_IS_BETTER: Partial<Record<TargetKey, true>> = { flood_exposure: true }

export const TARGET_LABELS: Record<TargetKey, string> = {
  transport_co2: 'Transport CO₂ avoided',
  embodied_co2_saved: 'Embodied carbon saved',
  rooftop_solar: 'Rooftop solar',
  walk_access: 'Walk access',
  flood_exposure: 'Flood exposure',
}

/** The plan as the map shows it (existing conditions + edits), as a snapshot; null before the first rescore. */
export function currentSnapshot(state: PlanState): ScoreSnapshot | null {
  if (!state.scoreboard) return null
  return { scoreboard: state.scoreboard, targets: state.current.targets ?? [] }
}

/**
 * Reference ticks on a bar: existing conditions (solid slate) and the agents' suggestion (dashed ink, labelled when
 * `labels`). `at` maps a value to its left offset in percent. Ticks glide when the scale changes.
 */
export function BarMarkers({
  existing,
  agents,
  at,
  labels = false,
}: {
  existing: number | null
  agents: number | null
  at: (v: number) => number
  labels?: boolean
}) {
  return (
    <>
      {existing !== null && (
        <span
          className="bar-move pointer-events-none absolute -inset-y-[3px] w-[2px] -translate-x-1/2 rounded-full bg-slate"
          style={{ left: `${at(existing)}%` }}
          title={`Existing ${fmtNum(existing, 1)}`}
        />
      )}
      {agents !== null && (
        <span
          className="bar-move pointer-events-none absolute -inset-y-[5px] -translate-x-1/2 border-l-[1.5px] border-dashed border-ink"
          style={{ left: `${at(agents)}%` }}
        >
          {labels && (
            <span className="absolute bottom-full left-0 -translate-x-1/2 pb-px text-[10px] leading-none font-semibold whitespace-nowrap text-ink">
              agents
            </span>
          )}
        </span>
      )}
    </>
  )
}

const clampPct = (v: number) => Math.min(100, Math.max(0, v))

/**
 * Targets and the scoreboard count every site in the plan (funded or on watch); reserve and passed sites are out.
 * `line`: one truncated line that stays even with no sites (the caller fixes its height), so whatever it heads never
 * changes height.
 */
export function TargetScope({ className = '', line = false }: { className?: string; line?: boolean }) {
  const { state } = usePlan()
  const inPlan = (state.current.sites ?? []).filter((s) => s.status === 'pursue' || s.status === 'watch')
  if (!inPlan.length) {
    return line ? <p className={`truncate text-slate ${className}`}>No sites in the plan yet</p> : null
  }
  const funded = new Set(inPlan.filter((s) => s.status === 'pursue').map((s) => s.id))
  const watch = inPlan.filter((s) => s.status === 'watch').length
  const required = (state.current.stacks ?? [])
    .filter((x) => funded.has(x.site_id))
    .reduce((a, x) => a + Math.max(x.funding_required_usd, 0), 0)
  const text = `Counts ${inPlan.length} sites in the plan (${watch} on watch: no price, or the owner will not sell) · funding required for the ${funded.size} funded sites ${fmtUsd(required)}`
  return (
    <p title={line ? text : undefined} className={`text-amber-200 ${line ? 'truncate' : ''} ${className}`}>
      {text}
    </p>
  )
}

/**
 * One target: shares of new homes on a true 0–100% scale; tonnes and MWh from 0 to the largest of this plan,
 * existing conditions and the agents' suggestion (with headroom). The fill is this plan, the slate tick existing
 * conditions, the dashed tick the agents' suggestion, the ink bar the target.
 */
function TargetBar({ t, existing, agents }: { t: TargetScore; existing: number | null; agents: number | null }) {
  const share = t.unit.startsWith('%')
  const lower = LOWER_IS_BETTER[t.key]
  const misses = t.target !== null && (lower ? t.value > t.target : t.value < t.target)
  const scale = share ? 100 : Math.max(Math.abs(t.value), Math.abs(existing ?? 0), Math.abs(agents ?? 0)) * 1.15
  if (!scale) return <div className="mt-2 h-2 rounded-full bg-rule/70" aria-hidden />
  const at = (v: number) => clampPct((v / scale) * 100)
  return (
    <div className="relative mt-2 h-2" aria-hidden>
      <div className="absolute inset-0 overflow-hidden rounded-full bg-rule/70">
        {share &&
          [25, 50, 75].map((q) => <span key={q} className="absolute inset-y-0 w-px bg-paper" style={{ left: `${q}%` }} />)}
        <span
          className={`bar-fill absolute inset-y-0 left-0 rounded-full ${misses ? 'bg-gap' : lower ? 'bg-slate' : 'bg-green'}`}
          style={{ width: `${at(t.value)}%` }}
        />
      </div>
      <BarMarkers existing={existing} agents={agents} at={at} />
      {t.target !== null && (
        <span className="bar-move absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${at(t.target)}%` }} />
      )}
    </div>
  )
}

/**
 * Each target of the plan as the map shows it (existing conditions + edits): value, the target, the difference to
 * the agents' suggestion, and a bar with existing/agents markers. `row` lays the targets side by side for the strip
 * along the bottom of the plan map.
 */
export default function TargetBars({ row = false }: { row?: boolean }) {
  const { state } = usePlan()
  const targets = state.current.targets
  if (!targets) {
    return (
      <p className="text-sm text-slate italic">
        {state.rescoreError ? `Targets unavailable: ${state.rescoreError}` : 'Scoring existing conditions…'}
      </p>
    )
  }
  return (
    <>
      <TargetScope line={row} className={row ? 'mb-1.5 h-4 text-xs leading-4' : 'mb-3 text-sm'} />
      <ul className={row ? 'grid grid-cols-5 divide-x divide-rule text-xs' : 'divide-y divide-rule text-sm'}>
        {targets.map((t) => {
          const lower = LOWER_IS_BETTER[t.key]
          const misses = t.target !== null && (lower ? t.value > t.target : t.value < t.target)
          const existing = statValue(state.existing, t.key)
          const agents = statValue(state.suggested, t.key)
          const vsAgents = agents === null ? 0 : Number((t.value - agents).toFixed(1))
          const vs = vsAgents !== 0 && (
            <span
              key={`${t.key}-${vsAgents}`}
              className={`hint-in font-normal ${row ? '' : 'ml-1'} ${(lower ? vsAgents < 0 : vsAgents > 0) ? 'text-green' : 'text-gap'}`}
            >
              ({fmtDelta(vsAgents, 1)} vs agents)
            </span>
          )
          return (
            <li key={t.key} data-stat={t.key} className={row ? 'min-w-0 px-2 first:pl-0 last:pr-0' : 'py-2'}>
              <FactorHover keys={t.factor_keys}>
                <span>{TARGET_LABELS[t.key]}</span>
              </FactorHover>
              {/* in the strip: value on one truncated line, the comparison on its own fixed-height line below */}
              <div className={`font-semibold tabular-nums ${misses ? 'text-gap' : ''} ${row ? 'truncate whitespace-nowrap' : ''}`}>
                <AnimatedNumber value={t.value} format={(v) => fmtNum(v, 1)} /> {t.unit}
                {t.target !== null && (
                  <span className="font-normal text-slate"> · {misses ? 'target' : 'meets target'} {fmtNum(t.target, 1)}</span>
                )}
                {!row && vs}
              </div>
              {row && <div className="h-4 truncate leading-4">{vs}</div>}
              <TargetBar t={t} existing={existing} agents={agents} />
            </li>
          )
        })}
      </ul>
    </>
  )
}
