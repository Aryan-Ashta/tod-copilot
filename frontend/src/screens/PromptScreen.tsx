import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { areaCheck, createPlan, geocode, getLocales, parsePrompt, stockPrompts } from '../api'
import Disclaimer from '../components/Disclaimer'
import AreaPicker, { type PolygonGeometry } from '../components/AreaPicker'
import { LocalePoster } from '../components/LocalePosters'
import Segmented from '../components/Segmented'
import Slider from '../components/Slider'
import { useApp } from '../state/AppContext'
import type { BBox } from '../geo'
import {
  DEFAULT_PLAN_OPTIONS,
  type AreaCheck,
  type GeocodeResult,
  type Locale,
  type PlanOptions,
  type StockPrompt,
} from '../types'

const REPLAY_HINT = 'Replays exist only for whole recorded areas with default options; this runs live'

/** Recorded locale whose stock prompts also apply to a drawn metro area, by the city named in the area_check label. */
function metroLocaleId(label: string | null): string | null {
  if (!label) return null
  if (label.includes('Houston')) return 'houston_downtown'
  if (label.includes('Los Angeles')) return 'la_wilshire_koreatown'
  return null
}

const FOCUS: { value: PlanOptions['focus']; label: string }[] = [
  { value: 'all', label: 'Both' },
  { value: 'conversions', label: 'Conversions' },
  { value: 'new_build', label: 'New construction' },
]
// Slider ranges are UI limits, not model factors: the backend accepts any multiplier above 0 and any share 0-1.
const BUDGET_RANGE = { min: 0.25, max: 3, step: 0.05 }
const AFFORDABLE_RANGE = { min: 0, max: 0.6, step: 0.05 }

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
  const [optionsTouched, setOptionsTouched] = useState(false)
  const [replay, setReplay] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const parseSeq = useRef(0)
  const mapBoxRef = useRef<HTMLDivElement>(null)
  const { factorNumber } = useApp()

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

  // Free text steers the options until the user edits a select.
  useEffect(() => {
    if (optionsTouched || !prompt.trim()) return
    const seq = ++parseSeq.current
    const t = setTimeout(() => {
      parsePrompt(prompt)
        .then((o) => {
          if (seq === parseSeq.current) setOptions(o)
        })
        .catch(() => {})
    }, 300)
    return () => clearTimeout(t)
  }, [prompt, optionsTouched])

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
  const defaultOptions =
    options.focus === 'all' && options.transit_budget_multiplier === 1 && options.affordable_share === null
  const replayAllowed = wholeLocale !== null && defaultOptions
  const replayOn = replay && replayAllowed
  const areaOk = wholeLocale !== null || (check !== null && check.kind !== null && !check.error)
  const canSubmit = areaOk && !submitting && (replayOn || prompt.trim().length > 0)

  const chipLocaleId = areaLocaleId ?? (check?.kind === 'metro' ? metroLocaleId(check.label) : null)
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

  // A poster click picks the area and brings the map into view, where it flies to that area.
  const pickPoster = (id: string) => {
    pickLocale(id)
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    mapBoxRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
  }

  // The sliders show real numbers: the locale's transit budget times the multiplier (just the multiplier until a
  // locale is known), and the affordable share (factors.yaml affordable_share until the user moves it).
  const budgetBase = chipLocaleId ? factorNumber('transit_budget_usd', chipLocaleId) : null
  const budgetText = (m: number) => (budgetBase === null ? `${m}×` : `$${Number(((budgetBase * m) / 1e6).toFixed(2))}M/yr`)
  const defaultShare = factorNumber('affordable_share') ?? 0
  const share = options.affordable_share ?? defaultShare

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
    setOptions(p.options)
    setOptionsTouched(false)
    parseSeq.current++ // drop any in-flight parse of the old text
  }

  const setOption = <K extends keyof PlanOptions>(k: K, v: PlanOptions[K]) => {
    setOptions((o) => ({ ...o, [k]: v }))
    setOptionsTouched(true)
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
                  onClick={() => pickPoster(l.id)}
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
              <span className="block text-sm text-slate">Place in Harris County or Los Angeles County</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search Houston or Los Angeles"
                className="w-full border-0 border-b border-ink bg-transparent py-1.5 text-[18px] placeholder:text-slate/70 focus:outline-none focus-visible:outline-2"
              />
            </label>
            <button type="submit" disabled={searching || !query.trim()} className="ctl">
              {searching ? 'Searching…' : 'Search'}
            </button>
            {results && (
              <ul className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-xl border border-rule bg-paper shadow-[0_8px_24px_rgb(28_34_48/.12)]">
                {results.length === 0 && <li className="px-3 py-2 text-sm text-slate">No matches in Harris County or Los Angeles County</li>}
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

          <div ref={mapBoxRef} className="scroll-mt-6 overflow-hidden rounded-[12px] border border-rule">
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
            className="mb-6 w-full rounded-xl border border-rule bg-transparent p-3 text-[18px] placeholder:text-slate/70 focus:border-ink focus:outline-none"
          />

          <div className="mb-8 grid grid-cols-1 gap-x-12 gap-y-8 md:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,0.7fr)]">
            <div>
              <div className="mb-2 text-sm text-slate">Focus</div>
              <Segmented label="Focus" options={FOCUS} value={options.focus} onChange={(v) => setOption('focus', v)} />
            </div>
            <div>
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <span className="text-slate">Transit budget</span>
                <span className="font-semibold tabular-nums">{budgetText(options.transit_budget_multiplier)}</span>
              </div>
              <Slider
                label="Transit budget"
                {...BUDGET_RANGE}
                value={options.transit_budget_multiplier}
                valueText={budgetText(options.transit_budget_multiplier)}
                marks={[BUDGET_RANGE.min, 1, BUDGET_RANGE.max].map((m) => ({ value: m, label: budgetText(m) }))}
                onChange={(m) => setOption('transit_budget_multiplier', m)}
              />
            </div>
            <div>
              <div className="mb-2 flex items-baseline justify-between text-sm">
                <span className="text-slate">Affordable homes</span>
                <span className="font-semibold tabular-nums">{Math.round(share * 100)}% of homes</span>
              </div>
              <Slider
                label="Affordable homes"
                {...AFFORDABLE_RANGE}
                value={share}
                valueText={`${Math.round(share * 100)}% of homes affordable`}
                marks={[AFFORDABLE_RANGE.min, defaultShare, AFFORDABLE_RANGE.max].map((s) => ({ value: s, label: `${Math.round(s * 100)}%` }))}
                color="var(--color-green)"
                // back on the factors.yaml share counts as the default, so replays stay available
                onChange={(s) => setOption('affordable_share', Math.abs(s - defaultShare) < 1e-9 ? null : s)}
              />
            </div>
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
