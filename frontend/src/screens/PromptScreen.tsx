import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { areaCheck, createPlan, geocode, getLocales, parsePrompt, stockPrompts } from '../api'
import Disclaimer from '../components/Disclaimer'
import AreaPicker, { type PolygonGeometry } from '../components/AreaPicker'
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

const SELECT = 'rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100'

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
    options.focus === 'all' && options.transit_budget === 'default' && options.affordable === 'default'
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
      <div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-10">
        <h1 className="mb-1 text-3xl font-semibold tracking-tight">Plan transit and the homes around it</h1>
        <p className="mb-6 text-neutral-400">
          One prompt: existing transit and infrastructure, buildings that can be converted, land that can be built on, what
          the law allows, how to get the land and pay for it, and how the plan scores on carbon and health.
        </p>
        {error && <div className="mb-4 rounded border border-rose-900 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

        <form
          className="relative mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Houston or Los Angeles"
            className="flex-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-neutral-100 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40"
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
          {results && (
            <ul className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl">
              {results.length === 0 && (
                <li className="px-3 py-2 text-sm text-neutral-500">No matches in Harris County or Los Angeles County</li>
              )}
              {results.map((r, i) => (
                <li key={`${r.label}-${i}`}>
                  <button
                    type="button"
                    onClick={() => pickResult(r)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-800"
                  >
                    <span>{r.label}</span>
                    {r.recorded_locale_id ? (
                      <span className="rounded bg-sky-900 px-1.5 text-[11px] text-sky-200">recorded</span>
                    ) : (
                      r.metro && <span className="rounded border border-neutral-700 px-1.5 text-[11px] text-neutral-400">{r.metro}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>

        <AreaPicker
          locales={locales ?? []}
          selectedLocale={selected}
          boundary={boundary}
          onBoundary={onBoundary}
          onLocale={pickLocale}
          flyTo={flyTo}
        />

        <p className="mt-2 mb-6 text-sm">
          {!boundary && !wholeLocale && <span className="text-neutral-500">Pick a recorded area or draw a boundary</span>}
          {wholeLocale && <span className="text-neutral-300">Whole recorded area: {wholeLocale.name}</span>}
          {boundary && !check && <span className="text-neutral-500">Checking the drawn area…</span>}
          {check?.error && <span className="text-rose-400">{check.error}</span>}
          {check && !check.error && check.kind === 'subarea' && (
            <span className="text-sky-300">
              {check.label} · recorded data · {check.area_km2?.toFixed(1)} km²
            </span>
          )}
          {check && !check.error && check.kind === 'metro' && (
            <span className="text-amber-300">
              {check.label} · recorded live from county, CoStar and imagery sources (a few minutes) · {check.area_km2?.toFixed(1)} km²
            </span>
          )}
        </p>

        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          {!locales && !error && <p className="text-neutral-500">Loading locales…</p>}
          {locales?.map((l) => (
            <button
              key={l.id}
              onClick={() => pickLocale(l.id)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                areaLocaleId === l.id ? 'border-sky-500 bg-sky-950/40' : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600'
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <span className="font-semibold">{l.name}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-px text-[11px] ${
                    l.data_tier === 'costar_full' ? 'bg-sky-900 text-sky-200' : 'bg-amber-900 text-amber-200'
                  }`}
                >
                  {l.data_tier === 'costar_full' ? 'CoStar full' : 'Public only'}
                </span>
              </div>
              <p className="text-sm text-neutral-400">{l.purpose}</p>
              <p className="mt-2 text-xs text-neutral-500">{l.transit_agency}</p>
            </button>
          ))}
        </div>

        {visibleStock.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {visibleStock.map((p) => (
              <button
                key={p.id}
                onClick={() => pickStock(p)}
                title={p.prompt}
                className={`rounded-full border px-3 py-1 text-xs ${
                  p.locale_id ? 'border-sky-800 text-sky-200 hover:bg-sky-950' : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
                }`}
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
          placeholder="e.g. Plan transit-oriented development around the rail stations"
          className="mb-3 w-full rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-neutral-100 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none"
        />

        <div className="mb-4 flex flex-wrap items-center gap-4 text-sm text-neutral-300">
          <label className="flex items-center gap-2">
            Focus
            <select value={options.focus} onChange={(e) => setOption('focus', e.target.value as PlanOptions['focus'])} className={SELECT}>
              <option value="all">All</option>
              <option value="conversions">Conversions only</option>
              <option value="new_build">New construction only</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            Transit budget
            <select
              value={options.transit_budget}
              onChange={(e) => setOption('transit_budget', e.target.value as PlanOptions['transit_budget'])}
              className={SELECT}
            >
              <option value="default">Default</option>
              <option value="half">Half</option>
              <option value="double">Double</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            Affordable homes
            <select
              value={options.affordable}
              onChange={(e) => setOption('affordable', e.target.value as PlanOptions['affordable'])}
              className={SELECT}
            >
              <option value="default">Default</option>
              <option value="high">High</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-4">
          <label
            className={`flex items-center gap-2 text-sm ${replayAllowed ? 'cursor-pointer text-neutral-300' : 'text-neutral-600'}`}
            title={replayAllowed ? undefined : REPLAY_HINT}
          >
            <input type="checkbox" checked={replayOn} disabled={!replayAllowed} onChange={(e) => setReplay(e.target.checked)} />
            Replay recorded run
          </label>
          {!replayAllowed && <span className="text-xs text-neutral-500">{REPLAY_HINT}</span>}
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="ml-auto rounded-lg bg-sky-600 px-6 py-2 font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {submitting ? 'Starting…' : 'Plan it'}
          </button>
        </div>
      </div>
    </div>
  )
}
