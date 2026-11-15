import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react'
import { localeIdFromPlanId, usePlan } from '../state/PlanContext'
import { AGENTS, AGENT_LABELS, type LonLat, type Plan } from '../types'
import { bothLawExamples } from '../zoningExamples'

/**
 * Keyboard walk-through for the demo locales: → / ← step through the eight agents (each pick shifts the map to the
 * agent's focus); in Koreatown a "Rezoning recommendation" step after Zoning selects a parcel both legal paths apply
 * to, flies the map there and scrolls the side panel to its two-path figures. A small pill at the bottom of the side
 * panel shows the position; Esc hides it (the keys keep working).
 */

const DEMO_LOCALES: readonly string[] = ['houston_downtown', 'la_wilshire_koreatown']
const REZONE_LOCALE = 'la_wilshire_koreatown'
const SIDEBAR = '[data-demo="sidebar"]'
const RECOMMENDATION = '[data-demo="zoning-recommendation"]'
/** Gap kept above the scrolled-to block, and room left below it for this pill. */
const SCROLL_MARGIN_PX = 12
const HUD_ROOM_PX = 64
/** How long a scroll keeps waiting for its target to render and correcting for layout that shifts under it. */
const SETTLE_MS = 3000

type Step = { agent: (typeof AGENTS)[number]; rezone: boolean; label: string }

/** The parcel to show the two legal paths on: the card's first both-laws example, else any envelope with 2+ eligible paths. */
function rezoneTarget(plan: Partial<Plan>): { id: string; at: LonLat } | null {
  const ex = bothLawExamples(plan)[0]
  if (ex) return { id: ex.id, at: ex.at }
  const centroid = plan.precomputed?.centroid ?? {}
  const env = (plan.envelopes ?? []).find((e) => e.paths.filter((p) => p.eligible).length >= 2 && centroid[e.parcel_id])
  return env ? { id: env.parcel_id, at: centroid[env.parcel_id] } : null
}

/** Scroll offset in the side panel that brings the recommendation in, under a small margin: with the parcel heading
 *  when the whole selection fits above this pill, else from the pick line. Null until the block has rendered. */
function recommendationTop(box: HTMLElement): number | null {
  const el = box.querySelector<HTMLElement>(RECOMMENDATION)
  if (!el) return null
  const outer = el.parentElement
  const pick = outer && outer.getBoundingClientRect().height + SCROLL_MARGIN_PX <= box.clientHeight - HUD_ROOM_PX ? outer : el
  return box.scrollTop + pick.getBoundingClientRect().top - box.getBoundingClientRect().top - SCROLL_MARGIN_PX
}

/** Keys typed into a field, or with a modifier held, are not demo keys. */
function typing(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return true
  const t = e.target instanceof HTMLElement ? e.target : null
  return !!t && (t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-ink bg-paper px-1 font-sans text-[11px] leading-none font-semibold text-ink shadow-[1px_1px_0_var(--color-ink)]">
      {children}
    </kbd>
  )
}

function StepButton({ dir, disabled, onClick }: { dir: -1 | 1; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={dir < 0 ? 'Previous demo step' : 'Next demo step'}
      title={dir < 0 ? 'Previous (←)' : 'Next (→)'}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] border-ink bg-paper text-[13px] leading-none font-semibold text-ink shadow-[1.5px_1.5px_0_var(--color-ink)] transition-[translate,box-shadow] duration-100 enabled:hover:-translate-x-px enabled:hover:-translate-y-px enabled:active:translate-x-[1.5px] enabled:active:translate-y-[1.5px] enabled:active:shadow-none disabled:cursor-default disabled:border-rule disabled:text-slate disabled:shadow-none"
    >
      {dir < 0 ? '←' : '→'}
    </button>
  )
}

export default function DemoSequence() {
  const { state, dispatch } = usePlan()
  const localeId = localeIdFromPlanId(state.planId)
  const active = !!state.basePlan && !!localeId && DEMO_LOCALES.includes(localeId)
  const target = useMemo(
    () => (active && localeId === REZONE_LOCALE ? rezoneTarget(state.plan) : null),
    [active, localeId, state.plan],
  )
  const steps = useMemo<Step[]>(
    () =>
      AGENTS.flatMap((agent) => {
        const s: Step[] = [{ agent, rezone: false, label: AGENT_LABELS[agent] }]
        if (agent === 'zoning_legislation' && target) s.push({ agent, rezone: true, label: 'Rezoning recommendation' })
        return s
      }),
    [target],
  )
  const [index, setIndex] = useState(-1)
  const [hidden, setHidden] = useState(false)
  // A pick in the agent list moves the walk-through along with it (the next → continues from that agent).
  const manual = index >= 0 && steps[index]?.agent !== state.selectedAgent
  const pickedAt = manual ? steps.findIndex((s) => !s.rezone && s.agent === state.selectedAgent) : -1
  const pos = manual && pickedAt >= 0 ? pickedAt : index

  // Each step bumps the token; pending timers and frames of an earlier step see the change and stop.
  const run = useRef(0)
  useEffect(() => () => void run.current++, [])

  /** Scrolls the side panel to `at(panel)`, re-read on every check until SETTLE_MS: the card swap and its settling
   *  figures shift the layout mid-scroll (which also cuts a smooth scroll short). Null from `at`: not rendered yet. */
  const scrollPanel = (token: number, at: (box: HTMLElement) => number | null) => {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const t0 = performance.now()
    const check = () => {
      const box = document.querySelector<HTMLElement>(SIDEBAR)
      if (run.current !== token || !box || performance.now() - t0 > SETTLE_MS) return
      const top = at(box)
      if (top === null) return void requestAnimationFrame(check)
      const goal = Math.round(Math.min(Math.max(0, top), box.scrollHeight - box.clientHeight))
      if (Math.abs(box.scrollTop - goal) > 2) box.scrollTo({ top: goal, behavior: still ? 'auto' : 'smooth' })
      window.setTimeout(check, still ? 100 : 400)
    }
    // after React has committed the step's card
    requestAnimationFrame(check)
  }

  const go = (to: number) => {
    if (!active || to < 0 || to >= steps.length || to === pos) return
    const from = steps[pos] as Step | undefined
    const next = steps[to]
    const token = ++run.current
    setIndex(to)
    if (from?.rezone) dispatch({ type: 'select', selected: {} })
    if (next.rezone && target) {
      // coming back from a later agent: pick Zoning first, then fly once its camera move has started
      const repick = state.selectedAgent !== next.agent
      if (repick) dispatch({ type: 'select_agent', agent: next.agent })
      const select = () => {
        if (run.current !== token) return
        dispatch({ type: 'select', selected: { parcelId: target.id, flyTo: [target.at[0], target.at[1]] } })
        scrollPanel(token, recommendationTop)
      }
      if (repick) window.setTimeout(select, 120)
      else select()
      return
    }
    dispatch({ type: 'select_agent', agent: next.agent })
    scrollPanel(token, () => 0)
  }

  const onKey = useEffectEvent((e: KeyboardEvent, capture: boolean) => {
    if (typing(e)) return
    const onMap = e.target instanceof Element && !!e.target.closest('.maplibregl-map')
    if (e.key === 'Escape') {
      if (!capture && !e.defaultPrevented) setHidden(true)
      return
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    // the focused map pans on arrow keys (and marks them handled), so there the demo takes them before it sees them
    if (capture !== onMap || (!capture && e.defaultPrevented)) return
    go(pos + (e.key === 'ArrowRight' ? 1 : -1))
    e.preventDefault()
    if (capture) e.stopPropagation()
  })
  useEffect(() => {
    if (!active) return
    const down = (e: KeyboardEvent) => onKey(e, false)
    const downCapture = (e: KeyboardEvent) => onKey(e, true)
    window.addEventListener('keydown', downCapture, true)
    window.addEventListener('keydown', down)
    return () => {
      window.removeEventListener('keydown', downCapture, true)
      window.removeEventListener('keydown', down)
    }
  }, [active])

  if (!active || hidden) return null
  const step = steps[pos] as Step | undefined
  return (
    <div className="pointer-events-none sticky bottom-3 z-20 mt-auto flex justify-center px-3 pt-3">
      <div
        role="group"
        aria-label="Demo walk-through"
        className="pop-in pointer-events-auto flex max-w-full items-center gap-2.5 rounded-full border-[1.5px] border-ink bg-paper/95 py-1 pr-1 pl-1 shadow-[1.5px_1.5px_0_var(--color-ink)] backdrop-blur-sm"
      >
        <StepButton dir={-1} disabled={pos <= 0} onClick={() => go(pos - 1)} />
        <div className="flex min-w-0 flex-col items-center gap-1 py-0.5">
          <div aria-live="polite" className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-tight whitespace-nowrap text-ink">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-slate uppercase">Demo</span>
            <span className="text-rule">·</span>
            {step ? (
              <span key={pos} className="hint-in flex min-w-0 items-baseline gap-1.5">
                <span className="tnum text-slate">
                  {pos + 1}/{steps.length}
                </span>
                <span className="text-rule">·</span>
                <span className="truncate font-semibold">{step.label}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-slate">
                Press <Key>→</Key> to walk through the agents
              </span>
            )}
          </div>
          <div aria-hidden className="flex items-center gap-1">
            {steps.map((s, i) => (
              <span
                key={`${s.agent}:${s.rezone}`}
                className={`h-1.5 rounded-full transition-[width,background-color] duration-200 ${i === pos ? 'w-3.5 bg-ink' : i < pos ? 'w-1.5 bg-ink/60' : 'w-1.5 bg-rule'}`}
              />
            ))}
          </div>
        </div>
        <StepButton dir={1} disabled={pos >= steps.length - 1} onClick={() => go(pos + 1)} />
      </div>
    </div>
  )
}
