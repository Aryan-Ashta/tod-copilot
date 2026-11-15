import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { localeIdFromPlanId, usePlan } from '../state/PlanContext'
import { AGENTS, AGENT_LABELS, type LonLat, type Plan } from '../types'
import { bothLawExamples } from '../zoningExamples'

/**
 * Keyboard walk-through for the demo locales: → / ← step through the eight agents (each pick shifts the map to the
 * agent's focus); in Koreatown a "Rezoning recommendation" step after Zoning selects a parcel both legal paths apply
 * to, flies the map there and scrolls the side panel to its two-path figures. No on-screen control: keys only.
 */

const DEMO_LOCALES: readonly string[] = ['houston_downtown', 'la_wilshire_koreatown']
const REZONE_LOCALE = 'la_wilshire_koreatown'
const SIDEBAR = '[data-demo="sidebar"]'
const RECOMMENDATION = '[data-demo="zoning-recommendation"]'
/** Gap kept above the scrolled-to block. */
const SCROLL_MARGIN_PX = 12
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
 *  when the whole selection fits, else from the pick line. Null until the block has rendered. */
function recommendationTop(box: HTMLElement): number | null {
  const el = box.querySelector<HTMLElement>(RECOMMENDATION)
  if (!el) return null
  const outer = el.parentElement
  const pick = outer && outer.getBoundingClientRect().height + SCROLL_MARGIN_PX <= box.clientHeight ? outer : el
  return box.scrollTop + pick.getBoundingClientRect().top - box.getBoundingClientRect().top - SCROLL_MARGIN_PX
}

/** Keys typed into a field, or with a modifier held, are not demo keys. */
function typing(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return true
  const t = e.target instanceof HTMLElement ? e.target : null
  return !!t && (t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
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

  return null
}
