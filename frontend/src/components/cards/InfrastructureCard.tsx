import { useMemo } from 'react'
import { Bar as RBar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { usePlan } from '../../state/PlanContext'
import { fmtNum, humanize } from '../../format'
import { CardShell, Empty, Section } from './common'
import SourceBadge from '../SourceBadge'
import FactorHover from '../FactorHover'
import type { InfraKind, Provenance } from '../../types'

const READINESS_KEYS = ['readiness_weights', 'walk_speed_m_per_s', 'walk_minutes_target', 'reuse_missing_input_score']

export default function InfrastructureCard() {
  const { state } = usePlan()
  const { plan, selected } = state
  const infra = plan.infrastructure
  const readiness = plan.readiness

  const counts = useMemo(() => {
    const m = new Map<InfraKind, { n: number; prov: Provenance }>()
    for (const f of infra ?? []) {
      const c = m.get(f.kind)
      if (c) c.n++
      else m.set(f.kind, { n: 1, prov: f.prov })
    }
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n)
  }, [infra])

  const histogram = useMemo(() => {
    const bins = Array.from({ length: 10 }, (_, i) => ({ bin: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`, n: 0 }))
    for (const r of readiness ?? []) bins[Math.min(9, Math.max(0, Math.floor(r.score * 10)))].n++
    return bins
  }, [readiness])

  const targetId = selected.buildingId ?? selected.parcelId
  const target = targetId ? readiness?.find((r) => r.target_id === targetId) : undefined
  const walk = targetId ? plan.precomputed?.walk_m?.[targetId] : undefined
  const flood = targetId ? plan.precomputed?.in_flood?.[targetId] : undefined

  return (
    <CardShell title="Infrastructure" note={plan.notes?.infrastructure}>
      <Section title="Features by kind">
        {!infra ? (
          <Empty>Waiting for the infrastructure agent…</Empty>
        ) : counts.length === 0 ? (
          <Empty>No infrastructure features recorded.</Empty>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {counts.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-2">
                <span>{humanize(k)}</span>
                <span className="flex items-center gap-1.5">
                  <span className="tabular-nums">{fmtNum(v.n)}</span>
                  <SourceBadge prov={v.prov} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={`Readiness histogram (${fmtNum(readiness?.length ?? 0)} targets)`}>
        <FactorHover keys={READINESS_KEYS}>
          <span className="text-xs text-neutral-400">score 0–1, weighted by readiness factors</span>
        </FactorHover>
        <div className="mt-1 h-40">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={histogram} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <XAxis dataKey="bin" tick={{ fill: '#a3a3a3', fontSize: 9 }} interval={1} />
              <YAxis tick={{ fill: '#a3a3a3', fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: '#171717', border: '1px solid #404040' }} cursor={{ fill: '#262626' }} />
              <RBar dataKey="n" name="targets" fill="#38bdf8" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>
      <Section title="Selected target">
        {!targetId ? (
          <Empty>Click a parcel or building on the map.</Empty>
        ) : !target ? (
          <Empty>No readiness score for {targetId} (not a candidate target).</Empty>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-neutral-400">{targetId}</span>
              <FactorHover keys={READINESS_KEYS}>
                <span className="font-semibold tabular-nums">readiness {fmtNum(target.score, 2)}</span>
              </FactorHover>
            </div>
            {flood && <div className="text-rose-300">Inside FEMA high-risk flood zone</div>}
            <div>
              <div className="text-xs text-emerald-400">Present</div>
              <ul className="list-disc pl-5 text-neutral-300">
                {target.present.length ? target.present.map((p) => <li key={p}>{p}</li>) : <li className="italic">none</li>}
              </ul>
            </div>
            <div>
              <div className="text-xs text-amber-400">Gaps</div>
              <ul className="list-disc pl-5 text-neutral-300">
                {target.gaps.length ? target.gaps.map((g) => <li key={g}>{g}</li>) : <li className="italic">none</li>}
              </ul>
            </div>
            {walk && (
              <FactorHover keys={['walk_detour_factor', 'walk_speed_m_per_s', 'walk_minutes_target']}>
                <span className="text-xs text-neutral-400">
                  Walk distance (m):{' '}
                  {Object.entries(walk)
                    .map(([k, v]) => `${humanize(k)} ${v === null ? 'missing' : fmtNum(v)}`)
                    .join(' · ')}
                </span>
              </FactorHover>
            )}
          </div>
        )}
      </Section>
    </CardShell>
  )
}
