import { useMemo, useState } from 'react'
import { usePlan } from '../../state/PlanContext'
import { useApp } from '../../state/AppContext'
import { buildingLabel, fmtNum, geometryCentroid, humanize } from '../../format'
import { CardShell, CiteList, Empty, Section, td, th } from './common'
import SourceBadge, { SourcedValue } from '../SourceBadge'
import FactorHover, { FactorText } from '../FactorHover'
import { MassingFigure, USE_HEX } from './MassingFigure'
import type { Building, ConversionCandidate, FitName, Sourced, UseType } from '../../types'

const FITS: FitName[] = ['physical', 'legal', 'market', 'financial', 'location']
const SCORE_KEYS = ['reuse_weights', 'reuse_physical_weights', 'reuse_location_weights', 'reuse_keep_margin', 'reuse_feasible_threshold']
const SHOWN = 60

type SourcedKey = Exclude<keyof Building, 'id' | 'parcel_id' | 'footprint' | 'osm_id' | 'name'>
const ATTRS: { key: SourcedKey; label: string; unit?: string }[] = [
  { key: 'property_type', label: 'Current use' },
  { key: 'building_class', label: 'Class' },
  { key: 'year_built', label: 'Year built' },
  { key: 'year_renovated', label: 'Renovated' },
  { key: 'stories', label: 'Stories' },
  { key: 'rentable_area_sqft', label: 'Rentable area', unit: 'sq ft' },
  { key: 'typical_floor_sqft', label: 'Typical floor', unit: 'sq ft' },
  { key: 'floor_depth_ft', label: 'Floor depth', unit: 'ft' },
  { key: 'ceiling_height_ft', label: 'Ceiling height', unit: 'ft' },
  { key: 'window_wall_pct', label: 'Window wall', unit: '%' },
  { key: 'vacancy_pct', label: 'Vacancy', unit: '%' },
  { key: 'asking_rent_usd_sqft_yr', label: 'Asking rent', unit: '$/sq ft/yr' },
  { key: 'parking_spaces', label: 'Parking spaces' },
  { key: 'roof_area_sqft', label: 'Roof area', unit: 'sq ft' },
]

function Detail({ b, c }: { b: Building | undefined; c: ConversionCandidate }) {
  const { factorNumber } = useApp()
  const uses = Object.keys(c.scores_by_use) as UseType[]
  const [use, setUse] = useState<UseType>(c.best_use)
  const details = c.details.filter((d) => d.use === use)
  const fit = c.scores_by_use[c.best_use]
  const limitKey = c.best_use === 'keep_current' ? null : `reuse_max_floor_depth_ft_${c.best_use}`
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="wide text-[22.5px] font-bold">{buildingLabel(b, c.building_id)}</span>
        {b && <SourceBadge prov={b.name.prov} />}
        <span className="text-sm">
          best use <span className="font-semibold" style={{ borderBottom: `2px solid ${USE_HEX[c.best_use]}` }}>{humanize(c.best_use)}</span>
        </span>
        <span className="text-sm text-slate">confidence {c.confidence}</span>
        {c.screening_only && <span className="text-sm text-amber-300">screening only</span>}
      </div>
      {b && (
        <figure className="rounded-xl border border-rule px-3 pt-3 pb-2">
          <MassingFigure
            b={b}
            use={c.best_use}
            storyFt={factorNumber('story_height_ft')}
            limitFt={limitKey ? factorNumber(limitKey) : null}
          />
          <figcaption className="mt-2 text-[13px] text-slate">
            {fmtNum(b.stories.value)} stories on a square plate of the typical floor area; floors drawn in the best-use
            colour change use. On the roof, the dashed square is the{' '}
            {limitKey ? (
              <FactorHover keys={[limitKey, 'story_height_ft']}>
                <span>depth limit</span>
              </FactorHover>
            ) : (
              'depth limit'
            )}{' '}
            measured in from the windows; red is floor area between that line and the core, too far from a window.
          </figcaption>
        </figure>
      )}
      {fit && (
        <Section title={`Fit scores · ${humanize(c.best_use)}`}>
          <ul className="space-y-1 text-sm">
            {FITS.map((f) => (
              <li key={f} className="grid grid-cols-[6rem_1fr_3rem] items-center gap-3">
                <span>{f}</span>
                <span className="h-2 overflow-hidden rounded-full bg-rule">
                  <span className="block h-full" style={{ width: `${Math.max(0, Math.min(1, fit[f])) * 100}%`, background: USE_HEX[c.best_use] === '#c4c9c1' ? '#5F6778' : USE_HEX[c.best_use] }} />
                </span>
                <span className="text-right tabular-nums">{fmtNum(fit[f], 2)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <FactorHover keys={SCORE_KEYS}>
            <span className="text-neutral-400">overall</span>
          </FactorHover>{' '}
          <span className="font-semibold tabular-nums">{fmtNum(c.overall, 2)}</span>
        </div>
        <div>
          <FactorHover keys={['reuse_efficiency_factor', 'avg_unit_sqft_residential']}>
            <span className="text-neutral-400">est. units</span>
          </FactorHover>{' '}
          <span className="font-semibold tabular-nums">{c.est_units === null ? 'missing' : fmtNum(c.est_units)}</span>
        </div>
        <div className="col-span-2">
          <FactorHover keys={['embodied_co2_kg_per_sqft_new', 'embodied_co2_kg_per_sqft_reuse']}>
            <span className="text-neutral-400">embodied CO₂ saved</span>
          </FactorHover>{' '}
          <span className="tabular-nums">
            {c.embodied_co2_saved_tonnes === null ? '—' : `${fmtNum(c.embodied_co2_saved_tonnes)} t`}
          </span>
        </div>
      </div>
      <Section title="Blockers">
        {c.blockers.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-amber-200">
            {c.blockers.map((x) => (
              <li key={x}>
                <FactorText text={x} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      {c.legal_path && (
        <Section title="Legal path">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{c.legal_path.name}</span>
            <span className="text-xs text-neutral-400">
              {c.legal_path.eligible === null ? 'not covered' : c.legal_path.eligible ? 'eligible' : 'not eligible'}
            </span>
            <CiteList citations={c.legal_path.citations} />
          </div>
        </Section>
      )}
      <Section
        title="Score inputs"
        right={
          <select
            value={use}
            onChange={(e) => setUse(e.target.value as UseType)}
            className="rounded-md border border-rule bg-paper px-1 text-xs"
          >
            {uses.map((u) => (
              <option key={u} value={u}>
                {humanize(u)}
              </option>
            ))}
          </select>
        }
      >
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className={th}>Fit</th>
              <th className={th}>Input</th>
              <th className={th}>Value</th>
              <th className={th}>Threshold</th>
              <th className={th}>Score</th>
            </tr>
          </thead>
          <tbody>
            {details.map((d, i) => (
              <tr key={i}>
                <td className={td}>{d.fit}</td>
                <td className={td}>{humanize(d.name)}</td>
                <td className={td}>
                  <span className="flex flex-wrap items-center gap-1">
                    {d.value === null ? <span className="italic text-slate">missing</span> : `${typeof d.value === 'number' ? fmtNum(d.value, 2) : d.value} ${d.unit}`}
                    <SourceBadge prov={d.prov} />
                  </span>
                </td>
                <td className={td}>
                  {d.factor_key ? <FactorHover keys={[d.factor_key]}>{d.threshold ?? d.factor_key}</FactorHover> : d.threshold ?? '—'}
                </td>
                <td className={`${td} tabular-nums`}>{fmtNum(d.score, 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      {b && (
        <Section title="Building attributes">
          <dl className="grid grid-cols-1 gap-y-1 text-xs">
            {ATTRS.map(({ key, label, unit }) => {
              const s = b[key] as Sourced<string | number>
              return (
                <div key={key} className="flex items-center justify-between gap-2">
                  <dt className="text-slate">{label}</dt>
                  <dd>
                    <SourcedValue
                      s={s}
                      fmt={(v) =>
                        typeof v !== 'number'
                          ? humanize(String(v))
                          : key.startsWith('year_')
                            ? String(v)
                            : `${fmtNum(v, 1)}${unit ? ` ${unit}` : ''}`
                      }
                    />
                  </dd>
                </div>
              )
            })}
          </dl>
        </Section>
      )}
    </div>
  )
}

export default function BuildingReuseCard() {
  const { state, dispatch } = usePlan()
  const { plan, selected } = state
  const conversions = plan.conversions
  const buildingsById = useMemo(() => new Map((plan.buildings ?? []).map((b) => [b.id, b])), [plan.buildings])
  // Same order as the backend: conversion prospects by overall, then buildings best kept as they are.
  const ranked = useMemo(
    () =>
      [...(conversions ?? [])].sort(
        (a, b) => Number(a.best_use === 'keep_current') - Number(b.best_use === 'keep_current') || b.overall - a.overall,
      ),
    [conversions],
  )
  const sel = selected.buildingId ? conversions?.find((c) => c.building_id === selected.buildingId) : undefined

  return (
    <CardShell title="Building reuse" note={plan.notes?.building_reuse}>
      {!conversions ? (
        <Empty>Waiting for the building reuse agent…</Empty>
      ) : (
        <>
          {selected.buildingId && !sel && <Empty>Selected building is not a conversion candidate.</Empty>}
          {sel && <Detail key={sel.building_id} b={buildingsById.get(sel.building_id)} c={sel} />}
          <Section title={`Ranked candidates (${fmtNum(ranked.length)})`}>
            <div className="max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-paper">
                  <tr>
                    <th className={th}>Building</th>
                    <th className={th}>Current</th>
                    <th className={th}>Best use</th>
                    <th className={th}>
                      <FactorHover keys={SCORE_KEYS}>Overall</FactorHover>
                    </th>
                    <th className={th}>Units</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.slice(0, SHOWN).map((c) => {
                    const b = buildingsById.get(c.building_id)
                    return (
                      <tr
                        key={c.building_id}
                        onClick={() =>
                          dispatch({
                            type: 'select',
                            selected: {
                              buildingId: c.building_id,
                              parcelId: b?.parcel_id,
                              flyTo: geometryCentroid(b?.footprint) ?? undefined,
                            },
                          })
                        }
                        className={`cursor-pointer hover:bg-ink/[0.03] ${selected.buildingId === c.building_id ? 'bg-ink/[0.06]' : ''}`}
                      >
                        <td className={td}>
                          <span className="flex flex-col items-start gap-0.5">
                            <span>{buildingLabel(b, c.building_id)}</span>
                            {b && <SourceBadge prov={b.property_type.prov} />}
                          </span>
                        </td>
                        <td className={td}>{humanize(b?.property_type.value ?? '—')}</td>
                        <td className={td}>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap">
                            <span className="h-2.5 w-2.5" style={{ background: USE_HEX[c.best_use] }} />
                            {humanize(c.best_use)}
                          </span>
                        </td>
                        <td className={`${td} tabular-nums`}>{fmtNum(c.overall, 2)}</td>
                        <td className={`${td} tabular-nums`}>{c.est_units === null ? '—' : fmtNum(c.est_units)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {ranked.length > SHOWN && (
                <p className="mt-1 text-xs text-slate">Showing top {SHOWN}; click buildings on the map for the rest.</p>
              )}
            </div>
          </Section>
        </>
      )}
    </CardShell>
  )
}
