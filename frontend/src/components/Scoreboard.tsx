import { usePlan, statValue, lastStatChange, type ScoreKey, type StatKey } from '../state/PlanContext'
import { TARGET_LABELS, TargetScope } from './TargetBars'
import { fmtDelta, fmtNum, fmtUsd } from '../format'
import AnimatedNumber from './AnimatedNumber'
import FactorHover from './FactorHover'

/** How a stat reads: label, unit, decimals, the factors behind it, and which way is better. */
export interface StatMeta {
  key: StatKey
  label: string
  /** Noun after a signed change in history chips: "+48 homes", "+3.2 pts walk", "−$1.2M funding". */
  short: string
  unit: string
  digits: number
  factors: string[]
  /** Lower is better (a rise is drawn red). */
  lower?: boolean
  /** On a 0–100 scale. */
  pct?: boolean
  usd?: boolean
}

/** Scoreboard stats, then the targets the scoreboard does not already carry. Target factors come with the snapshot. */
export const STAT_META: StatMeta[] = [
  { key: 'homes', label: 'Homes', short: 'homes', unit: '', digits: 0, factors: ['avg_unit_sqft_residential', 'site_lot_coverage_ratio', 'newbuild_assumed_stories'] },
  { key: 'affordable_homes', label: 'Affordable homes', short: 'affordable', unit: '', digits: 0, factors: ['affordable_share', 'affordable_rent_usd_per_unit_month'] },
  { key: 'walk_access_pct', label: 'Walk access', short: 'pts walk', unit: '%', digits: 1, pct: true, factors: ['walk_minutes_target', 'walk_speed_m_per_s', 'walk_detour_factor'] },
  {
    key: 'transport_co2_tonnes_per_year',
    label: 'Transport CO₂ avoided',
    short: 't/yr CO₂ avoided',
    unit: 't/yr',
    digits: 0,
    factors: ['co2_g_per_vehicle_mile', 'vmt_reduction_per_household_near_transit'],
  },
  {
    key: 'embodied_co2_saved_tonnes',
    label: 'Embodied carbon saved',
    short: 't embodied CO₂ saved',
    unit: 't',
    digits: 0,
    factors: ['embodied_co2_kg_per_sqft_new', 'embodied_co2_kg_per_sqft_reuse'],
  },
  {
    key: 'funding_required_usd',
    label: 'Funding required',
    short: 'funding',
    unit: '',
    digits: 0,
    usd: true,
    lower: true,
    factors: ['cap_rate', 'debt_ratio', 'interest_rate', 'per_unit_credit_equity_usd', 'investor_equity_share'],
  },
  { key: 'rooftop_solar', label: TARGET_LABELS.rooftop_solar, short: 'MWh/yr solar', unit: 'MWh/yr', digits: 1, factors: [] },
  { key: 'flood_exposure', label: TARGET_LABELS.flood_exposure, short: 'pts flood', unit: '%', digits: 1, pct: true, lower: true, factors: [] },
]

export const fmtStat = (m: StatMeta, v: number) => (m.usd ? fmtUsd(v) : fmtNum(v, m.digits))

export const fmtStatDelta = (m: StatMeta, d: number) =>
  m.usd ? `${d < 0 ? '−' : '+'}${fmtUsd(Math.abs(d))}` : fmtDelta(d, m.digits)

/** Whether a change survives the display rounding (USD: a whole dollar). */
export const deltaShown = (m: StatMeta, d: number) => (m.usd ? Math.abs(d) >= 1 : Number(d.toFixed(m.digits)) !== 0)

export const deltaGood = (m: StatMeta, d: number) => (m.lower ? d < 0 : d > 0)

/** Text colour for a stat the latest change moved: green when it got better, red when worse; none when it stayed. */
export const statTone = (m: StatMeta, d: number | null) =>
  d === null || !deltaShown(m, d) ? '' : deltaGood(m, d) ? 'text-green' : 'text-gap'

const SCORE_META = STAT_META.slice(0, 6) as (StatMeta & { key: ScoreKey })[]

/** Edit mode's bottom bar: the headline stats in a row, each with its change since the last edit and its
 *  difference to the agents' suggestion. */
export default function Scoreboard() {
  const { state } = usePlan()
  const sb = state.scoreboard
  const prev = state.prevScoreboard
  if (!sb) {
    return (
      <div className="px-6 py-4 text-lg text-slate">
        {state.rescoreError ? `Scoreboard unavailable: ${state.rescoreError}` : 'Loading scoreboard…'}
      </div>
    )
  }
  return (
    <div role="region" aria-label="Scoreboard">
      <div className="grid grid-cols-6 divide-x divide-rule">
        {SCORE_META.map((m) => {
          const v = sb[m.key]
          const agents = statValue(state.suggested, m.key)
          const vsAgents = agents === null ? null : v - agents
          const change = prev ? v - prev[m.key] : 0
          return (
            <div key={m.key} data-stat={m.key} className="min-w-0 px-5 pt-2.5 pb-2">
              <div className="truncate whitespace-nowrap">
                <FactorHover keys={m.factors}>
                  <span className="text-[14px] text-slate">{m.label}</span>
                </FactorHover>
              </div>
              <div className="flex items-baseline gap-3 whitespace-nowrap">
                <span className={`display text-[34px] transition-colors duration-500 ${statTone(m, lastStatChange(state, m.key))}`}>
                  <AnimatedNumber value={v} format={(n) => fmtStat(m, n)} />
                  {m.unit && <span className="ml-1 text-lg font-normal text-slate">{m.unit}</span>}
                </span>
                {deltaShown(m, change) && (
                  <span
                    key={state.scoreTick}
                    className={`delta-fade text-xl font-bold tabular-nums ${deltaGood(m, change) ? 'text-green' : 'text-gap'}`}
                  >
                    {fmtStatDelta(m, change)}
                  </span>
                )}
              </div>
              {/* fixed-height rows so the bar keeps its height in every state */}
              <div className="h-4 truncate text-xs leading-4 text-slate tabular-nums">
                {vsAgents !== null && (
                  <span key={`${m.key}-${state.scoreTick}`} className="hint-in inline-block">
                    {deltaShown(m, vsAgents) ? `vs agents ${fmtStatDelta(m, vsAgents)}` : 'as agents'}
                  </span>
                )}
              </div>
              <div className="h-5 truncate text-xs text-slate tabular-nums">
                {m.key === 'walk_access_pct' && sb.walk_by_amenity_pct && (
                  <FactorHover keys={['walk_minutes_target', 'walk_speed_m_per_s']}>
                    <span>
                      of new homes ·{' '}
                      {Object.entries(sb.walk_by_amenity_pct)
                        .map(([k, n]) => `${k} ${fmtNum(n, 0)}%`)
                        .join(' · ')}
                    </span>
                  </FactorHover>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <TargetScope className="border-t border-rule px-5 py-1.5 text-sm" />
    </div>
  )
}
