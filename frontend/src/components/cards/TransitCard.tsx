import { usePlan } from '../../state/PlanContext'
import { fmtNum, fmtUsd, humanize } from '../../format'
import { CardShell, Empty, Section, td, th } from './common'
import FactorHover from '../FactorHover'
import type { Route } from '../../types'

const COST_KEYS: Record<Route['kind'], string[]> = {
  rail_existing: [],
  bus_existing: [],
  frequent_bus: ['bus_operating_cost_usd_per_revenue_hour', 'service_span_hours_per_day', 'service_days_per_year', 'frequent_bus_headway_min', 'bus_avg_speed_kmh'],
  brt: ['bus_operating_cost_usd_per_revenue_hour', 'service_span_hours_per_day', 'service_days_per_year', 'brt_headway_min', 'brt_min_demand_per_km'],
  on_demand_zone: ['on_demand_cost_usd_per_zone_year'],
}

const KIND_DOT: Record<Route['kind'], string> = {
  rail_existing: 'bg-red-500',
  bus_existing: 'bg-neutral-500',
  frequent_bus: 'bg-teal-500',
  brt: 'bg-emerald-500',
  on_demand_zone: 'bg-purple-500',
}

export default function TransitCard() {
  const { state } = usePlan()
  const t = state.plan.transit
  const routes = t ? [...t.routes].sort((a, b) => a.phase - b.phase || a.id.localeCompare(b.id)) : []
  const proposed = routes.filter((r) => r.phase > 0)
  return (
    <CardShell title="Transit network" note={state.plan.notes?.transit_network}>
      {!t ? (
        <Empty>Waiting for the transit agent…</Empty>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded bg-neutral-900 p-2">
              <div className="text-xs text-neutral-400">Proposed routes</div>
              <div className="text-lg font-semibold">{fmtNum(proposed.length)}</div>
            </div>
            <div className="rounded bg-neutral-900 p-2">
              <FactorHover keys={['transit_budget_usd']}>
                <span className="text-xs text-neutral-400">Budget / yr</span>
              </FactorHover>
              <div className="text-lg font-semibold">{fmtUsd(t.budget_usd)}</div>
            </div>
          </div>
          <Section title="Routes">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>Route</th>
                  <th className={th}>Phase</th>
                  <th className={th}>Headway</th>
                  <th className={th}>Cost / yr</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.id} className="border-t border-neutral-900">
                    <td className={td}>
                      <span className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${KIND_DOT[r.kind]}`} />
                        <span>
                          {r.id} <span className="text-neutral-500">{humanize(r.kind)}</span>
                        </span>
                      </span>
                    </td>
                    <td className={td}>{r.phase === 0 ? 'existing' : r.phase}</td>
                    <td className={td}>{r.headway_min ? `${r.headway_min} min` : '—'}</td>
                    <td className={`${td} tabular-nums`}>
                      <FactorHover keys={COST_KEYS[r.kind]}>{r.phase === 0 ? '—' : fmtUsd(r.annual_operating_cost_usd)}</FactorHover>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Measurements that would narrow ridership ranges">
            {t.measurements.length === 0 ? (
              <Empty>No measurements suggested.</Empty>
            ) : (
              <ul className="space-y-1 text-sm">
                {t.measurements.map((m) => (
                  <li key={m.target_id + m.what} className="rounded bg-neutral-900 p-2">
                    {m.what}
                    <FactorHover keys={['count_range_narrowing_pct']}>
                      <span className="ml-2 text-xs text-neutral-400">expected narrowing {fmtNum(m.expected_range_narrowing_pct)}%</span>
                    </FactorHover>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </CardShell>
  )
}
