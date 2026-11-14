import { useMemo, useState } from 'react'
import { Legend, PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer } from 'recharts'
import { usePlan } from '../../state/PlanContext'
import { buildingLabel, fmtNum, humanize } from '../../format'
import { CardShell, CiteLink, Empty, Section, td, th } from './common'
import SourceBadge, { SourcedValue } from '../SourceBadge'
import FactorHover from '../FactorHover'
import type { Building, ConversionCandidate, FitName, Sourced, UseType } from '../../types'

const FITS: FitName[] = ['physical', 'legal', 'market', 'financial', 'location']
const USE_HEX: Record<UseType, string> = {
  residential: '#3b82f6',
  hotel: '#a855f7',
  mixed_use: '#14b8a6',
  keep_current: '#8c8c8c',
}
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
  const uses = Object.keys(c.scores_by_use) as UseType[]
  const [use, setUse] = useState<UseType>(c.best_use)
  const radar = FITS.map((fit) => ({ fit, ...Object.fromEntries(uses.map((u) => [u, c.scores_by_use[u]?.[fit] ?? 0])) }))
  const details = c.details.filter((d) => d.use === use)
  return (
    <div className="space-y-3 rounded border border-neutral-800 bg-neutral-900 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{buildingLabel(b, c.building_id)}</span>
        {b && <SourceBadge prov={b.name.prov} />}
        <span className="rounded px-1.5 py-px text-[11px]" style={{ background: USE_HEX[c.best_use] }}>
          best: {humanize(c.best_use)}
        </span>
        <span className="text-xs text-neutral-400">confidence {c.confidence}</span>
        {c.screening_only && <span className="rounded bg-amber-900/70 px-1.5 py-px text-[11px] text-amber-200">screening only</span>}
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={radar} outerRadius="70%">
            <PolarGrid stroke="#404040" />
            <PolarAngleAxis dataKey="fit" tick={{ fill: '#d4d4d4', fontSize: 11 }} />
            <PolarRadiusAxis domain={[0, 1]} tick={{ fill: '#737373', fontSize: 9 }} tickCount={3} />
            {uses.map((u) => (
              <Radar
                key={u}
                dataKey={u}
                name={humanize(u)}
                stroke={USE_HEX[u]}
                fill={USE_HEX[u]}
                fillOpacity={u === c.best_use ? 0.35 : 0.04}
                strokeWidth={u === c.best_use ? 2 : 1}
              />
            ))}
            <Legend wrapperStyle={{ fontSize: 11 }} />
          </RadarChart>
        </ResponsiveContainer>
      </div>
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
              <li key={x}>{x}</li>
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
            {c.legal_path.citations.map((ci, i) => (
              <CiteLink key={i} c={ci} />
            ))}
          </div>
        </Section>
      )}
      <Section
        title="Score inputs"
        right={
          <select
            value={use}
            onChange={(e) => setUse(e.target.value as UseType)}
            className="rounded border border-neutral-700 bg-neutral-950 px-1 text-xs"
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
              <tr key={i} className="border-t border-neutral-800">
                <td className={td}>{d.fit}</td>
                <td className={td}>{humanize(d.name)}</td>
                <td className={td}>
                  <span className="flex flex-wrap items-center gap-1">
                    {d.value === null ? <span className="italic text-neutral-500">missing</span> : `${typeof d.value === 'number' ? fmtNum(d.value, 2) : d.value} ${d.unit}`}
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
                  <dt className="text-neutral-400">{label}</dt>
                  <dd>
                    <SourcedValue
                      s={s}
                      fmt={(v) => (typeof v === 'number' ? `${fmtNum(v, 1)}${unit ? ` ${unit}` : ''}` : humanize(String(v)))}
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
                <thead className="sticky top-0 bg-neutral-950">
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
                          dispatch({ type: 'select', selected: { buildingId: c.building_id, parcelId: b?.parcel_id } })
                        }
                        className={`cursor-pointer border-t border-neutral-900 hover:bg-neutral-900 ${selected.buildingId === c.building_id ? 'bg-neutral-900' : ''}`}
                      >
                        <td className={td}>
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">{buildingLabel(b, c.building_id)}</span>
                            {b && <SourceBadge prov={b.property_type.prov} />}
                          </span>
                        </td>
                        <td className={td}>{humanize(b?.property_type.value ?? '—')}</td>
                        <td className={td}>
                          <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full" style={{ background: USE_HEX[c.best_use] }} />
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
                <p className="mt-1 text-xs text-neutral-500">Showing top {SHOWN}; click buildings on the map for the rest.</p>
              )}
            </div>
          </Section>
        </>
      )}
    </CardShell>
  )
}
