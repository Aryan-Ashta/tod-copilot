import { usePlan } from '../state/PlanContext'
import { fmtDelta, fmtNum } from '../format'
import FactorHover from './FactorHover'
import type { Scoreboard as SB } from '../types'

const ITEMS: { key: keyof SB; label: string; unit: string; digits: number; factors: string[] }[] = [
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
    <span key={tick} className={`delta-fade ml-2 text-2xl font-semibold ${d > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
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
      <div className="rounded-lg border border-neutral-800 bg-neutral-950/90 p-4 text-lg text-neutral-400">
        {state.rescoreError ? `Scoreboard unavailable: ${state.rescoreError}` : 'Loading scoreboard…'}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-5 gap-3 rounded-lg border border-neutral-800 bg-neutral-950/90 p-4 shadow-xl backdrop-blur">
      {ITEMS.map((it) => (
        <div key={it.key}>
          <FactorHover keys={it.factors}>
            <span className="text-base text-neutral-400">{it.label}</span>
          </FactorHover>
          <div className="flex items-baseline">
            <span className="text-4xl font-bold tabular-nums">
              {fmtNum(sb[it.key], it.digits)}
              {it.unit && <span className="ml-1 text-xl font-normal text-neutral-400">{it.unit}</span>}
            </span>
            <Delta prev={prev?.[it.key]} next={sb[it.key]} digits={it.digits} tick={state.scoreTick} />
          </div>
          {state.deltas[it.key] !== undefined && state.edits.length > 0 && (
            <div className="text-sm text-neutral-500 tabular-nums">vs base {fmtDelta(state.deltas[it.key], it.digits)}</div>
          )}
        </div>
      ))}
      <div>
        <FactorHover keys={['cap_rate', 'debt_ratio', 'interest_rate', 'per_unit_credit_equity_usd', 'investor_equity_share']}>
          <span className="text-base text-neutral-400">Pencils?</span>
        </FactorHover>
        <div className="flex items-baseline">
          <span className="text-4xl font-bold tabular-nums">
            {sb.pencils_yes}
            <span className="text-xl font-normal text-neutral-400">/{sb.pencils_total} sites</span>
          </span>
          <Delta prev={prev?.pencils_yes} next={sb.pencils_yes} digits={0} tick={state.scoreTick} />
        </div>
      </div>
    </div>
  )
}
