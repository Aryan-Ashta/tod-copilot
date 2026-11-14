import { useMemo } from 'react'
import { usePlan } from '../../state/PlanContext'
import { fmtNum, fmtValue, humanize, parcelLabel } from '../../format'
import { CardShell, CiteLink, Empty, Section } from './common'
import { SourcedValue } from '../SourceBadge'
import type { LegalPath } from '../../types'

function PathColumn({ path, recommended }: { path: LegalPath; recommended: boolean }) {
  const status =
    path.eligible === null
      ? { text: 'not covered', cls: 'bg-neutral-800 text-neutral-300' }
      : path.eligible
        ? { text: 'eligible', cls: 'bg-emerald-900 text-emerald-300' }
        : { text: 'not eligible', cls: 'bg-rose-950 text-rose-300' }
  const allows = Object.entries(path.allows)
  return (
    <div className={`rounded border p-3 ${recommended ? 'border-emerald-600' : 'border-neutral-800'} bg-neutral-900`}>
      <div className="mb-1 font-medium">{path.name}</div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className={`rounded px-1.5 py-px text-[11px] ${status.cls}`}>{status.text}</span>
        {recommended && <span className="rounded bg-emerald-600 px-1.5 py-px text-[11px] text-white">recommended</span>}
      </div>
      {path.eligible === null && (
        <p className="mb-2 text-xs text-neutral-400">The curated corpus does not cover this question for this parcel.</p>
      )}
      {allows.length > 0 && (
        <dl className="mb-2 space-y-0.5 text-xs">
          {allows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-neutral-400">{humanize(k)}</dt>
              <dd className="text-right">{Array.isArray(v) ? v.map((x) => humanize(String(x))).join(', ') : fmtValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-wrap gap-1">
        {path.citations.map((c, i) => (
          <CiteLink key={`${c.doc_id}-${c.section}-${i}`} c={c} />
        ))}
      </div>
    </div>
  )
}

export default function ZoningCard() {
  const { state } = usePlan()
  const { plan, selected } = state
  const envelopes = plan.envelopes

  const summary = useMemo(() => {
    const byPath = new Map<string, number>()
    let covered = 0
    for (const e of envelopes ?? []) {
      if (e.covered) covered++
      if (e.recommended_path) byPath.set(e.recommended_path, (byPath.get(e.recommended_path) ?? 0) + 1)
    }
    return { covered, byPath: [...byPath.entries()] }
  }, [envelopes])

  const parcelId = selected.parcelId
  const env = parcelId ? envelopes?.find((e) => e.parcel_id === parcelId) : undefined
  const parcel = parcelId ? plan.parcels?.find((p) => p.id === parcelId) : undefined
  const homes = parcelId ? plan.precomputed?.homes_by_parcel?.[parcelId] : undefined

  return (
    <CardShell title="Zoning & legislation" note={plan.notes?.zoning_legislation}>
      {!envelopes ? (
        <Empty>Waiting for the zoning agent…</Empty>
      ) : (
        <>
          <Section title="Overview">
            <p className="text-sm text-neutral-300">
              {fmtNum(envelopes.length)} parcels checked, {fmtNum(summary.covered)} covered by the corpus.
            </p>
            {summary.byPath.length > 0 && (
              <ul className="mt-1 text-sm text-neutral-400">
                {summary.byPath.map(([p, n]) => (
                  <li key={p}>
                    Recommended “{p}”: {fmtNum(n)} parcels
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Selected parcel">
            {!parcelId ? (
              <Empty>Click a parcel on the map to see each legal path.</Empty>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1 text-sm">
                  <div className="font-medium">{parcelLabel(parcel, parcelId)}</div>
                  {parcel && (
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-400">
                      <span>
                        zoning code: <SourcedValue s={parcel.zoning_code} />
                      </span>
                      {parcel.zoning_code.value === null && parcel.zoning_code.prov.note && (
                        <span className="text-neutral-300">{parcel.zoning_code.prov.note}</span>
                      )}
                      <span>
                        land use: <SourcedValue s={parcel.land_use} fmt={(v) => humanize(v)} />
                      </span>
                    </div>
                  )}
                  {homes !== undefined && (
                    <div className="text-xs text-neutral-400">
                      New-build homes under the recommended path: {homes === null ? 'no eligible path' : fmtNum(homes)}
                    </div>
                  )}
                </div>
                {!env ? (
                  <Empty>No legal envelope computed for this parcel.</Empty>
                ) : (
                  <div className={`grid gap-2 ${env.paths.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {env.paths.map((p) => (
                      <PathColumn key={p.name} path={p} recommended={env.recommended_path === p.name} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Section>
        </>
      )}
    </CardShell>
  )
}
