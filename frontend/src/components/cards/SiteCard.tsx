import { usePlan } from '../../state/PlanContext'
import { fmtNum, humanize, parcelLabel, buildingLabel } from '../../format'
import { siteLetters, UNDERUSED_LAND_USES } from '../../mapLayers'
import { CardShell, Empty, Section, td, th } from './common'
import FactorHover from '../FactorHover'

const STATUS_CLS = {
  pursue: 'text-emerald-300',
  watch: 'text-amber-300',
  reserve: 'text-slate',
  pass: 'text-neutral-500',
} as const

export default function SiteCard() {
  const { state, dispatch } = usePlan()
  const { plan } = state
  const underused = (plan.parcels ?? []).filter((p) => UNDERUSED_LAND_USES[p.land_use.value ?? ''])
  const sites = plan.sites
  const letters = sites ? siteLetters(sites) : new Map<string, string>()
  const parcelsById = new Map((plan.parcels ?? []).map((p) => [p.id, p]))
  const buildingsById = new Map((plan.buildings ?? []).map((b) => [b.id, b]))
  return (
    <CardShell title="Site" note={plan.notes?.site}>
      {!plan.parcels ? (
        <Empty>Waiting for parcels…</Empty>
      ) : (
        <Section title="Underused parcels">
          <p className="text-sm">
            {fmtNum(underused.length)} of {fmtNum(plan.parcels.length)} parcels are surface parking, vacant or one-story retail.
          </p>
        </Section>
      )}
      <Section
        title="Sites"
        right={
          <FactorHover keys={['site_rank_weights', 'sites_top_n', 'newbuild_assumed_stories', 'story_height_ft']}>
            <span className="text-[11px] text-neutral-400">ranking factors</span>
          </FactorHover>
        }
      >
        {!sites ? (
          <Empty>Waiting for the site agent…</Empty>
        ) : sites.length === 0 ? (
          <Empty>No sites selected.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}></th>
                <th className={th}>Site</th>
                <th className={th}>Kind</th>
                <th className={th}>Homes</th>
                <th className={th}>Height</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr
                  key={s.id}
                  className="cursor-pointer border-t border-neutral-900 hover:bg-neutral-900"
                  onClick={() =>
                    dispatch({ type: 'select', selected: { parcelId: s.parcel_ids[0], buildingId: s.building_id ?? undefined } })
                  }
                >
                  <td className={`${td} font-bold`}>{letters.get(s.id) ?? ''}</td>
                  <td className={td}>
                    {s.building_id
                      ? buildingLabel(buildingsById.get(s.building_id), s.building_id)
                      : parcelLabel(parcelsById.get(s.parcel_ids[0]), s.parcel_ids[0])}
                    {s.parcel_ids.length > 1 && <span className="text-neutral-500"> +{s.parcel_ids.length - 1} parcels</span>}
                  </td>
                  <td className={td}>{humanize(s.kind)}</td>
                  <td className={`${td} tabular-nums`}>{fmtNum(s.homes)}</td>
                  <td className={`${td} tabular-nums`}>{fmtNum(s.height_ft)} ft</td>
                  <td className={`${td} ${STATUS_CLS[s.status]}`}>{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </CardShell>
  )
}
