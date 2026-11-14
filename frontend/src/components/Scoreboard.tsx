import { usePlan } from '../state/PlanContext'
import { TargetScope } from './TargetBars'
import { fmtDelta, fmtNum, fmtUsd } from '../format'
import FactorHover from './FactorHover'
import type { Scoreboard as SB } from '../types'

type NumKey = Exclude<keyof SB, 'walk_by_amenity_pct' | 'funding_gap_usd'>

const ITEMS: { key: NumKey; label: string; unit: string; digits: number; factors: string[] }[] = [
  { key: 'homes', label: 'Homes', unit: '', digits: 0, factors: ['avg_unit_sqft_residential', 'site_lot_coverage_ratio', 'newbuild_assumed_stories'] },
  { key: 'affordable_homes', label: 'Affordable homes', unit: '', digits: 0, factors: ['affordable_share', 'affordable_rent_usd_per_unit_month'] },
  { key: 'walk_access_pct', label: 'Walk access', unit: '%', digits: 1, factors: ['walk_minutes_target', 'walk_speed_m_per_s', 'walk_detour_factor'] },
  {
    key: 'transport_co2_tonnes_per_year',
    label: 'Transport CO₂ avoided',
    unit: 't/yr',
    digits: 0,
    factors: ['co2_g_per_vehicle_mile', 'vmt_reduction_per_household_near_transit'],
  },
  {
    key: 'embodied_co2_saved_tonnes',
    label: 'Embodied carbon saved',
    unit: 't',
    digits: 0,
    factors: ['embodied_co2_kg_per_sqft_new', 'embodied_co2_kg_per_sqft_reuse'],
  },
]

function Delta({ prev, next, digits, tick }: { prev: number | undefined; next: number; digits: number; tick: number }) {
  if (prev === undefined) return null
  const d = next - prev
  if (Number(d.toFixed(digits)) === 0) return null
  return (
    <span key={tick} className={`delta-fade text-xl font-bold ${d > 0 ? 'text-emerald-300' : 'text-gap'}`}>
      {fmtDelta(d, digits)}
    </span>
  )
}

/** Meeting mode's bottom bar: the headline stats in a row, each with its change since the last edit. */
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
        {ITEMS.map((it) => (
          <div key={it.key} className="min-w-0 px-5 pt-2.5 pb-2">
            <div className="flex items-baseline justify-between gap-2 whitespace-nowrap">
              <FactorHover keys={it.factors}>
                <span className="text-[14px] text-slate">{it.label}</span>
              </FactorHover>
              {state.deltas[it.key] !== undefined && state.edits.length > 0 && (
                <span className="text-xs text-slate tabular-nums">vs base {fmtDelta(state.deltas[it.key], it.digits)}</span>
              )}
            </div>
            <div className="flex items-baseline gap-3 whitespace-nowrap tabular-nums">
              <span className="display text-[34px]">
                {fmtNum(sb[it.key], it.digits)}
                {it.unit && <span className="ml-1 text-lg font-normal text-slate">{it.unit}</span>}
              </span>
              <Delta prev={prev?.[it.key]} next={sb[it.key]} digits={it.digits} tick={state.scoreTick} />
            </div>
            {/* fixed-height row so the bar keeps its height */}
            <div className="h-5 truncate text-xs text-slate tabular-nums">
              {it.key === 'walk_access_pct' && sb.walk_by_amenity_pct && (
                <FactorHover keys={['walk_minutes_target', 'walk_speed_m_per_s']}>
                  <span>
                    of new homes ·{' '}
                    {Object.entries(sb.walk_by_amenity_pct)
                      .map(([k, v]) => `${k} ${fmtNum(v, 0)}%`)
                      .join(' · ')}
                  </span>
                </FactorHover>
              )}
            </div>
          </div>
        ))}
        <div className="min-w-0 px-5 pt-2.5 pb-2">
          <div className="flex items-baseline justify-between gap-2 whitespace-nowrap">
            <FactorHover keys={['cap_rate', 'debt_ratio', 'interest_rate', 'per_unit_credit_equity_usd', 'investor_equity_share']}>
              <span className="text-[14px] text-slate">Funding gap</span>
            </FactorHover>
            {state.deltas.funding_gap_usd !== undefined && state.edits.length > 0 && (
              <span className="text-xs text-slate tabular-nums">
                vs base {state.deltas.funding_gap_usd < 0 ? '−' : '+'}
                {fmtUsd(Math.abs(state.deltas.funding_gap_usd))}
              </span>
            )}
          </div>
          <div className="display text-[34px] whitespace-nowrap tabular-nums">{fmtUsd(sb.funding_gap_usd)}</div>
          <div className="h-5" />
        </div>
      </div>
      <TargetScope className="border-t border-rule px-5 py-1.5 text-sm" />
    </div>
  )
}
