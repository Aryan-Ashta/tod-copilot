import { useMemo, useState } from 'react'
import { Bar, BarChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { usePlan } from '../../state/PlanContext'
import { useApp } from '../../state/AppContext'
import { fmtNum, fmtUsd, parcelLabel, siteNames } from '../../format'
import { siteLetters } from '../../mapLayers'
import { CardShell, Empty, Section, td, th } from './common'
import FactorHover, { useFactorLabel } from '../FactorHover'
import type { CapitalStack, Site } from '../../types'

const INCENTIVE = 'houston_downtown_per_unit_incentive_usd'
const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const NO_SITES: Site[] = []
const PARTS: { key: keyof CapitalStack; label: string; color: string }[] = [
  { key: 'debt_usd', label: 'Debt', color: '#3b82f6' },
  { key: 'tax_credit_equity_usd', label: 'Tax credit', color: '#14b8a6' },
  { key: 'incentive_usd', label: 'Incentive', color: '#a855f7' },
  { key: 'investor_equity_usd', label: 'Investor', color: '#22c55e' },
  { key: 'gap_usd', label: 'Gap', color: '#f43f5e' },
]

function MathRow({ s }: { s: CapitalStack }) {
  const label = useFactorLabel()
  return (
    <div className="rounded bg-neutral-950 p-2 text-xs">
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
        <span className="text-neutral-400">Total cost</span>
        <span>{fmtUsd(s.total_cost_usd)}</span>
        {PARTS.map((p) => (
          <span key={p.key} className="contents">
            <span className="text-neutral-400">{p.label}</span>
            <span>{fmtUsd(s[p.key] as number)}</span>
          </span>
        ))}
      </div>
      <div className="mt-1 text-neutral-400">
        Factors:{' '}
        {s.assumptions.map((k, i) => (
          <span key={k}>
            <FactorHover keys={[k]}>
              <span className="text-neutral-300">{label(k)}</span>
            </FactorHover>
            {i < s.assumptions.length - 1 && ', '}
          </span>
        ))}
      </div>
    </div>
  )
}

/** One line per open gap: its size per home, cost vs value per home, and what would close it (from the backend). */
function GapLine({ s, name }: { s: CapitalStack; name: string }) {
  const g = s.gap_to_pencil
  const label = useFactorLabel()
  const { factorNumber } = useApp()
  if (!g) return null
  const inc = s.assumptions.includes(INCENTIVE) ? factorNumber(INCENTIVE) : null
  return (
    <li>
      <span className="font-medium text-neutral-100">{name}</span>: gap {fmtUsd(s.gap_usd)}
      {g.gap_per_home_usd === null ? (
        '; no homes, so no per-home lever.'
      ) : (
        <>
          {' '}
          ({fmtUsd(g.gap_per_home_usd)} per home;{' '}
          <FactorHover keys={g.factor_keys}>
            cost {fmtUsd(g.cost_per_home_usd)} vs value {fmtUsd(g.value_per_home_usd)} per home
          </FactorHover>
          ). Closes with {fmtUsd(g.gap_per_home_usd)} more incentive per home
          {inc !== null && (
            <>
              {' '}
              on top of the <FactorHover keys={[INCENTIVE]}>{label(INCENTIVE)}</FactorHover> ({fmtUsd(inc)})
            </>
          )}
          {g.break_even_rent_usd_per_unit_month !== null ? (
            <>
              , or <FactorHover keys={['rent_usd_per_unit_month']}>rent</FactorHover> of $
              {fmtNum(g.break_even_rent_usd_per_unit_month)}/mo instead of ${fmtNum(g.rent_usd_per_unit_month)}.
            </>
          ) : (
            <>
              ; rent alone cannot close it (<FactorHover keys={['debt_ratio']}>{label('debt_ratio')}</FactorHover> cap).
            </>
          )}
        </>
      )}
    </li>
  )
}

export default function FundingCard() {
  const { state } = usePlan()
  const { plan } = state
  const stacks = plan.stacks
  const sites = plan.sites ?? NO_SITES
  const letters = siteLetters(sites)
  const [showMath, setShowMath] = useState(false)
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites])
  const names = useMemo(() => siteNames(plan), [plan])

  const label = (id: string) => {
    const n = names.get(id) ?? id
    const l = letters.get(id)
    return l ? `${l} · ${n}` : n
  }

  const chart = (stacks ?? []).map((s) => ({
    name: label(s.site_id),
    ...Object.fromEntries(PARTS.map((p) => [p.label, s[p.key] as number])),
  }))

  const comparisons = useMemo(() => {
    const byParcel = new Map<string, { nb?: Site; conv?: Site }>()
    for (const s of sites) {
      for (const pid of s.parcel_ids) {
        const e = byParcel.get(pid) ?? {}
        if (s.kind === 'new_build') e.nb = s
        else e.conv = s
        byParcel.set(pid, e)
      }
    }
    return [...byParcel.entries()].filter(([, v]) => v.nb && v.conv) as [string, { nb: Site; conv: Site }][]
  }, [sites])

  const stackById = new Map((stacks ?? []).map((s) => [s.site_id, s]))
  const yes = (stacks ?? []).filter((s) => s.pencils).length

  return (
    <CardShell title="Funding" note={plan.notes?.funding}>
      {!stacks ? (
        <Empty>Waiting for the funding agent…</Empty>
      ) : stacks.length === 0 ? (
        <Empty>No capital stacks.</Empty>
      ) : (
        <>
          <div className="flex items-center gap-3 text-sm">
            <span className={`rounded px-2 py-0.5 font-semibold ${yes > 0 ? 'bg-emerald-900 text-emerald-200' : 'bg-rose-950 text-rose-200'}`}>
              Pencils: {yes} of {stacks.length} sites
            </span>
            <button onClick={() => setShowMath(!showMath)} className="text-xs text-sky-400 hover:underline">
              {showMath ? 'Hide math' : 'Show math'}
            </button>
          </div>
          <Section title="Capital stacks">
            <div style={{ height: Math.max(120, chart.length * 34 + 50) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                  <XAxis type="number" tickFormatter={(v: number) => fmtUsd(v)} tick={{ fill: '#a3a3a3', fontSize: 10 }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={150}
                    tickFormatter={(v: string) => short(v)}
                    tick={{ fill: '#d4d4d4', fontSize: 10 }}
                  />
                  <Tooltip
                    formatter={(v) => fmtUsd(Number(v))}
                    contentStyle={{ background: '#171717', border: '1px solid #404040' }}
                    cursor={{ fill: '#262626' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {PARTS.map((p) => (
                    <Bar key={p.key} dataKey={p.label} stackId="s" fill={p.color} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>Site</th>
                  <th className={th}>Total cost</th>
                  <th className={th}>Gap</th>
                  <th className={th}>Pencils?</th>
                  <th className={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {stacks.map((s) => (
                  <tr key={s.site_id} className="border-t border-neutral-900">
                    <td className={td} title={s.site_id}>
                      {label(s.site_id)}
                    </td>
                    <td className={`${td} tabular-nums`}>
                      <FactorHover keys={s.assumptions}>{fmtUsd(s.total_cost_usd)}</FactorHover>
                    </td>
                    <td className={`${td} tabular-nums`}>{fmtUsd(s.gap_usd)}</td>
                    <td className={`${td} ${s.pencils ? 'text-emerald-300' : 'text-rose-300'}`}>{s.pencils ? 'yes' : 'no'}</td>
                    <td className={td}>{siteById.get(s.site_id)?.status ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {showMath && (
              <div className="mt-2 space-y-2">
                {stacks.map((s) => (
                  <div key={s.site_id}>
                    <div className="mb-0.5 text-xs font-medium">{label(s.site_id)}</div>
                    <MathRow s={s} />
                  </div>
                ))}
              </div>
            )}
          </Section>
          {stacks.some((s) => s.gap_to_pencil) && (
            <Section title="Gap to pencil">
              <ul className="space-y-1.5 text-xs text-neutral-300">
                {stacks
                  .filter((s) => s.gap_to_pencil)
                  .map((s) => (
                    <GapLine key={s.site_id} s={s} name={label(s.site_id)} />
                  ))}
              </ul>
            </Section>
          )}
          {comparisons.length > 0 && (
            <Section title="New build vs Convert">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={th}>Parcel</th>
                    <th className={th}>Option</th>
                    <th className={th}>Homes</th>
                    <th className={th}>Total cost</th>
                    <th className={th}>Gap</th>
                    <th className={th}>Pencils</th>
                    <th className={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisons.flatMap(([pid, { nb, conv }]) =>
                    [nb, conv].map((s, i) => {
                      const st = stackById.get(s.id)
                      return (
                        <tr key={`${pid}-${s.id}`} className={i === 0 ? 'border-t border-neutral-800' : ''}>
                          <td className={td} title={pid}>
                            {i === 0 ? parcelLabel(plan.parcels?.find((p) => p.id === pid), pid) : ''}
                          </td>
                          <td className={td}>{s.kind === 'new_build' ? 'New build' : 'Convert'}</td>
                          <td className={`${td} tabular-nums`}>{fmtNum(s.homes)}</td>
                          <td className={`${td} tabular-nums`}>{fmtUsd(st?.total_cost_usd)}</td>
                          <td className={`${td} tabular-nums`}>{fmtUsd(st?.gap_usd)}</td>
                          <td className={td}>{st ? (st.pencils ? 'yes' : 'no') : '—'}</td>
                          <td className={`${td} ${s.status === 'pass' ? 'text-neutral-500' : 'text-emerald-300'}`}>{s.status}</td>
                        </tr>
                      )
                    }),
                  )}
                </tbody>
              </table>
            </Section>
          )}
        </>
      )}
    </CardShell>
  )
}
