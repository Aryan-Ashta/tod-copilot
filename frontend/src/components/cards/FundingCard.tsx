import { useMemo, useState } from 'react'
import { usePlan } from '../../state/PlanContext'
import { useApp } from '../../state/AppContext'
import { fmtNum, fmtUsd, parcelLabel, siteNames } from '../../format'
import { siteLetters } from '../../mapLayers'
import { CardShell, Empty, Section, td, th } from './common'
import FactorHover, { useFactorLabel } from '../FactorHover'
import { CapitalStacksFigure, SLICES } from './CapitalStacksFigure'
import { ISO } from '../../iso'
import type { CapitalStack, Site } from '../../types'

const INCENTIVE = 'houston_downtown_per_unit_incentive_usd'

const NO_SITES: Site[] = []
const PARTS: { key: keyof CapitalStack; label: string }[] = [
  ...SLICES.map((p) => ({ key: p.key, label: p.label })),
  { key: 'gap_usd', label: 'Gap' },
]

function MathRow({ s }: { s: CapitalStack }) {
  const label = useFactorLabel()
  return (
    <div className="bg-ink/[0.03] p-2 text-xs">
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
        <span className="text-slate">Total cost</span>
        <span>{fmtUsd(s.total_cost_usd)}</span>
        {PARTS.map((p) => (
          <span key={p.key} className="contents">
            <span className="text-slate">{p.label}</span>
            <span>{fmtUsd(s[p.key] as number)}</span>
          </span>
        ))}
      </div>
      <div className="mt-1 text-slate">
        Factors:{' '}
        {s.assumptions.map((k, i) => (
          <span key={k}>
            <FactorHover keys={[k]}>
              <span>{label(k)}</span>
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
      <span className="font-semibold">{name}</span>: gap {fmtUsd(s.gap_usd)}
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
  const [showTable, setShowTable] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const siteById = useMemo(() => new Map(sites.map((s) => [s.id, s])), [sites])
  const names = useMemo(() => siteNames(plan), [plan])

  const label = (id: string) => {
    const n = names.get(id) ?? id
    const l = letters.get(id)
    return l ? `${l} · ${n}` : n
  }



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
  // default selection: the site closest to pencilling (smallest gap per home), else the first stack
  const closest = (stacks ?? [])
    .filter((s) => s.gap_to_pencil?.gap_per_home_usd != null)
    .sort((a, b) => a.gap_to_pencil!.gap_per_home_usd! - b.gap_to_pencil!.gap_per_home_usd!)[0]
  const sel = (picked && stackById.get(picked)) || closest || stacks?.[0]

  return (
    <CardShell title="Funding" note={plan.notes?.funding}>
      {!stacks ? (
        <Empty>Waiting for the funding agent…</Empty>
      ) : stacks.length === 0 ? (
        <Empty>No capital stacks.</Empty>
      ) : (
        <>
          <p className="text-[15px]">
            <span className={`font-bold ${yes > 0 ? 'text-emerald-300' : 'text-gap'}`}>
              Pencils: {yes} of {stacks.length} sites
            </span>
            <span className="text-slate"> · columns are each site's capital stack; dashed red is the gap.</span>
          </p>
          <figure className="border border-rule p-3">
            <CapitalStacksFigure stacks={stacks} names={names} selected={sel?.site_id ?? null} onSelect={setPicked} />
            <figcaption className="mt-2 grid grid-cols-2 gap-x-4 text-[13px] text-slate">
              {stacks.map((s, i) => (
                <button
                  key={s.site_id}
                  onClick={() => setPicked(s.site_id)}
                  className={`truncate text-left hover:text-ink ${sel?.site_id === s.site_id ? 'font-semibold text-ink' : ''}`}
                  title={s.site_id}
                >
                  <span className="tnum">{i + 1}</span> {label(s.site_id)}
                </button>
              ))}
            </figcaption>
          </figure>
          {sel && (
            <div className="border-l-2 pl-4 text-[15px]" style={{ borderColor: sel.pencils ? ISO.green : ISO.gap }}>
              {sel.pencils ? (
                <p>
                  <span className="font-semibold">{label(sel.site_id)}</span> pencils: cost{' '}
                  <FactorHover keys={sel.assumptions}>{fmtUsd(sel.total_cost_usd)}</FactorHover>, fully funded.
                </p>
              ) : (
                <ul>
                  <GapLine s={sel} name={label(sel.site_id)} />
                </ul>
              )}
            </div>
          )}
          <div className="flex gap-3">
            <button onClick={() => setShowTable(!showTable)} aria-pressed={showTable} className="ctl">
              {showTable ? 'Hide table' : 'Show as table'}
            </button>
            <button onClick={() => setShowMath(!showMath)} aria-pressed={showMath} className="ctl">
              {showMath ? 'Hide math' : 'Show math'}
            </button>
          </div>
          {showTable && (
            <Section title="Capital stacks">
              <table className="w-full text-sm">
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
                    <tr key={s.site_id}>
                      <td className={td} title={s.site_id}>
                        {label(s.site_id)}
                      </td>
                      <td className={`${td} tabular-nums`}>
                        <FactorHover keys={s.assumptions}>{fmtUsd(s.total_cost_usd)}</FactorHover>
                      </td>
                      <td className={`${td} tabular-nums`}>{fmtUsd(s.gap_usd)}</td>
                      <td className={`${td} ${s.pencils ? 'text-emerald-300' : 'text-gap'}`}>{s.pencils ? 'yes' : 'no'}</td>
                      <td className={td}>{siteById.get(s.site_id)?.status ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
          {showMath && (
            <div className="space-y-2">
              {stacks.map((s) => (
                <div key={s.site_id}>
                  <div className="mb-0.5 text-xs font-semibold">{label(s.site_id)}</div>
                  <MathRow s={s} />
                </div>
              ))}
            </div>
          )}
          {showTable && stacks.some((s) => s.gap_to_pencil) && (
            <Section title="Gap to pencil, every site">
              <ul className="space-y-1.5 text-[13px]">
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
