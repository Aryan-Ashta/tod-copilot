import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { areaCheck, createPlan, geocode, getLocales, parsePrompt, stockPrompts } from '../api'
import Disclaimer from '../components/Disclaimer'
import AreaPicker, { type PolygonGeometry } from '../components/AreaPicker'
import { LocalePoster } from '../components/LocalePosters'
import type { BBox } from '../geo'
import {
  DEFAULT_PLAN_OPTIONS,
  type AreaCheck,
  type GeocodeResult,
  type Locale,
  type PlanGoals,
  type PlanOptions,
  type StockPrompt,
} from '../types'

const REPLAY_HINT = 'Replays exist only for whole recorded areas with default options; this runs live'

const OPTION_GROUPS: { key: 'focus'; legend: string; choices: [string, string][] }[] = [
  { key: 'focus', legend: 'Focus', choices: [['all', 'All'], ['conversions', 'Conversions only'], ['new_build', 'New construction only']] },
]

const GOAL_FIELDS: { key: keyof PlanGoals; label: string; max?: number; placeholder?: string }[] = [
  { key: 'affordable_homes', label: 'New affordable homes' },
  { key: 'total_homes', label: 'New homes total' },
  { key: 'conversions', label: 'Buildings converted' },
  { key: 'transit_coverage_pct', label: 'Transit coverage %', max: 100, placeholder: '90 (default)' },
]

function SectionHead({ children }: { children: ReactNode }) {
  return <h2 className="wide mt-16 mb-5 border-t-2 border-ink pt-4 text-[22.5px] leading-tight font-bold">{children}</h2>
}

export default function PromptScreen() {
  const navigate = useNavigate()
  const [locales, setLocales] = useState<Locale[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [boundary, setBoundary] = useState<PolygonGeometry | null>(null)
  const [areaName, setAreaName] = useState<string | null>(null)
  const [flyTo, setFlyTo] = useState<BBox | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeocodeResult[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [stock, setStock] = useState<StockPrompt[]>([])
  const [prompt, setPrompt] = useState('')
  const [options, setOptions] = useState<PlanOptions>(DEFAULT_PLAN_OPTIONS)
  const [focusTouched, setFocusTouched] = useState(false)
  const [replay, setReplay] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const parseSeq = useRef(0)

  useEffect(() => {
    getLocales()
      .then((ls) => {
        setLocales(ls)
        if (ls.length) setSelected((s) => s ?? ls[0].id)
      })
      .catch((e: Error) => setError(e.message))
    stockPrompts()
      .then(setStock)
      .catch(() => {
        // chips are optional; the free-text prompt still works
      })
  }, [])

  // Free text steers the focus until the user picks one.
  useEffect(() => {
    if (focusTouched || !prompt.trim()) return
    const seq = ++parseSeq.current
    const t = setTimeout(() => {
      parsePrompt(prompt)
        .then((p) => {
          if (seq === parseSeq.current) setOptions((o) => ({ ...o, focus: p.focus }))
        })
        .catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [prompt, focusTouched])

  // Server decides what a drawn boundary runs as (sub-area, metro, or rejected).
  const [check, setCheck] = useState<AreaCheck | null>(null)
  const checkSeq = useRef(0)
  useEffect(() => {
    const seq = ++checkSeq.current
    setCheck(null)
    if (!boundary) return
    const t = setTimeout(() => {
      areaCheck(boundary)
        .then((c) => {
          if (seq === checkSeq.current) setCheck(c)
        })
        .catch((e: Error) => {
          if (seq === checkSeq.current) setError(e.message)
        })
    }, 200)
    return () => clearTimeout(t)
  }, [boundary])

  const wholeLocale = !boundary ? (locales?.find((x) => x.id === selected) ?? null) : null
  const areaLocaleId = wholeLocale ? wholeLocale.id : check?.kind === 'subarea' ? check.locale_id : null
  const defaultOptions = options.focus === 'all' && Object.values(options.goals).every((v) => v === null)
  const replayAllowed = wholeLocale !== null && defaultOptions
  const replayOn = replay && replayAllowed
  const areaOk = wholeLocale !== null || (check !== null && check.kind !== null && !check.error)
  const canSubmit = areaOk && !submitting && (replayOn || prompt.trim().length > 0)

  const chipLocaleId = areaLocaleId ?? (check?.kind === 'metro' ? check.sources_from : null)
  const visibleStock = stock.filter((p) => p.locale_id === null || p.locale_id === chipLocaleId)

  const onBoundary = (b: PolygonGeometry | null) => {
    setBoundary(b)
    setError(null)
  }

  const pickLocale = (id: string | null) => {
    setSelected(id)
    setBoundary(null)
    setAreaName(null)
    const l = locales?.find((x) => x.id === id)
    if (l) setFlyTo([...l.bbox])
  }

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      setResults(await geocode(query.trim()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const pickResult = (r: GeocodeResult) => {
    setResults(null)
    setFlyTo([...r.bbox])
    if (r.recorded_locale_id) {
      setSelected(r.recorded_locale_id)
      setAreaName(null)
    } else {
      setSelected(null)
      setAreaName(r.label)
    }
  }

  const pickStock = (p: StockPrompt) => {
    setPrompt(p.prompt)
    setOptions({
      ...DEFAULT_PLAN_OPTIONS,
      ...p.options,
      goals: { ...DEFAULT_PLAN_OPTIONS.goals, ...p.options.goals },
    })
    setFocusTouched(false)
    parseSeq.current++ // drop any in-flight parse of the old text
  }

  const setFocus = (v: PlanOptions['focus']) => {
    setOptions((o) => ({ ...o, focus: v }))
    setFocusTouched(true)
  }

  const setGoal = (k: keyof PlanGoals, raw: string) => {
    const n = raw.trim() === '' ? null : Number(raw)
    setOptions((o) => ({ ...o, goals: { ...o.goals, [k]: n === null || Number.isNaN(n) ? null : n } }))
  }

  const submit = async () => {
    if (!canSubmit) return
    if (replayOn && areaLocaleId) {
      navigate(`/plan/demo-${areaLocaleId}?replay=1`)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { plan_id } = await createPlan({
        locale_id: areaLocaleId,
        boundary,
        area_name: boundary ? areaName : null,
        prompt: prompt.trim(),
        options,
      })
      navigate(`/plan/${plan_id}`)
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Disclaimer />
      <div className="flex-1 overflow-y-auto">
        <main className="mx-auto w-full max-w-[1080px] px-6 pt-10 pb-24">
          <h1 className="wide mb-4 text-[44px] leading-[1.15] font-bold tracking-[-0.005em]">Plan transit and the homes around it</h1>
          <p className="mb-12 max-w-[68ch] text-[22.5px] leading-[1.45]">
            One prompt: existing transit and infrastructure, buildings that can be converted, land that can be built on, what
            the law allows, how to get the land and pay for it, and how the plan scores on carbon and health.
          </p>
          {error && <p className="mb-6 border-l-2 border-gap pl-4 text-gap">{error}</p>}

          <div className="grid grid-cols-1 gap-12 md:grid-cols-3">
            {!locales && !error && <p className="text-slate">Loading locales…</p>}
            {locales?.map((l, i) => {
              const on = areaLocaleId === l.id
              return (
                <button
                  key={l.id}
                  onClick={() => pickLocale(l.id)}
                  aria-pressed={on}
                  className="group flex flex-col justify-start text-left"
                >
                  <LocalePoster locale={l} index={i} />
                  <span className={`mt-3 block border-b pb-2 text-sm ${on ? 'border-ink' : 'border-transparent group-hover:border-rule'}`}>
                    <span className="font-semibold">{l.name}</span>
                    <span className="mt-0.5 block text-slate">{l.purpose}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <SectionHead>Or search and draw an area</SectionHead>
          <form
            className="relative mb-4 flex items-end gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void search()
            }}
          >
            <label className="flex-1">
              <span className="block text-sm text-slate">Place in any US county</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search a US city or address"
                className="w-full border-0 border-b border-ink bg-transparent py-1.5 text-[18px] placeholder:text-slate/70 focus:outline-none focus-visible:outline-2"
              />
            </label>
            <button type="submit" disabled={searching || !query.trim()} className="ctl">
              {searching ? 'Searching…' : 'Search'}
            </button>
            {results && (
              <ul className="absolute top-full right-0 left-0 z-20 mt-1 border border-rule bg-paper">
                {results.length === 0 && <li className="px-3 py-2 text-sm text-slate">No matches in a US county</li>}
                {results.map((r, i) => (
                  <li key={`${r.label}-${i}`} className="border-b border-rule last:border-b-0">
                    <button
                      type="button"
                      onClick={() => pickResult(r)}
                      className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-ink/5"
                    >
                      <span>{r.label}</span>
                      <span className="text-slate">{r.recorded_locale_id ? 'recorded' : r.metro}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </form>

          <div className="border border-rule">
            <AreaPicker
              locales={locales ?? []}
              selectedLocale={selected}
              boundary={boundary}
              onBoundary={onBoundary}
              onLocale={pickLocale}
              flyTo={flyTo}
            />
          </div>
          <p className="mt-2 text-sm">
            {!boundary && !wholeLocale && <span className="text-slate">Pick a recorded area or draw a boundary</span>}
            {wholeLocale && <span>Whole recorded area: {wholeLocale.name}</span>}
            {boundary && !check && <span className="text-slate">Checking the drawn area…</span>}
            {check?.error && <span className="text-gap">{check.error}</span>}
            {check && !check.error && check.kind === 'subarea' && (
              <span>
                {check.label} · recorded data · {check.area_km2?.toFixed(1)} km²
              </span>
            )}
            {check && !check.error && check.kind === 'metro' && (
              <span>
                {check.label} · recorded live from county, CoStar and imagery sources (a few minutes) · {check.area_km2?.toFixed(1)} km²
              </span>
            )}
          </p>

          <SectionHead>Prompt</SectionHead>
          {visibleStock.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {visibleStock.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickStock(p)}
                  title={p.prompt}
                  className="border-b border-rule pb-px text-left hover:border-ink"
                >
                  {p.title}
                </button>
              ))}
            </div>
          )}
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            aria-label="Prompt"
            placeholder="e.g. Plan transit-oriented development around the rail stations"
            className="mb-6 w-full border border-rule bg-transparent p-3 text-[18px] placeholder:text-slate/70 focus:border-ink focus:outline-none"
          />

          <div className="mb-8 flex flex-wrap gap-x-12 gap-y-4">
            {OPTION_GROUPS.map((g) => (
              <fieldset key={g.key}>
                <legend className="mb-1 text-sm text-slate">{g.legend}</legend>
                <div className="flex flex-wrap gap-x-4 text-[15px]">
                  {g.choices.map(([v, label]) => (
                    <label key={v} className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name={g.key}
                        value={v}
                        checked={options[g.key] === v}
                        onChange={() => setFocus(v as PlanOptions['focus'])}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <fieldset>
              <legend className="mb-1 text-sm text-slate">Goals (blank = no goal)</legend>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-[15px]">
                {GOAL_FIELDS.map((g) => (
                  <label key={g.key} className="flex items-center gap-2">
                    {g.label}
                    <input
                      type="number"
                      min={0}
                      max={g.max}
                      step={1}
                      placeholder={g.placeholder}
                      value={options.goals[g.key] ?? ''}
                      onChange={(e) => setGoal(g.key, e.target.value)}
                      className="w-28 border border-rule bg-transparent px-2 py-1 tabular-nums focus:border-ink focus:outline-none"
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-5">
            <label
              className={`flex items-center gap-2 text-[15px] ${replayAllowed ? 'cursor-pointer' : 'text-slate'}`}
              title={replayAllowed ? undefined : REPLAY_HINT}
            >
              <input type="checkbox" checked={replayOn} disabled={!replayAllowed} onChange={(e) => setReplay(e.target.checked)} />
              Replay recorded run
            </label>
            {!replayAllowed && <span className="text-sm text-slate">{REPLAY_HINT}</span>}
            <button onClick={submit} disabled={!canSubmit} data-selected="true" className="ctl ml-auto px-8 py-2 text-[16px]">
              {submitting ? 'Starting…' : 'Plan it'}
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}
