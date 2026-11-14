import { usePlan } from '../state/PlanContext'
import { TargetScope } from './TargetBars'
import { fmtDelta, fmtNum } from '../format'
import FactorHover from './FactorHover'
import type { Scoreboard as SB } from '../types'

type NumKey = Exclude<keyof SB, 'walk_by_amenity_pct'>

const ITEMS: { key: NumKey; label: string; unit: string; digits: number; factors: string[] }[] = [
  { key: 'homes', label: 'Homes', unit: '', digits: 0, factors: ['avg_unit_sqft_residential', 'site_lot_coverage_ratio', 'newbuild_assumed_stories'] },
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

export default function Scoreboard() {
  const { state } = usePlan()
  const sb = state.scoreboard
  const prev = state.prevScoreboard
  if (!sb) {
    return (
      <div className="border border-rule bg-paper p-4 text-lg text-slate">
        {state.rescoreError ? `Scoreboard unavailable: ${state.rescoreError}` : 'Loading scoreboard…'}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-5 border border-ink bg-paper" role="region" aria-label="Scoreboard">
      {ITEMS.map((it) => (
        <div key={it.key} className="min-w-0 border-r border-rule px-3 pt-3">
          <FactorHover keys={it.factors}>
            <span className="text-[15px] whitespace-nowrap text-slate">{it.label}</span>
          </FactorHover>
          <div className="display text-4xl whitespace-nowrap tabular-nums">
            {fmtNum(sb[it.key], it.digits)}
            {it.unit && <span className="ml-1 text-xl font-normal text-slate">{it.unit}</span>}
          </div>
          {/* fixed-height row under the value so deltas never collide with the next stat */}
          <div className="flex h-7 items-baseline gap-2 whitespace-nowrap tabular-nums">
            {state.deltas[it.key] !== undefined && state.edits.length > 0 && (
              <span className="text-sm text-slate">vs base {fmtDelta(state.deltas[it.key], it.digits)}</span>
            )}
            <Delta prev={prev?.[it.key]} next={sb[it.key]} digits={it.digits} tick={state.scoreTick} />
          </div>
          {it.key === 'walk_access_pct' && sb.walk_by_amenity_pct && (
            <FactorHover keys={['walk_minutes_target', 'walk_speed_m_per_s']}>
              <span className="text-xs whitespace-nowrap text-slate tabular-nums">
                of new homes · {Object.entries(sb.walk_by_amenity_pct)
                  .map(([k, v]) => `${k} ${fmtNum(v, 0)}%`)
                  .join(' · ')}
              </span>
            </FactorHover>
          )}
        </div>
      ))}
      <div className="min-w-0 px-3 pt-3">
        <FactorHover keys={['cap_rate', 'debt_ratio', 'interest_rate', 'per_unit_credit_equity_usd', 'investor_equity_share']}>
          <span className="text-[15px] text-slate">Pencils?</span>
        </FactorHover>
        <div className="display text-4xl whitespace-nowrap tabular-nums">
          {sb.pencils_yes}
          <span className="text-xl font-normal text-slate">/{sb.pencils_total} sites</span>
        </div>
        <div className="flex h-7 items-baseline">
          <Delta prev={prev?.pencils_yes} next={sb.pencils_yes} digits={0} tick={state.scoreTick} />
        </div>
      </div>
      <TargetScope className="col-span-5 border-t border-rule px-4 py-1.5 text-sm" />
    </div>
  )
}
