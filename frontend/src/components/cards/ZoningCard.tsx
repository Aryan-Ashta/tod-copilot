import { useMemo } from 'react'
import { usePlan } from '../../state/PlanContext'
import { useApp } from '../../state/AppContext'
import { EnvelopeFigures } from './EnvelopeFigures'
import { fmtNum, fmtValue, humanize, parcelLabel } from '../../format'
import { CardShell, CiteList, Empty, Section } from './common'
import { SourcedValue } from '../SourceBadge'
import type { LegalPath, Plan, ZoningEnvelope } from '../../types'

function PathColumn({ path, recommended }: { path: LegalPath; recommended: boolean }) {
  const status =
    path.eligible === null
      ? { text: 'not covered', cls: 'text-slate' }
      : path.eligible
        ? { text: 'eligible', cls: 'text-emerald-300' }
        : { text: 'not eligible', cls: 'text-gap' }
  const missing = Array.isArray(path.allows.missing_inputs) ? (path.allows.missing_inputs as string[]) : []
  const allows = path.eligible ? Object.entries(path.allows) : []
  return (
    <div className={`border-t-2 pt-2 ${recommended ? 'border-ink' : 'border-rule'}`}>
      <div className="mb-1 font-semibold">{path.name}</div>
      <div className="mb-2 flex flex-wrap items-baseline gap-3 text-xs">
        <span className={status.cls}>{status.text}</span>
        {recommended && <span className="font-semibold">recommended</span>}
      </div>
      {path.homes !== undefined && path.homes !== null && (
        <div className="mb-2 text-sm">
          <span className="font-semibold tabular-nums">{fmtNum(path.homes)}</span>{' '}
          <span className="text-neutral-400">homes on this parcel</span>
        </div>
      )}
      {path.eligible === null && (
        <p className="mb-2 text-xs text-neutral-400">
          {!missing.length
            ? 'The curated corpus does not cover this question for this parcel.'
            : missing.includes('property_type')
              ? "Not covered here: no existing building is on record for this parcel, so this path's rules cannot be applied."
              : `Not covered here: the rules need ${missing.map(humanize).join(', ')}, which this parcel's building does not have on record.`}
        </p>
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
      <CiteList
        citations={path.citations}
        label={path.eligible === false ? 'Why not eligible:' : path.eligible === null ? 'Rule not covered:' : undefined}
      />
    </div>
  )
}

function PickLine({ env }: { env: ZoningEnvelope }) {
  const rec = env.paths.find((p) => p.name === env.recommended_path)
  if (!rec) return <p className="text-xs text-neutral-400">No eligible path, so nothing is recommended here.</p>
  const others = env.paths.filter((p) => p.eligible && p.name !== rec.name)
  if (!others.length) return <p className="text-xs text-neutral-300">Pick: {rec.name}, the only eligible path.</p>
  const tie = others.every((o) => (o.homes ?? 0) === (rec.homes ?? 0))
  return (
    <p className="text-xs text-neutral-300">
      Pick: <span className="font-medium text-emerald-300">{rec.name}</span>
      {tie
        ? ', same homes as the alternative; fewer approval steps wins the tie.'
        : `, ${fmtNum(rec.homes)} homes vs ${others.map((o) => `${fmtNum(o.homes)} under ${o.name}`).join(', ')} (most homes wins).`}
    </p>
  )
}

/** Up to 3 addressed parcels where 2+ paths are eligible with different homes: the less often recommended path
 *  first (the surprising pick), then the building's best reuse score, then the larger homes gain. Plan data only. */
function bothLawExamples(plan: Partial<Plan>): { id: string; label: string; at: [number, number] }[] {
  const envs = plan.envelopes ?? []
  const centroid = plan.precomputed?.centroid ?? {}
  const parcels = new Map((plan.parcels ?? []).map((p) => [p.id, p]))
  const recCount = new Map<string, number>()
  for (const e of envs) if (e.recommended_path) recCount.set(e.recommended_path, (recCount.get(e.recommended_path) ?? 0) + 1)
  const reuseScore = new Map<string, number>()
  const parcelOf = new Map((plan.buildings ?? []).map((b) => [b.id, b.parcel_id]))
  for (const c of plan.conversions ?? []) {
    const pid = parcelOf.get(c.building_id)
    if (pid) reuseScore.set(pid, Math.max(reuseScore.get(pid) ?? 0, c.overall))
  }
  return envs
    .flatMap((e) => {
      const el = e.paths.filter((p) => p.eligible && p.homes != null)
      const homes = el.map((p) => p.homes as number)
      const addr = parcels.get(e.parcel_id)?.address.value
      const at = centroid[e.parcel_id]
      if (el.length < 2 || new Set(homes).size < 2 || !e.recommended_path || !addr || !at) return []
      return [{ id: e.parcel_id, label: addr, at, rarity: recCount.get(e.recommended_path) ?? 0,
                score: reuseScore.get(e.parcel_id) ?? 0, gain: Math.max(...homes) - Math.min(...homes) }]
    })
    .sort((a, b) => a.rarity - b.rarity || b.score - a.score || b.gain - a.gain)
    .slice(0, 3)
}

export default function ZoningCard() {
  const { state, dispatch } = usePlan()
  const { plan, selected } = state
  const { factorNumber } = useApp()
  const envelopes = plan.envelopes
  const examples = useMemo(() => bothLawExamples(plan), [plan])

  const summary = useMemo(() => {
    const byPath = new Map<string, number>()
    let covered = 0
    for (const e of envelopes ?? []) {
      if (e.covered) covered++
      if (e.recommended_path) byPath.set(e.recommended_path, (byPath.get(e.recommended_path) ?? 0) + 1)
    }
    const agentVerified = (envelopes ?? []).some((e) =>
      e.paths.some((p) => p.citations.some((c) => c.status === 'agent_verified')),
    )
    return { covered, byPath: [...byPath.entries()], agentVerified }
  }, [envelopes])

  const parcelId = selected.parcelId
  const env = parcelId ? envelopes?.find((e) => e.parcel_id === parcelId) : undefined
  const parcel = parcelId ? plan.parcels?.find((p) => p.id === parcelId) : undefined
  // the building an adaptive-reuse path would keep: the largest on the parcel (as the zoning agent picks it)
  const building = useMemo(
    () =>
      (plan.buildings ?? [])
        .filter((b) => b.parcel_id === parcelId)
        .sort((a, b) => (b.rentable_area_sqft.value ?? 0) - (a.rentable_area_sqft.value ?? 0))[0],
    [plan.buildings, parcelId],
  )

  return (
    <CardShell title="Zoning & legislation" note={plan.notes?.zoning_legislation}>
      {summary.agentVerified && (
        <p className="mb-3 border-l-2 border-amber-400 pl-3 text-sm text-neutral-300">
          Legal rules here were built by the corpus agent from official text. Every quote is checked word for word
          against the source page, but no person has reviewed them yet.
        </p>
      )}
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
              <div className="space-y-2">
                <Empty>Click a parcel on the map to see each legal path.</Empty>
                {examples.length > 0 && (
                  <div className="text-sm">
                    <div className="text-neutral-400">Example where both laws apply:</div>
                    <ul className="mt-1 space-y-0.5">
                      {examples.map((x) => (
                        <li key={x.id}>
                          <button
                            title={`parcel ${x.id}`}
                            className="text-left text-sky-300 hover:underline"
                            onClick={() => dispatch({ type: 'select', selected: { parcelId: x.id, flyTo: [x.at[0], x.at[1]] } })}
                          >
                            {x.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
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
                </div>
                {!env ? (
                  <Empty>
                    Not a candidate parcel (not underused and no convertible building), so no legal paths were evaluated here.
                  </Empty>
                ) : (
                  <>
                    <PickLine env={env} />
                    <EnvelopeFigures env={env} parcel={parcel} building={building} storyFt={factorNumber('story_height_ft')} />
                    <div className={`grid gap-2 ${env.paths.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                      {env.paths.map((p) => (
                        <PathColumn key={p.name} path={p} recommended={env.recommended_path === p.name} />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </Section>
        </>
      )}
    </CardShell>
  )
}
