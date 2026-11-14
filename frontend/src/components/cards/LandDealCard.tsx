import { usePlan } from '../../state/PlanContext'
import { humanize, siteNames } from '../../format'
import { siteLetters, STRATEGY_COLORS } from '../../mapLayers'
import { CardShell, Empty } from './common'
import FactorHover from '../FactorHover'
import { SourcedValue } from '../SourceBadge'

const DEAL_KEYS = ['deal_vacancy_for_acquisition', 'deal_long_hold_years', 'deal_lease_pass_years']

export default function LandDealCard() {
  const { state, dispatch } = usePlan()
  const { plan } = state
  const deals = plan.deals
  const sites = plan.sites ?? []
  const letters = siteLetters(sites)
  const siteById = new Map(sites.map((s) => [s.id, s]))
  const names = siteNames(plan)
  return (
    <CardShell title="Land deal" note={plan.notes?.land_deal}>
      {!deals ? (
        <Empty>Waiting for the land deal agent…</Empty>
      ) : deals.length === 0 ? (
        <Empty>No sites to approach.</Empty>
      ) : (
        <ul className="space-y-3">
          {deals.map((d) => {
            const s = siteById.get(d.site_id)
            const parcel = s ? plan.parcels?.find((p) => p.id === s.parcel_ids[0]) : undefined
            const c = STRATEGY_COLORS[d.strategy]
            const title = names.get(d.site_id) ?? d.site_id
            return (
              <li key={d.site_id} className="border-t border-rule pt-3 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  {letters.get(d.site_id) && <span className="font-bold">{letters.get(d.site_id)}</span>}
                  <button
                    className="font-medium hover:underline"
                    onClick={() =>
                      s && dispatch({ type: 'select', selected: { parcelId: s.parcel_ids[0], buildingId: s.building_id ?? undefined } })
                    }
                  >
                    {title}
                  </button>
                  <FactorHover keys={DEAL_KEYS}>
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                      <span aria-hidden className="inline-block h-2.5 w-2.5 border border-ink" style={{ background: `rgb(${c[0]},${c[1]},${c[2]})` }} />
                      {humanize(d.strategy)}
                    </span>
                  </FactorHover>
                </div>
                {parcel && (
                  <div className="mb-1 text-xs text-neutral-400">
                    owner: <SourcedValue s={parcel.owner} />
                  </div>
                )}
                <ul className="list-disc pl-5 text-neutral-300">
                  {d.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                {d.letter_draft && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-sky-400">Draft outreach letter</summary>
                    <pre className="mt-1 rounded bg-neutral-950 p-2 text-xs whitespace-pre-wrap text-neutral-300">{d.letter_draft}</pre>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </CardShell>
  )
}
