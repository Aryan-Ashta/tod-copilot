import { useState } from 'react'
import { usePlan } from '../state/PlanContext'
import { useApp } from '../state/AppContext'
import { fmtNum, geometryCentroid, haversineM } from '../format'
import { siteLetters } from '../mapLayers'
import FactorHover from './FactorHover'

/** Transit measurements that would narrow ridership ranges; "Simulate count" applies a labeled demo count. */
export default function UncertaintyQueue({ className = '' }: { className?: string }) {
  const { state, runSimulation, dispatch } = usePlan()
  const { factorNumber } = useApp()
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(true)
  const t = state.plan.transit
  const sites = state.plan.sites ?? []
  const letters = siteLetters(sites)
  const catchment = factorNumber('stop_catchment_m')

  return (
    <div className={`rounded-md border border-neutral-800 bg-neutral-950/90 text-xs shadow-lg backdrop-blur ${className}`}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-left font-semibold">
        What would make this plan more certain <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="max-h-[40vh] space-y-2 overflow-y-auto px-3 pb-3">
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
                <div key={m.target_id + m.what} className="rounded border border-neutral-800 bg-neutral-900 p-2">
                  <button
                    className="text-left text-neutral-100 hover:underline"
                    onClick={() => dispatch({ type: 'select', selected: { stopId: m.target_id } })}
                  >
                    {m.what}
                  </button>
                  {stop ? (
                    <div className="mt-1 space-y-0.5 text-neutral-400">
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
                            : deps.map((s) => (letters.get(s.id) ? `Site ${letters.get(s.id)}` : s.id)).join(', ')}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1 text-neutral-500">Stop {m.target_id} not in the transit plan.</div>
                  )}
                  {sim ? (
                    <div className="mt-2 rounded border border-amber-700 bg-amber-950/40 p-1.5">
                      <span className="mr-1 rounded bg-amber-700 px-1 text-[10px] font-semibold text-white uppercase">{sim.label}</span>
                      <span className="tabular-nums text-amber-100">
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
                      className="mt-2 rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-600 disabled:opacity-50"
                    >
                      {busy === m.target_id ? 'Simulating…' : 'Simulate count'}
                    </button>
                  )}
                </div>
              )
            })
          )}
          {err && <p className="text-rose-400">Simulation failed: {err}</p>}
        </div>
      )}
    </div>
  )
}
