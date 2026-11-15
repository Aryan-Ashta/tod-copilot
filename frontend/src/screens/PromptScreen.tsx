import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { areaCheck, createPlan, geocode, getLocales, stockPrompts } from '../api'
import Disclaimer from '../components/Disclaimer'
import AreaPicker, { type PolygonGeometry } from '../components/AreaPicker'
import Segmented from '../components/Segmented'
import Slider from '../components/Slider'
import { useApp } from '../state/AppContext'
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

const FOCUS: { value: PlanOptions['focus']; label: string }[] = [
  { value: 'all', label: 'Both' },
  { value: 'conversions', label: 'Conversions' },
  { value: 'new_build', label: 'New construction' },
]

const HOUSING_GOALS: { key: Exclude<keyof PlanGoals, 'transit_coverage_pct'>; label: string }[] = [
  { key: 'affordable_homes', label: 'New affordable homes' },
  { key: 'total_homes', label: 'New homes total' },
  { key: 'conversions', label: 'Buildings converted' },
]
// A UI limit, not a model factor: the backend accepts any coverage goal from 0 to 100.
const COVERAGE_RANGE = { min: 0, max: 100, step: 5 }

// Screen space the floating headline, search and start bar cover, so the US view and fly-tos land in what is left.
const MAP_PADDING = { top: 150, right: 24, bottom: 120, left: 24 }

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
  // Selected stock-prompt ids in pick order, tagged with the visible list they were made against.
  const [pick, setPick] = useState<{ visibleKey: string; ids: string[] } | null>(null)
  // Options-popover changes; each set field overrides the value merged from the selected prompts.
  const [override, setOverride] = useState<{ focus?: PlanOptions['focus']; goals: Partial<PlanGoals> }>({ goals: {} })
  const [replay, setReplay] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsRef = useRef<HTMLDivElement>(null)
  const optionsButtonRef = useRef<HTMLButtonElement>(null)
  // The options popover closes on Escape or a press anywhere outside it and its button.
  useEffect(() => {
    if (!optionsOpen) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!optionsRef.current?.contains(t) && !optionsButtonRef.current?.contains(t)) setOptionsOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOptionsOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [optionsOpen])
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
      .catch((e: Error) => setError(e.message))
  }, [])

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
  const chipLocaleId = areaLocaleId ?? (check?.kind === 'metro' ? check.sources_from : null)
  const visibleStock = stock.filter((p) => p.locale_id === null || p.locale_id === chipLocaleId)
  const visibleIds = visibleStock.map((p) => p.id)
  const visibleKey = visibleIds.join(',')

  // A new visible list keeps only visible selections; with none left it falls back to the first visible prompt so
  // Generate works at once. Within the same list the user may deselect everything.
  const kept = (pick?.ids ?? []).filter((id) => visibleIds.includes(id))
  const picked = pick?.visibleKey === visibleKey ? pick.ids : kept.length ? kept : visibleIds.slice(0, 1)

  const selectedPrompts = visibleStock.filter((p) => picked.includes(p.id))

  // Selected prompts merge into one request: a focus only when every focused prompt agrees, each goal the largest set.
  const foci = selectedPrompts.map((p) => p.options.focus).filter((f) => f !== 'all')
  const mergedFocus: PlanOptions['focus'] = foci.length > 0 && foci.every((f) => f === foci[0]) ? foci[0] : 'all'
  const mergedGoals = Object.fromEntries(
    (Object.keys(DEFAULT_PLAN_OPTIONS.goals) as (keyof PlanGoals)[]).map((k) => {
      const vals = selectedPrompts.map((p) => p.options.goals?.[k] ?? null).filter((v): v is number => v !== null)
      return [k, vals.length ? Math.max(...vals) : null]
    }),
  ) as unknown as PlanGoals
  const options: PlanOptions = {
    focus: override.focus ?? mergedFocus,
    goals: { ...mergedGoals, ...override.goals },
  }
  const prompt = selectedPrompts.map((p) => p.prompt).join(' · ')

  const defaultOptions = options.focus === 'all' && Object.values(options.goals).every((v) => v === null)
  const replayAllowed = wholeLocale !== null && defaultOptions
  const replayOn = replay && replayAllowed
  const areaOk = wholeLocale !== null || (check !== null && check.kind !== null && !check.error)
  const canSubmit = areaOk && !submitting && selectedPrompts.length > 0

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

  // The coverage slider rests on factors.yaml transit_coverage_goal_pct until the user moves it.
  const defaultCoverage = factorNumber('transit_coverage_goal_pct')
  const coverage = options.goals.transit_coverage_pct ?? defaultCoverage
  const coverageMarks = [...new Set([COVERAGE_RANGE.min, defaultCoverage ?? COVERAGE_RANGE.min, COVERAGE_RANGE.max])]
    .sort((a, b) => a - b)
    .map((v) => ({ value: v, label: `${v}%` }))

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

  const setFocus = (v: PlanOptions['focus']) => setOverride((o) => ({ ...o, focus: v }))

  const setGoal = (k: keyof PlanGoals, v: number | null) =>
    setOverride((o) => ({ ...o, goals: { ...o.goals, [k]: v } }))

  const submit = async () => {
    if (!canSubmit) return
    const tags = `tags=${selectedPrompts.map((p) => encodeURIComponent(p.id)).join(',')}`
    if (replayOn && areaLocaleId) {
      navigate(`/plan/demo-${areaLocaleId}?replay=1&${tags}`)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { plan_id } = await createPlan({
        locale_id: areaLocaleId,
        boundary,
        area_name: boundary ? areaName : null,
        prompt,
        options,
      })
      navigate(`/plan/${plan_id}?${tags}`)
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  // Enter generates, unless a field or control has the keyboard.
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return
      e.preventDefault()
      void submitRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const d = (n: number) => ({ '--d': n }) as CSSProperties

  const searchForm = (
    <form
      className="relative flex items-center gap-2 rounded-full border border-white/60 bg-paper/85 p-1.5 pl-4 shadow-[0_8px_28px_rgb(28_34_48/.14)] backdrop-blur-md transition-shadow focus-within:shadow-[0_0_0_4px_rgb(47_91_211/.15)]"
      onSubmit={(e) => {
        e.preventDefault()
        void search()
      }}
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-slate" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <circle cx="7" cy="7" r="5" />
        <path d="M11 11l3.5 3.5" />
      </svg>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Place in any US county"
        placeholder="Search a US city or address"
        className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] placeholder:text-slate/70 focus:outline-none"
      />
      <button type="submit" disabled={searching || !query.trim()} className="ctl rounded-full px-4 py-1 text-[13px]">
        {searching ? 'Searching…' : 'Search'}
      </button>
      {results && (
        <ul className="pop-in absolute top-full right-0 left-0 z-30 mt-2 overflow-hidden rounded-2xl border border-rule bg-paper shadow-[0_12px_32px_rgb(28_34_48/.16)]">
          {results.length === 0 && <li className="px-4 py-2.5 text-sm text-slate">No matches in a US county</li>}
          {results.map((r, i) => (
            <li key={`${r.label}-${i}`} className="border-b border-rule last:border-b-0">
              <button
                type="button"
                onClick={() => pickResult(r)}
                className="flex w-full items-baseline justify-between gap-2 px-4 py-2.5 text-left text-sm transition-colors hover:bg-ink/5"
              >
                <span>{r.label}</span>
                <span className="text-slate">{r.recorded_locale_id ? 'recorded' : r.metro}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  )

  // Short label in the bar; anything longer (an area error, the live-onboarding note) is spelled out in full above it.
  const statusText =
    !boundary && !wholeLocale
      ? 'Pick a pin or draw an area'
      : wholeLocale
        ? wholeLocale.name
        : !check
          ? 'Checking the drawn area…'
          : check.error
            ? 'Area not usable'
            : check.kind === 'subarea'
              ? `${check.label} · ${check.area_km2?.toFixed(1)} km²`
              : `${check.label} · live · ${check.area_km2?.toFixed(1)} km²`
  const statusDetail = !boundary || !check
    ? null
    : check.error
      ? check.error
      : check.kind === 'metro'
        ? 'Recorded live from public county sources. A county drawn in for the first time is onboarded by agents first, which can take several minutes.'
        : null
  const statusTone = check?.error ? 'error' : areaOk ? 'ok' : 'idle'
  const areaStatus = (
    <span
      key={statusText}
      title={statusText}
      className={`hint-in flex max-w-[190px] min-w-0 shrink items-center gap-2 pl-3 text-[12.5px] font-medium ${statusTone === 'error' ? 'text-gap' : 'text-ink/80'}`}
      aria-live="polite"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusTone === 'ok' ? 'bg-green' : statusTone === 'error' ? 'bg-gap' : 'bg-slate/50'}`} />
      <span className="truncate">{statusText}</span>
    </span>
  )
  const statusNote = statusDetail && (
    <p
      key={statusDetail}
      role={statusTone === 'error' ? 'alert' : undefined}
      className={`hint-in max-w-[560px] rounded-2xl bg-paper/95 px-4 py-2 text-center text-[13px] leading-snug shadow-[0_6px_18px_rgb(28_34_48/.12)] backdrop-blur-md ${statusTone === 'error' ? 'text-gap' : 'text-ink/80'}`}
    >
      {statusDetail}
    </p>
  )

  const chipClass = (on: boolean) =>
    `${on ? 'chip-pick bg-ink text-paper' : 'text-ink/70 hover:bg-ink/[.06] hover:text-ink'} flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] font-medium whitespace-nowrap transition-[background-color,color] duration-200 active:scale-95`
  const chips = (
    <div className="chip-scroll flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1" role="group" aria-label="Plan prompts">
      {stock.length === 0 && <span className="px-2 text-[12.5px] text-slate">Loading prompts…</span>}
      {visibleStock.map((p, i) => {
        const on = picked.includes(p.id)
        return (
          <span key={p.id} className="chip-in shrink-0" style={d(i)}>
            <button
              type="button"
              onClick={() => setPick({ visibleKey, ids: on ? picked.filter((x) => x !== p.id) : [...picked, p.id] })}
              title={p.prompt}
              aria-pressed={on}
              className={chipClass(on)}
            >
              <span className={`grid h-3 shrink-0 place-items-center overflow-hidden transition-[width,margin] duration-200 ${on ? 'w-3' : '-mr-1 w-0'}`}>
                {on && (
                  <svg viewBox="0 0 12 12" className="check-draw h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M2.5 6.5l2.3 2.3 4.7-5" pathLength={1} />
                  </svg>
                )}
              </span>
              {p.title}
            </button>
          </span>
        )
      })}
    </div>
  )

  const optionControls = (
    <>
      <div>
        <div className="mb-2 text-sm text-slate">Focus</div>
        <Segmented label="Focus" options={FOCUS} value={options.focus} onChange={setFocus} />
      </div>
      <div>
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <span className="text-slate">Transit coverage goal</span>
          <span className="font-semibold tabular-nums">{coverage === null ? '…' : `${coverage}% of demand`}</span>
        </div>
        <Slider
          label="Transit coverage goal"
          {...COVERAGE_RANGE}
          value={coverage ?? COVERAGE_RANGE.min}
          valueText={coverage === null ? undefined : `${coverage}% of transit demand near a frequent stop`}
          marks={coverageMarks}
          disabled={coverage === null}
          // back on the factors.yaml goal counts as the default, so replays stay available
          onChange={(pct) => setGoal('transit_coverage_pct', pct === defaultCoverage ? null : pct)}
        />
      </div>
      <fieldset>
        <legend className="mb-2 text-sm text-slate">Housing goals (blank = no goal)</legend>
        <div className="grid grid-cols-3 gap-3 text-[14px]">
          {HOUSING_GOALS.map((g) => (
            <label key={g.key} className="block">
              {g.label}
              <input
                type="number"
                min={0}
                step={1}
                value={options.goals[g.key] ?? ''}
                onChange={(e) => {
                  const n = e.target.value.trim() === '' ? null : Number(e.target.value)
                  setGoal(g.key, n === null || Number.isNaN(n) ? null : n)
                }}
                className="mt-1 block w-full rounded-xl border border-rule bg-white/60 px-3 py-1.5 tabular-nums transition-shadow focus:border-ink/40 focus:shadow-[0_0_0_4px_rgb(47_91_211/.12)] focus:outline-none"
              />
            </label>
          ))}
        </div>
      </fieldset>
    </>
  )

  const replayToggle = (
    <label
      className={`flex items-center gap-2 text-[14px] ${replayAllowed ? 'cursor-pointer' : 'text-slate'}`}
      title={replayAllowed ? undefined : REPLAY_HINT}
    >
      <input type="checkbox" checked={replayOn} disabled={!replayAllowed} onChange={(e) => setReplay(e.target.checked)} />
      Replay recorded run
    </label>
  )

  const planButton = (
    <button
      onClick={submit}
      disabled={!canSubmit}
      title={stock.length > 0 && selectedPrompts.length === 0 ? 'Pick at least one prompt' : undefined}
      className="go h-11 shrink-0 rounded-full bg-ink px-6 text-[14px] font-semibold whitespace-nowrap text-paper transition-[background-color,color] duration-200 disabled:cursor-default disabled:bg-ink/10 disabled:text-ink/35"
    >
      {submitting ? 'Starting…' : 'Generate'}
    </button>
  )

  const errorNote = error && <p className="hint-in max-w-full rounded-full bg-paper/90 px-3 py-1 text-[12.5px] text-gap backdrop-blur-md">{error}</p>
  const map = (
    <AreaPicker
      padding={MAP_PADDING}
      locales={locales ?? []}
      selectedLocale={selected}
      boundary={boundary}
      onBoundary={onBoundary}
      onLocale={pickLocale}
      flyTo={flyTo}
    />
  )

  return (
    <div className="flex h-full flex-col">
      <Disclaimer />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="map-in absolute inset-0">{map}</div>
        <div className="pointer-events-none absolute top-0 left-0 z-10 h-[420px] w-[900px] max-w-full bg-[radial-gradient(ellipse_at_top_left,var(--color-paper)_35%,transparent_70%)]" />
        <div className="absolute top-6 left-7 z-20 w-[min(560px,calc(100%-56px))]">
          <h1 className="line-reveal display text-[54px]">
            <span>
              <span style={d(0)}>Plan transit and</span>
            </span>
            <span>
              <span style={d(1)}>the homes around it</span>
            </span>
          </h1>
          <div className="enter mt-5" style={d(3)}>
            {searchForm}
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-7 z-20 flex justify-center px-6">
          <div className="enter relative flex w-full max-w-[760px] flex-col items-center gap-2" style={d(4)}>
            {errorNote}
            {!optionsOpen && statusNote}
            {optionsOpen && (
              // centred over the start bar (Tailwind's translate property); pop-in animates transform, so they compose
              <div
                ref={optionsRef}
                className="pop-in absolute bottom-full left-1/2 mb-3 w-[min(600px,100%)] -translate-x-1/2 rounded-3xl bg-paper/95 p-6 shadow-[0_16px_40px_rgb(28_34_48/.18)] backdrop-blur-md"
              >
                <div className="grid grid-cols-1 gap-6">{optionControls}</div>
                <div className="mt-5 border-t border-rule pt-4">{replayToggle}</div>
              </div>
            )}
            <div className="flex h-14 w-full items-center gap-2 rounded-full bg-paper/90 p-1.5 shadow-[0_10px_30px_rgb(28_34_48/.16)] backdrop-blur-md">
              {areaStatus}
              <span className="h-5 w-px shrink-0 bg-rule" aria-hidden />
              {chips}
              <button
                ref={optionsButtonRef}
                onClick={() => setOptionsOpen(!optionsOpen)}
                aria-expanded={optionsOpen}
                aria-label="Options"
                title="Options"
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors duration-150 ${optionsOpen ? 'bg-ink/10 text-ink' : 'text-slate hover:bg-ink/5 hover:text-ink'}`}
              >
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M2 4h7M13 4h1M2 12h1M7 12h7" />
                  <circle cx="11" cy="4" r="2" />
                  <circle cx="5" cy="12" r="2" />
                </svg>
              </button>
              {planButton}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
