import { useEffect, useMemo } from 'react'
import { usePlan } from '../../state/PlanContext'
import { fmtNum, fmtUsd, humanize } from '../../format'
import { CardShell, Empty, Section, td, th } from './common'
import FactorHover from '../FactorHover'
import { routeColor, routeKey, routeLabel, transitLines } from '../../mapLayers'
import type { Route } from '../../types'

const COST_KEYS: Record<Route['kind'], string[]> = {
  rail_existing: [],
  bus_existing: [],
  frequent_bus: ['bus_operating_cost_usd_per_revenue_hour', 'service_span_hours_per_day', 'service_days_per_year', 'frequent_bus_headway_min', 'bus_avg_speed_kmh'],
  brt: ['bus_operating_cost_usd_per_revenue_hour', 'service_span_hours_per_day', 'service_days_per_year', 'brt_headway_min', 'brt_min_demand_per_km'],
  on_demand_zone: ['on_demand_cost_usd_per_zone_year'],
}

export default function TransitCard() {
  const { state, dispatch } = usePlan()
  const t = state.plan.transit
  const infra = state.plan.infrastructure
  const lines = useMemo(() => new Map(transitLines(infra ?? []).map((l) => [l.key, l])), [infra])
  // the plan's new and upgraded services first, then existing rail, then existing buses
  const order = (r: Route) => (r.phase > 0 ? r.phase - 10 : r.kind === 'rail_existing' ? 0 : 1)
  const routes = t ? [...t.routes].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id)) : []
  const focusKey = state.selected.routeKey
  // a row hovered as the card goes away would otherwise leave its route focused on the map
  useEffect(() => () => dispatch({ type: 'hover_route', key: null }), [dispatch])
  const proposed = routes.filter((r) => r.phase > 0)
  return (
    <CardShell title="Transit network" note={state.plan.notes?.transit_network}>
      {!t ? (
        <Empty>Waiting for the transit agent…</Empty>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="rounded bg-neutral-900 p-2">
              <div className="text-xs text-neutral-400">Proposed routes</div>
              <div className="text-lg font-semibold">{fmtNum(proposed.length)}</div>
            </div>
            <div className="rounded bg-neutral-900 p-2">
              <FactorHover keys={['transit_coverage_goal_pct', 'bus_operating_cost_usd_per_revenue_hour']}>
                <span className="text-xs text-neutral-400">Operating funding / yr</span>
              </FactorHover>
              <div className="text-lg font-semibold">{fmtUsd(t.annual_operating_cost_usd)}</div>
            </div>
            <div className="rounded bg-neutral-900 p-2">
              <FactorHover keys={['frequent_bus_headway_min', 'stop_catchment_m', 'transit_coverage_goal_pct']}>
                <span className="text-xs text-neutral-400">Frequent coverage</span>
              </FactorHover>
              <div className="text-lg font-semibold">{`${fmtNum(t.coverage_pct, 1)}%`}</div>
              <div className="text-xs text-neutral-400">{`goal ${t.coverage_goal_pct}% · from ${t.coverage_baseline_pct}%`}</div>
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
                {routes.map((r) => {
                  const key = routeKey(r.id)
                  const [cr, cg, cb] = routeColor(r, lines) as readonly number[]
                  return (
                    <tr
                      key={r.id}
                      title={r.id}
                      // hover and click focus the route on the map, as hovering or clicking its line there does
                      onMouseEnter={() => dispatch({ type: 'hover_route', key })}
                      onMouseLeave={() => dispatch({ type: 'hover_route', key: null })}
                      onClick={() => dispatch({ type: 'select', selected: focusKey === key ? {} : { routeKey: key } })}
                      className={`cursor-pointer border-t border-neutral-900 hover:bg-ink/[0.03] ${focusKey === key ? 'bg-ink/[0.06]' : ''}`}
                    >
                      <td className={td}>
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-4 shrink-0 rounded-full" style={{ background: `rgb(${cr},${cg},${cb})` }} />
                          <span>
                            {routeLabel(r, lines)} <span className="text-neutral-500">{humanize(r.kind)}</span>
                          </span>
                        </span>
                      </td>
                      <td className={td}>{r.phase === 0 ? 'existing' : r.phase}</td>
                      <td className={td}>{r.headway_min ? `${r.headway_min} min` : '—'}</td>
                      <td className={`${td} tabular-nums`}>
                        <FactorHover keys={COST_KEYS[r.kind]}>{r.phase === 0 ? '—' : fmtUsd(r.annual_operating_cost_usd)}</FactorHover>
                      </td>
                    </tr>
                  )
                })}
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
