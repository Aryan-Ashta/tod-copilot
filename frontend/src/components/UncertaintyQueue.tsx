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
const MAX_LINE_CHIPS = 4

/**
 * Transit measurements that would narrow ridership ranges, one card per stop. What every suggestion shares (the
 * count method, the narrowing) is said once above the cards; each card leads with its stop, its lines and its range
 * now against the range after a count, on one riders/day scale for all cards. "Simulate count" applies a labeled
 * demo count and draws the resulting range.
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

  // one riders/day scale for every card, so ranges compare at a glance
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
      <div className="max-h-[52vh] overflow-y-auto pr-1">
        {!t ? (
          <p className="text-slate italic">Waiting for the transit agent…</p>
        ) : items.length === 0 ? (
          <p className="text-slate italic">No measurements suggested.</p>
        ) : (
          <>
            <p className="mb-3 text-[13px] leading-snug text-slate">
              {sharedMethod ? `${sharedMethod} at each stop below.` : 'Measure at each stop below.'}{' '}
              {sharedNarrowing !== null && (
                <FactorHover keys={NARROWING_FACTORS}>
                  <span>
                    Each count cuts that stop&apos;s ridership range by <b className="text-ink">{fmtNum(sharedNarrowing)}%</b>.
                  </span>
                </FactorHover>
              )}{' '}
              Widest range first.
            </p>
            <ol className="space-y-2.5">
              {items.map(({ m, stop }, i) => {
                const sim = state.simulated[m.target_id]
                const selected = state.selected.stopId === m.target_id
                const deps =
                  stop && catchment !== null
                    ? sites.filter((s) => {
                        const c = geometryCentroid(s.geometry)
                        return c !== null && haversineM(c, stop.lonlat) <= catchment
                      })
                    : null
                if (!stop) {
                  return (
                    <li key={m.target_id + m.what} className="rounded-xl border border-rule p-3 text-slate">
                      Stop {m.target_id} is not in the transit plan.
                    </li>
                  )
                }
                const lo = stop.riders_per_day_low
                const hi = stop.riders_per_day_high
                const mid = (lo + hi) / 2
                const after = (hi - lo) * (1 - m.expected_range_narrowing_pct / 100)
                const stopLines = stop.route_ids.map((k) => lines.get(k)).filter((l) => l !== undefined)
                return (
                  <li
                    key={m.target_id + m.what}
                    className={`rounded-xl border bg-white/50 p-3 transition-colors ${selected ? 'border-ink' : 'border-rule hover:border-ink/40'}`}
                  >
                    <button
                      type="button"
                      onClick={() => dispatch({ type: 'select', selected: { stopId: m.target_id, flyTo: stop.lonlat } })}
                      className="flex w-full items-start gap-2.5 text-left"
                      title="Show this stop on the map"
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-transit text-[12px] font-bold text-white tabular-nums">
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] leading-tight font-bold">{stop.name ?? `Stop ${stop.id}`}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          {stopLines.slice(0, MAX_LINE_CHIPS).map((l) => (
                            <span
                              key={l.key}
                              className="inline-flex items-center gap-1 rounded-full bg-ink/[0.06] px-1.5 py-px text-[11px] font-semibold"
                            >
                              <span className="h-2 w-2 rounded-full" style={{ background: `rgb(${l.color[0]} ${l.color[1]} ${l.color[2]})` }} />
                              {lineLabel(l)}
                            </span>
                          ))}
                          {stopLines.length > MAX_LINE_CHIPS && (
                            <span className="text-[11px] text-slate">+{stopLines.length - MAX_LINE_CHIPS} lines</span>
                          )}
                          <span className="text-[11px] text-slate">stop {stop.id}</span>
                        </span>
                      </span>
                    </button>

                    {!sharedMethod && <p className="mt-2 text-[12px] text-slate">{m.what}</p>}

                    {/* range now (light) against the expected range after a count (solid) or the simulated one (mustard) */}
                    <div className="mt-3 flex items-baseline gap-2 tabular-nums">
                      <span className="text-[18px] leading-none font-bold">
                        {fmtNum(lo)}–{fmtNum(hi)}
                      </span>
                      <span className="text-[12px] text-slate">riders/day now</span>
                      <span className="ml-auto text-[12px] text-slate">after a count</span>
                      <span className={`text-[18px] leading-none font-bold ${sim ? 'text-amber-200' : 'text-transit'}`}>
                        {sim ? `${fmtNum(sim.after[0])}–${fmtNum(sim.after[1])}` : `±${fmtNum(after / 2)}`}
                      </span>
                    </div>
                    <div className="relative mt-2 h-5" aria-hidden>
                      <div className="absolute inset-x-0 top-1/2 h-px bg-rule" />
                      <div className="uq-bar absolute top-0.5 h-1.5 rounded-full bg-transit/25" style={span(lo, hi)} />
                      {sim ? (
                        <>
                          <div className="uq-bar absolute bottom-0.5 h-1.5 rounded-full bg-mustard" style={span(sim.after[0], sim.after[1])} />
                          <div className="absolute top-0 bottom-0 w-0.5 rounded bg-ink" style={{ left: x(sim.count_per_day) }} />
                        </>
                      ) : (
                        <div className="uq-bar absolute bottom-0.5 h-1.5 rounded-full bg-transit" style={span(mid - after / 2, mid + after / 2)} />
                      )}
                    </div>
                    {!sharedNarrowing && (
                      <FactorHover keys={NARROWING_FACTORS}>
                        <span className="text-[12px] text-slate">range narrows by {fmtNum(m.expected_range_narrowing_pct)}%</span>
                      </FactorHover>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
                      <span className="text-slate">Sites that hinge on it</span>
                      {deps === null ? (
                        <span className="text-slate">—</span>
                      ) : deps.length === 0 ? (
                        <span className="text-slate">none in the stop&apos;s catchment</span>
                      ) : (
                        deps.map((s) => (
                          <span key={s.id} title={s.id} className="rounded-full border border-rule bg-paper px-2 py-px">
                            {letters.get(s.id) && <b className="mr-1">{letters.get(s.id)}</b>}
                            {names.get(s.id) ?? s.id}
                          </span>
                        ))
                      )}
                    </div>

                    <div className="mt-2.5 flex items-center gap-2">
                      {sim ? (
                        <span className="rounded-full bg-mustard/25 px-2 py-0.5 text-[12px]">
                          <b>{sim.label}</b> {fmtNum(sim.count_per_day)} riders/day
                        </span>
                      ) : (
                        <button
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
                          className="ctl px-2.5 py-0.5 text-xs"
                        >
                          {busy === m.target_id ? 'Simulating…' : 'Simulate count'}
                        </button>
                      )}
                    </div>
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
