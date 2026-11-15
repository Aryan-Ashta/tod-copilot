import { useEffect, useState, useSyncExternalStore } from 'react'
import { usePlan, type HistoryItem, type PlanState } from '../state/PlanContext'
import { STAT_META, deltaGood, deltaShown, fmtStatDelta } from './Scoreboard'
import { TileGlyph } from './TileTray'
import type { Scoreboard } from '../types'

/** Eight colours that read on paper, one per history entry (cycling); text on each is `historyInk`. */
const PALETTE = ['#2f5bd3', '#e0674f', '#2e7d5b', '#e3b448', '#8b5cb8', '#13808a', '#d1568a', '#7d8a2e']

/** Colour of history entry `index` (1-based), shared by its badge and its stat contribution segments. */
export const historyColor = (index: number) => PALETTE[(((index - 1) % PALETTE.length) + PALETTE.length) % PALETTE.length]

/** Text colour on `historyColor(index)`: ink on the light mustard, paper on the rest. */
export const historyInk = (index: number) => (historyColor(index) === '#e3b448' ? 'var(--color-ink)' : '#fff')

// The history entry under the pointer (a row here, or one of its segments in StatsPanel): a tiny shared store.
let focusedId: number | null = null
const listeners = new Set<() => void>()
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function setHistoryFocus(id: number | null) {
  if (focusedId === id) return
  focusedId = id
  for (const fn of listeners) fn()
}

/** The focused history entry id (hovered row or contribution segment); null when none. */
export const useHistoryFocus = (): number | null => useSyncExternalStore(subscribe, () => focusedId)

function SparkleIcon() {
  return (
    <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
      <path d="M12 3.5l2 5.6 5.6 2-5.6 2-2 5.6-2-5.6-5.6-2 5.6-2z" fill="var(--color-mustard)" stroke="var(--color-ink)" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M21 15l1 2.8 2.8 1-2.8 1-1 2.8-1-2.8-2.8-1 2.8-1z" fill="var(--color-blue)" stroke="var(--color-ink)" strokeWidth="1" strokeLinejoin="round" />
      <circle cx="7" cy="21.5" r="1.6" fill="var(--color-green)" stroke="var(--color-ink)" strokeWidth="0.9" />
    </svg>
  )
}

function LeafIcon() {
  return (
    <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
      <path d="M6 22C6 12 12 6 23 5c0 11-6 17-15 17z" fill="#9cc4b0" stroke="var(--color-ink)" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M6 22c4-5 8-9 13-12" fill="none" stroke="var(--color-green)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function EraserIcon() {
  return (
    <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
      <path d="M4.5 17.5l9-9 9 9-5 5h-8z" fill="#f2d9d5" stroke="var(--color-ink)" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M13.5 8.5l9 9-3 3-9-9z" fill="var(--color-gap)" stroke="var(--color-ink)" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 24h15" stroke="var(--color-slate)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function EntryIcon({ h }: { h: HistoryItem }) {
  if (h.kind === 'tile' && h.tile) return <TileGlyph kind={h.tile} className="h-7 w-7" />
  if (h.kind === 'suggestions') return <SparkleIcon />
  if (h.kind === 'slider') return <LeafIcon />
  return <EraserIcon />
}

/** The scoreboard just before entry `h`: the previous entry's snapshot, or existing conditions for the first. */
function scoreBefore(state: PlanState, h: HistoryItem): Scoreboard | null {
  const i = state.history.findIndex((x) => x.id === h.id)
  const prev = i > 0 ? state.history[i - 1] : null
  return (prev ? state.scoreSteps[prev.id]?.scoreboard : state.existing?.scoreboard) ?? null
}

/** Why an entry moved no number, from the score it was applied to (walk access counts new homes only). */
function noChangeReason(h: HistoryItem, before: Scoreboard | null): string {
  if (!before) return 'no change in the numbers'
  if (h.kind === 'slider')
    return before.homes === 0
      ? 'no change yet: green space applies to new buildings, and the plan has none'
      : 'no change: at this setting no new building gives up a home'
  if (h.kind !== 'tile') return 'no change in the numbers'
  if ((h.tile === 'park' || h.tile === 'stop') && before.homes === 0)
    return 'no change: walk access counts new homes, and the plan has none yet'
  if (h.tile === 'park' && (before.walk_by_amenity_pct?.park ?? 0) >= 100)
    return 'no change: every new home already has a park within walking distance'
  if (h.tile === 'stop' && before.walk_access_pct >= 100)
    return 'no change: every new home is already within walking distance of frequent transit'
  if (h.tile === 'park' || h.tile === 'stop') return 'no change: no new home that lacked one is within walking distance'
  return 'no change in the numbers'
}

/**
 * Signed changes this entry made, in display order: "+48 homes", "−$1.2M funding". Good green, bad red. A green-space
 * entry leaves out transport CO₂ avoided: its carbon chip is the embodied carbon saved (the stats still show both).
 */
function DeltaChips({ h }: { h: HistoryItem }) {
  const { state } = usePlan()
  const chips = STAT_META.flatMap((m) => {
    if (h.kind === 'slider' && m.key === 'transport_co2_tonnes_per_year') return []
    const d = h.delta[m.key]
    return d !== undefined && deltaShown(m, d) ? [{ m, d }] : []
  })
  if (!chips.length) return <div className="text-[12px] leading-snug text-slate italic">{noChangeReason(h, scoreBefore(state, h))}</div>
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map(({ m, d }) => (
        <span
          key={m.key}
          className={`rounded-[5px] px-1.5 py-px text-[12px] leading-[18px] font-semibold whitespace-nowrap tabular-nums ${
            deltaGood(m, d) ? 'bg-emerald-900 text-emerald-200' : 'bg-rose-900 text-rose-200'
          }`}
        >
          {fmtStatDelta(m, d)} {m.short}
        </span>
      ))}
    </div>
  )
}

function Row({ h, leaving = false }: { h: HistoryItem; leaving?: boolean }) {
  const { dispatch } = usePlan()
  const focused = useHistoryFocus() === h.id
  return (
    <li
      data-history-id={leaving ? undefined : h.id}
      data-focused={focused || undefined}
      aria-hidden={leaving || undefined}
      className={`${leaving ? 'hist-out pointer-events-none' : 'hist-in'} group relative flex items-start gap-2.5 rounded-[10px] border px-2 py-1.5 transition-[background-color,border-color] duration-150 ${
        focused ? 'border-ink/25 bg-ink/[0.05]' : 'border-transparent'
      }`}
      onMouseEnter={() => setHistoryFocus(h.id)}
      onMouseLeave={() => setHistoryFocus(null)}
      onFocus={() => setHistoryFocus(h.id)}
      onBlur={() => setHistoryFocus(null)}
    >
      <span
        className="mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink px-1 text-[13px] font-bold tabular-nums shadow-[1px_1px_0_var(--color-ink)]"
        style={{ background: historyColor(h.index), color: historyInk(h.index) }}
      >
        {h.index}
      </span>
      <span className="shrink-0 transition-[translate] duration-200 group-hover:-translate-y-0.5">
        <EntryIcon h={h} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] leading-tight font-semibold">{h.title}</div>
        {h.where && <div className="truncate text-[13px] leading-tight text-slate">{h.where}</div>}
        <DeltaChips h={h} />
      </div>
      <button
        type="button"
        tabIndex={leaving ? -1 : 0}
        onClick={() => dispatch({ type: 'remove_edit', id: h.id })}
        aria-label={`Remove #${h.index} ${h.title}${h.where ? ` at ${h.where}` : ''}`}
        title="Remove this change"
        className="hist-x mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink bg-paper text-ink shadow-[1px_1px_0_var(--color-ink)] hover:bg-gap hover:text-paper"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        </svg>
      </button>
    </li>
  )
}

/** A removed row stays ~250 ms for its exit; `after` is the id of the row it followed (null: first). */
interface Leaving {
  h: HistoryItem
  after: number | null
}

const EXIT_MS = 260

/** Edit mode's plan history: each accepted edit with its icon, place and changes; hover to see it in the stats,
 *  ✕ to remove it. */
export default function HistoryPanel() {
  const { state, dispatch } = usePlan()
  const history = state.history
  const [prev, setPrev] = useState(history)
  const [leaving, setLeaving] = useState<Leaving[]>([])
  if (prev !== history) {
    const live = new Set(history.map((h) => h.id))
    const gone: Leaving[] = []
    let after: number | null = null
    for (const h of prev) {
      if (live.has(h.id)) after = h.id
      else gone.push({ h, after })
    }
    setPrev(history)
    if (gone.length) setLeaving((l) => [...l.filter((x) => !gone.some((g) => g.h.id === x.h.id)), ...gone])
  }
  useEffect(() => {
    if (!leaving.length) return
    const t = setTimeout(() => setLeaving([]), EXIT_MS)
    return () => clearTimeout(t)
  }, [leaving])
  // a removed entry cannot stay focused
  useEffect(() => {
    if (focusedId !== null && !history.some((h) => h.id === focusedId)) setHistoryFocus(null)
  }, [history])

  const ghostsAfter = (id: number | null) =>
    leaving.filter((l) => l.after === id).map((l) => <Row key={`out-${l.h.id}`} h={l.h} leaving />)

  return (
    <section aria-label="Plan history" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="wide flex items-center gap-2 text-[22px] font-bold">
          Plan history
          {state.rescoring && (
            <span className="hint-in flex items-center gap-1.5 text-[12px] font-normal text-slate" role="status">
              <span className="hist-pulse h-2 w-2 rounded-full bg-blue" aria-hidden />
              updating
            </span>
          )}
        </h2>
        <div className="flex gap-2">
          <button disabled={!state.edits.length} onClick={() => dispatch({ type: 'undo' })} className="ctl">
            Undo
          </button>
          <button disabled={!state.edits.length} onClick={() => dispatch({ type: 'reset' })} className="ctl">
            Reset
          </button>
        </div>
      </div>
      {history.length === 0 && !leaving.length ? (
        <p className="hint-in text-[15px] text-slate">Pick a tile below, then click a highlighted lot or building.</p>
      ) : (
        <ol className="-mx-2 flex flex-col">
          {ghostsAfter(null)}
          {history.flatMap((h) => [<Row key={h.id} h={h} />, ...ghostsAfter(h.id)])}
        </ol>
      )}
    </section>
  )
}
