import { useMemo, useState } from 'react'
import MapPanel from './MapPanel'
import { usePlan } from '../state/PlanContext'
import { useApp } from '../state/AppContext'
import { fmtNum, geometryCentroid, haversineM, siteNames } from '../format'
import { siteLetters } from '../mapLayers'
import FactorHover from './FactorHover'

/** Transit measurements that would narrow ridership ranges; "Simulate count" applies a labeled demo count. */
export default function UncertaintyQueue({ className = '' }: { className?: string }) {
  const { state, runSimulation, dispatch } = usePlan()
  const { factorNumber } = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const t = state.plan.transit
  const sites = state.plan.sites ?? []
  const letters = siteLetters(sites)
  const names = useMemo(() => siteNames(state.plan), [state.plan])
  const catchment = factorNumber('stop_catchment_m')

  return (
    <MapPanel title="What would make this plan more certain" className={className}>
        <div className="max-h-[40vh] divide-y divide-rule overflow-y-auto">
          {!t ? (
            <p className="text-neutral-500 italic">Waiting for the transit agent…</p>
          ) : t.measurements.length === 0 ? (
            <p className="text-neutral-500 italic">No measurements suggested.</p>
          ) : (
            t.measurements.map((m) => {
              const stop = t.stops.find((s) => s.id === m.target_id)
              const sim = state.simulated[m.target_id]
              const width = stop ? stop.riders_per_day_high - stop.riders_per_day_low : null
              const deps =
                stop && catchment !== null
                  ? sites.filter((s) => {
                      const c = geometryCentroid(s.geometry)
                      return c !== null && haversineM(c, stop.lonlat) <= catchment
                    })
                  : null
              return (
                <div key={m.target_id + m.what} className="py-2">
                  <button
                    className="text-left text-neutral-100 hover:underline"
                    onClick={() => dispatch({ type: 'select', selected: { stopId: m.target_id } })}
                  >
                    {m.what}
                  </button>
                  {stop ? (
                    <div className="mt-1 space-y-0.5 text-slate">
                      <div>
                        Current range:{' '}
                        <span className="text-neutral-200 tabular-nums">
                          {fmtNum(stop.riders_per_day_low)}–{fmtNum(stop.riders_per_day_high)} riders/day
                        </span>
                      </div>
                      {width !== null && (
                        <FactorHover keys={['count_range_narrowing_pct', 'ridership_rate_low', 'ridership_rate_high']}>
                          <span>
                            Expected after count: range width {fmtNum(width)} →{' '}
                            <span className="text-neutral-200">{fmtNum(width * (1 - m.expected_range_narrowing_pct / 100))}</span> riders/day
                            (−{fmtNum(m.expected_range_narrowing_pct)}%)
                          </span>
                        </FactorHover>
                      )}
                      <div>
                        Decisions that depend on it:{' '}
                        {deps === null
                          ? '—'
                          : deps.length === 0
                            ? 'no sites within the stop catchment'
                            : deps.map((s, i) => (
                                <span key={s.id} title={s.id}>
                                  {letters.get(s.id) ? `Site ${letters.get(s.id)} · ` : ''}
                                  {names.get(s.id) ?? s.id}
                                  {i < deps.length - 1 && ', '}
                                </span>
                              ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-neutral-500">Stop {m.target_id} not in the transit plan.</div>
                  )}
                  {sim ? (
                    <div className="mt-2 border-l-2 border-mustard pl-2">
                      <span className="mr-1 text-xs font-semibold">{sim.label}</span>
                      <span className="tabular-nums">
                        {fmtNum(sim.count_per_day)} riders/day · range {fmtNum(sim.before[0])}–{fmtNum(sim.before[1])} →{' '}
                        {fmtNum(sim.after[0])}–{fmtNum(sim.after[1])}
                      </span>
                    </div>
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
                      className="ctl mt-2 px-2 py-0.5 text-xs"
                    >
                      {busy === m.target_id ? 'Simulating…' : 'Simulate count'}
                    </button>
                  )}
                </div>
              )
            })
          )}
          {err && <p className="text-gap">Simulation failed: {err}</p>}
        </div>
    </MapPanel>
  )
}
