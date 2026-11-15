import { useMemo, useState } from 'react'
import MapPanel from './MapPanel'
import { usePlan } from '../state/PlanContext'
import { useApp } from '../state/AppContext'
import { fmtNum, geometryCentroid, haversineM, siteNames } from '../format'
import { lineLabel, siteLetters, transitLines } from '../mapLayers'
import FactorHover from './FactorHover'
import type { MeasurementSuggestion, Stop } from '../types'

const NARROWING_FACTORS = ['count_range_narrowing_pct', 'ridership_rate_low', 'ridership_rate_high']

/** `what` with the stop taken out ("… count at stop McKinney St @ Austin St, 7–9 am" → "… count, 7–9 am"), so
 * suggestions that differ only by stop can share one line. */
const methodOf = (m: MeasurementSuggestion, stop: Stop | undefined) =>
  stop?.name ? m.what.replace(new RegExp(`\\s*(at )?(stop )?${stop.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '') : m.what

/**
 * Transit measurements that would narrow ridership ranges, one row per stop, widest range first. What every
 * suggestion shares (the count method, the narrowing) is said once above the rows; each row is the stop, its range now
 * and after a count, and one thin bar on a riders/day scale shared by all rows. "Simulate count" applies a labeled
 * demo count and the bar moves to the resulting range.
 */
export default function UncertaintyQueue({ className = '' }: { className?: string }) {
  const { state, runSimulation, dispatch } = usePlan()
  const { factorNumber } = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const t = state.plan.transit
  const sites = state.plan.sites ?? []
  const letters = siteLetters(sites)
  const names = useMemo(() => siteNames(state.plan), [state.plan])
  const lines = useMemo(() => new Map(transitLines(state.plan.infrastructure ?? []).map((l) => [l.key, l])), [state.plan.infrastructure])
  const catchment = factorNumber('stop_catchment_m')

  const items = useMemo(() => {
    if (!t) return []
    return t.measurements
      .map((m) => {
        const stop = t.stops.find((s) => s.id === m.target_id)
        return { m, stop, width: stop ? stop.riders_per_day_high - stop.riders_per_day_low : -1 }
      })
      .sort((a, b) => b.width - a.width) // widest range (most to learn) first
  }, [t])

  // one riders/day scale for every row, so ranges compare at a glance
  const scaleMax = Math.max(
    1,
    ...items.map(({ stop }) => stop?.riders_per_day_high ?? 0),
    ...items.map(({ m }) => state.simulated[m.target_id]?.after[1] ?? 0),
  )
  const x = (v: number) => `${Math.min(100, Math.max(0, (v / scaleMax) * 100))}%`
  const span = (lo: number, hi: number) => ({ left: x(lo), width: `${Math.max(0.8, ((hi - lo) / scaleMax) * 100)}%` })

  const methods = new Set(items.map(({ m, stop }) => methodOf(m, stop)))
  const narrowings = new Set(items.map(({ m }) => m.expected_range_narrowing_pct))
  const sharedMethod = methods.size === 1 && items.length > 1 ? [...methods][0] : null
  const sharedNarrowing = narrowings.size === 1 ? [...narrowings][0] : null

  return (
    <MapPanel title="What would make this plan more certain" className={className}>
      <div className="max-h-[52vh] overflow-y-auto">
        {!t ? (
          <p className="text-slate italic">Waiting for the transit agent…</p>
        ) : items.length === 0 ? (
          <p className="text-slate italic">No measurements suggested.</p>
        ) : (
          <>
            <p className="mb-1 text-[12.5px] leading-snug text-slate">
              {sharedMethod ?? 'A count at each stop'}
              {sharedNarrowing !== null && (
                <>
                  {': '}
                  <FactorHover keys={NARROWING_FACTORS}>
                    <span>narrows each stop&apos;s range by {fmtNum(sharedNarrowing)}%</span>
                  </FactorHover>
                </>
              )}
            </p>
            <ol className="divide-y divide-rule">
              {items.map(({ m, stop }) => {
                if (!stop) {
                  return (
                    <li key={m.target_id + m.what} className="py-2.5 text-slate">
                      Stop {m.target_id} is not in the transit plan.
                    </li>
                  )
                }
                const sim = state.simulated[m.target_id]
                const selected = state.selected.stopId === m.target_id
                const lo = stop.riders_per_day_low
                const hi = stop.riders_per_day_high
                const mid = (lo + hi) / 2
                const after = (hi - lo) * (1 - m.expected_range_narrowing_pct / 100)
                const stopLines = stop.route_ids.map((k) => lines.get(k)?.name ?? k)
                const firstLine = lines.get(stop.route_ids[0])
                const deps =
                  catchment !== null
                    ? sites.filter((s) => {
                        const c = geometryCentroid(s.geometry)
                        return c !== null && haversineM(c, stop.lonlat) <= catchment
                      })
                    : []
                const meta = [
                  firstLine
                    ? `${lineLabel(firstLine)}${stopLines.length > 1 ? `, ${stopLines.slice(1, 3).join(', ')}` : ''}${stopLines.length > 3 ? ` +${stopLines.length - 3}` : ''}`
                    : null,
                  deps.length ? `sites ${deps.map((s) => letters.get(s.id) ?? '•').join(' ')}` : null,
                  sharedNarrowing === null ? `−${fmtNum(m.expected_range_narrowing_pct)}% range` : null,
                ].filter(Boolean)
                return (
                  <li key={m.target_id + m.what} className="py-2.5">
                    <div className="flex items-baseline gap-3">
                      <button
                        type="button"
                        onClick={() => dispatch({ type: 'select', selected: { stopId: m.target_id, flyTo: stop.lonlat } })}
                        title="Show this stop on the map"
                        className={`min-w-0 flex-1 truncate text-left text-[14px] font-semibold hover:underline ${selected ? 'text-transit' : ''}`}
                      >
                        {stop.name ?? `Stop ${stop.id}`}
                      </button>
                      <span className="shrink-0 text-[13px] tabular-nums">
                        <span className="text-slate">{fmtNum(lo)}–{fmtNum(hi)}</span>
                        <span className="mx-1 text-slate">→</span>
                        <b className={sim ? 'text-amber-200' : 'text-transit'}>
                          {sim ? `${fmtNum(sim.after[0])}–${fmtNum(sim.after[1])}` : `±${fmtNum(after / 2)}`}
                        </b>
                      </span>
                    </div>
                    <div className="relative mt-1.5 h-1" aria-hidden>
                      <div className="uq-bar absolute inset-y-0 rounded-full bg-ink/10" style={span(lo, hi)} />
                      <div
                        className={`uq-bar absolute inset-y-0 rounded-full ${sim ? 'bg-mustard' : 'bg-transit'}`}
                        style={sim ? span(sim.after[0], sim.after[1]) : span(mid - after / 2, mid + after / 2)}
                      />
                    </div>
                    <div className="mt-1.5 flex items-baseline gap-3 text-[12px] text-slate">
                      <span className="min-w-0 flex-1 truncate" title={deps.map((s) => names.get(s.id) ?? s.id).join(', ')}>
                        {meta.join(' · ')}
                      </span>
                      {sim ? (
                        <span className="shrink-0">
                          {sim.label}: {fmtNum(sim.count_per_day)}/day
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy !== null || !state.basePlan}
                          onClick={async () => {
                            setBusy(m.target_id)
                            setErr(null)
                            try {
                              await runSimulation(m.target_id)
                            } catch (e) {
                              setErr((e as Error).message)
                            } finally {
                              setBusy(null)
                            }
                          }}
                          className="shrink-0 font-semibold text-ink underline decoration-rule underline-offset-2 hover:decoration-ink disabled:text-slate disabled:no-underline"
                        >
                          {busy === m.target_id ? 'Simulating…' : 'Simulate count'}
                        </button>
                      )}
                    </div>
                    {!sharedMethod && <p className="mt-1 text-[12px] text-slate">{m.what}</p>}
                  </li>
                )
              })}
            </ol>
          </>
        )}
        {err && <p className="mt-2 text-gap">Simulation failed: {err}</p>}
      </div>
    </MapPanel>
  )
}
