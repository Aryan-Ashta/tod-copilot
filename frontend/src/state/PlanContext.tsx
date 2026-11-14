import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from 'react'
import { getLocales, getPlan, openStream, rescore, simulateCount } from '../api'
import { LAYER_DEFS, type LayerKey } from '../mapLayers'
import { fmtDelta, fmtUsd } from '../format'
import type {
  AgentEvent,
  AgentName,
  Edit,
  InfraFeature,
  Locale,
  LocaleId,
  Plan,
  Rejection,
  RescoreResponse,
  Scoreboard,
  SimulatedCount,
  TileKind,
} from '../types'
import { AGENTS, RECORDED_LOCALE_IDS } from '../types'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error'

export interface EditEntry {
  id: number
  edit: Edit
  /** Human label for the history list, e.g. "Added Park on 1021 Main St". */
  label: string
}

export interface HistoryItem {
  id: number
  text: string
}

export interface RejectionNotice {
  rejection: Rejection
  label: string
  tile: TileKind | null
  nonce: number
}

export interface PlanState {
  planId: string
  locale: Locale | null
  /** Full plan from GET /api/plan/{id}; rescore patches always apply on top of this. */
  basePlan: Plan | null
  /** Current view: SSE payloads merged while streaming, then basePlan + latest rescore patch. */
  plan: Partial<Plan>
  /** Proposed features from rescore (parks placed in meeting mode). */
  infraAdded: InfraFeature[]
  agentStatus: Record<AgentName, AgentStatus>
  steps: Record<AgentName, string[]>
  stream: 'connecting' | 'streaming' | 'ended' | 'failed' | 'static'
  loadError: string | null
  selectedAgent: AgentName
  /** flyTo: card links (not map clicks) ask the map to fly here; a fresh tuple re-flies even to the same spot. */
  selected: { parcelId?: string; buildingId?: string; stopId?: string; flyTo?: [number, number] }
  layers: Record<LayerKey, boolean>
  edits: EditEntry[]
  /** Comma-joined ids of the edit list the current scoreboard reflects. */
  scoredKey: string | null
  scoreboard: Scoreboard | null
  prevScoreboard: Scoreboard | null
  /** Deltas vs the base plan, from the server. */
  deltas: Record<string, number>
  /** Increments whenever the scoreboard changes (keys the delta animation). */
  scoreTick: number
  history: HistoryItem[]
  rejection: RejectionNotice | null
  rescoring: boolean
  rescoreError: string | null
  simulated: Record<string, SimulatedCount>
}

export type PlanAction =
  | { type: 'locale'; locale: Locale }
  | { type: 'event'; event: AgentEvent }
  | { type: 'stream_ended' }
  | { type: 'stream_failed' }
  | { type: 'plan_loaded'; plan: Plan }
  | { type: 'load_error'; message: string }
  | { type: 'select_agent'; agent: AgentName }
  | { type: 'select'; selected: PlanState['selected'] }
  | { type: 'toggle_layer'; key: LayerKey; on?: boolean }
  | { type: 'add_edit'; edit: Edit; label: string }
  | { type: 'undo' }
  | { type: 'reset' }
  | { type: 'rescoring' }
  | { type: 'rescored'; res: RescoreResponse; sent: EditEntry[] }
  | { type: 'rescore_error'; message: string }
  | { type: 'dismiss_rejection' }
  | { type: 'simulated'; result: SimulatedCount }

const ALL_AGENTS: AgentName[] = [...AGENTS, 'coordinator']
/** Recorded locale a plan id belongs to (`<locale>-<hex8>`, `demo-<locale>`); null for custom areas (`area-…-plan`). */
export const localeIdFromPlanId = (planId: string): LocaleId | null =>
  RECORDED_LOCALE_IDS.find((id) => planId.includes(id)) ?? null

let editSeq = 0

function initState(planId: string, isStatic: boolean): PlanState {
  return {
    planId,
    locale: null,
    basePlan: null,
    plan: {},
    infraAdded: [],
    agentStatus: Object.fromEntries(ALL_AGENTS.map((a) => [a, 'pending'])) as Record<AgentName, AgentStatus>,
    steps: Object.fromEntries(ALL_AGENTS.map((a) => [a, []])) as unknown as Record<AgentName, string[]>,
    stream: isStatic ? 'static' : 'connecting',
    loadError: null,
    selectedAgent: 'infrastructure',
    selected: {},
    layers: Object.fromEntries(LAYER_DEFS.map((d) => [d.key, d.on])) as Record<LayerKey, boolean>,
    edits: [],
    scoredKey: null,
    scoreboard: null,
    prevScoreboard: null,
    deltas: {},
    scoreTick: 0,
    history: [],
    rejection: null,
    rescoring: false,
    rescoreError: null,
    simulated: {},
  }
}

const editsKey = (edits: EditEntry[]) => edits.map((e) => e.id).join(',')

/** Recap text for a change, e.g. "homes −48, walk access +15 pts". Server numbers only. */
export function describeChange(prev: Scoreboard | null, next: Scoreboard): string {
  if (!prev) return ''
  const parts: string[] = []
  const d = (a: number, b: number) => b - a
  if (d(prev.homes, next.homes) !== 0) parts.push(`homes ${fmtDelta(d(prev.homes, next.homes))}`)
  if (Math.abs(d(prev.walk_access_pct, next.walk_access_pct)) >= 0.5)
    parts.push(`walk access ${fmtDelta(d(prev.walk_access_pct, next.walk_access_pct))} pts`)
  if (Math.abs(d(prev.transport_co2_tonnes_per_year, next.transport_co2_tonnes_per_year)) >= 0.5)
    parts.push(`transport CO₂ avoided ${fmtDelta(d(prev.transport_co2_tonnes_per_year, next.transport_co2_tonnes_per_year))} t/yr`)
  if (Math.abs(d(prev.embodied_co2_saved_tonnes, next.embodied_co2_saved_tonnes)) >= 0.5)
    parts.push(`embodied carbon saved ${fmtDelta(d(prev.embodied_co2_saved_tonnes, next.embodied_co2_saved_tonnes))} t`)
  if (prev.affordable_homes !== next.affordable_homes)
    parts.push(`affordable homes ${fmtDelta(d(prev.affordable_homes, next.affordable_homes))}`)
  const gap = d(prev.funding_gap_usd, next.funding_gap_usd)
  if (Math.abs(gap) >= 1) parts.push(`funding gap ${gap < 0 ? '−' : '+'}${fmtUsd(Math.abs(gap))}`)
  return parts.length ? parts.join(', ') : 'no change'
}

function mergePayload(plan: Partial<Plan>, payload: Record<string, unknown>): Partial<Plan> {
  const next: Partial<Plan> = { ...plan }
  for (const [k, v] of Object.entries(payload)) {
    if ((k === 'precomputed' || k === 'notes' || k === 'agent_errors') && v && typeof v === 'object') {
      ;(next as Record<string, unknown>)[k] = { ...((plan as Record<string, unknown>)[k] as object), ...(v as object) }
    } else {
      ;(next as Record<string, unknown>)[k] = v
    }
  }
  return next
}

function applyPatch(base: Plan, res: RescoreResponse): { plan: Partial<Plan>; infraAdded: InfraFeature[] } {
  const { infrastructure_added, ...rest } = res.plan_patch
  return { plan: { ...base, ...rest }, infraAdded: infrastructure_added ?? [] }
}

function reducer(s: PlanState, a: PlanAction): PlanState {
  switch (a.type) {
    case 'locale':
      return s.locale ? s : { ...s, locale: a.locale }
    case 'event': {
      const e = a.event
      const steps = { ...s.steps, [e.agent]: [...s.steps[e.agent], e.step] }
      const agentStatus = { ...s.agentStatus, [e.agent]: e.status }
      let plan = s.plan
      if (e.status === 'done' && e.agent !== 'coordinator' && !s.basePlan) plan = mergePayload(plan, e.payload)
      const streamed = plan.locale as Locale | undefined
      // A drawn sub-area's locale carries its boundary; prefer it over the whole recorded locale.
      const locale = streamed?.boundary ? streamed : (s.locale ?? streamed ?? null)
      return { ...s, steps, agentStatus, plan, locale, stream: 'streaming' }
    }
    case 'stream_ended':
      return { ...s, stream: 'ended' }
    case 'stream_failed':
      return { ...s, stream: 'failed' }
    case 'plan_loaded': {
      const p = a.plan
      const agentStatus = { ...s.agentStatus }
      for (const ag of AGENTS) agentStatus[ag] = p.agent_errors[ag] ? 'error' : 'done'
      if (agentStatus.coordinator !== 'error') agentStatus.coordinator = 'done'
      // scoredKey reset: a reloaded plan (drawn-area agent research rebuilt it) re-applies the current edits via rescore.
      return { ...s, basePlan: p, plan: p, locale: p.locale, agentStatus, loadError: null, scoredKey: null }
    }
    case 'load_error':
      return { ...s, loadError: a.message }
    case 'select_agent':
      return { ...s, selectedAgent: a.agent }
    case 'select':
      return { ...s, selected: a.selected }
    case 'toggle_layer':
      return { ...s, layers: { ...s.layers, [a.key]: a.on ?? !s.layers[a.key] } }
    case 'add_edit': {
      const entry: EditEntry = { id: ++editSeq, edit: a.edit, label: a.label }
      // The slider is one control: its latest value replaces any earlier slider edit.
      const edits = a.edit.kind === 'slider' ? [...s.edits.filter((e) => e.edit.kind !== 'slider'), entry] : [...s.edits, entry]
      return { ...s, edits, rejection: null }
    }
    case 'undo': {
      const edits = s.edits.slice(0, -1)
      const keep = new Set(edits.map((e) => e.id))
      return { ...s, edits, history: s.history.filter((h) => keep.has(h.id)), rejection: null }
    }
    case 'reset':
      return { ...s, edits: [], history: [], rejection: null }
    case 'rescoring':
      return { ...s, rescoring: true }
    case 'rescored': {
      if (!s.basePlan) return s
      const { res, sent } = a
      let edits = s.edits
      let rejection: RejectionNotice | null = null
      let accepted = sent
      if (res.rejected) {
        const bad = sent[res.rejected.edit_index]
        if (bad) {
          edits = edits.filter((e) => e.id !== bad.id)
          accepted = sent.filter((e) => e.id !== bad.id)
          rejection = { rejection: res.rejected, label: bad.label, tile: bad.edit.tile ?? null, nonce: bad.id }
        }
      }
      const known = new Set(s.history.map((h) => h.id))
      const live = new Set(edits.map((e) => e.id))
      const history = s.history.filter((h) => live.has(h.id))
      const fresh = accepted.filter((e) => !known.has(e.id) && live.has(e.id))
      fresh.forEach((e, i) => {
        const change = i === fresh.length - 1 ? describeChange(s.scoreboard, res.scoreboard) : ''
        history.push({ id: e.id, text: change ? `${e.label}: ${change}` : e.label })
      })
      const { plan, infraAdded } = applyPatch(s.basePlan, res)
      const changed = JSON.stringify(s.scoreboard) !== JSON.stringify(res.scoreboard)
      return {
        ...s,
        plan,
        infraAdded,
        edits,
        scoredKey: editsKey(accepted),
        prevScoreboard: changed ? s.scoreboard : s.prevScoreboard,
        scoreboard: res.scoreboard,
        scoreTick: changed ? s.scoreTick + 1 : s.scoreTick,
        deltas: res.deltas,
        history,
        rejection: rejection ?? s.rejection,
        rescoring: false,
        rescoreError: null,
      }
    }
    case 'rescore_error':
      return { ...s, rescoring: false, rescoreError: a.message }
    case 'dismiss_rejection':
      return { ...s, rejection: null }
    case 'simulated':
      return { ...s, simulated: { ...s.simulated, [a.result.stop_id]: a.result } }
  }
}

interface PlanCtx {
  state: PlanState
  dispatch: Dispatch<PlanAction>
  addEdit: (edit: Edit, label: string) => void
  runSimulation: (stopId: string) => Promise<void>
}

const Ctx = createContext<PlanCtx | null>(null)

/**
 * mode "stream": open the SSE stream (live or replay), then GET the full plan when the coordinator finishes.
 * mode "static": GET the plan directly (meeting mode); fall back to the live stream if it is not ready yet.
 */
export function PlanProvider({
  planId,
  replay = false,
  mode = 'stream',
  children,
}: {
  planId: string
  replay?: boolean
  mode?: 'stream' | 'static'
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(reducer, undefined, () => initState(planId, mode === 'static'))
  const seq = useRef(0)

  useEffect(() => {
    const id = localeIdFromPlanId(planId)
    if (!id) return
    getLocales()
      .then((ls) => {
        const l = ls.find((x) => x.id === id)
        if (l) dispatch({ type: 'locale', locale: l })
      })
      .catch(() => {
        // locale arrives with the plan anyway
      })
  }, [planId])

  useEffect(() => {
    let alive = true
    let close = () => {}
    const loadFull = () =>
      getPlan(planId)
        .then((p) => alive && dispatch({ type: 'plan_loaded', plan: p }))
        .catch((e: Error) => alive && dispatch({ type: 'load_error', message: e.message }))
    const stream = (asReplay: boolean) => {
      close = openStream(planId, asReplay, {
        onEvent: (event) => {
          if (!alive) return
          dispatch({ type: 'event', event })
          // "Plan ready", and the later "Agent research finished" on drawn areas: the stream may stay open while
          // research runs in the background, so load (or reload) the plan now rather than at stream end.
          if (event.agent === 'coordinator' && event.status === 'done' && event.payload?.plan_id) loadFull()
        },
        onEnd: () => {
          if (!alive) return
          dispatch({ type: 'stream_ended' })
          loadFull()
        },
        onFail: () => {
          if (!alive) return
          dispatch({ type: 'stream_failed' })
          loadFull()
        },
      })
    }
    if (mode === 'static') {
      getPlan(planId)
        .then((p) => alive && dispatch({ type: 'plan_loaded', plan: p }))
        .catch(() => alive && stream(false))
    } else {
      stream(replay)
    }
    return () => {
      alive = false
      close()
    }
  }, [planId, replay, mode])

  // Debounced rescore (150 ms). Stateless server: the full edit list is sent every time, so undo/reset
  // restore exact numbers. Also fetches the base scoreboard (edits = []) once the plan is loaded.
  const { edits, basePlan, scoredKey } = state
  useEffect(() => {
    if (!basePlan || editsKey(edits) === scoredKey) return
    const sent = edits
    const t = setTimeout(() => {
      const n = ++seq.current
      dispatch({ type: 'rescoring' })
      rescore(planId, sent.map((e) => e.edit))
        .then((res) => n === seq.current && dispatch({ type: 'rescored', res, sent }))
        .catch((e: Error) => n === seq.current && dispatch({ type: 'rescore_error', message: e.message }))
    }, 150)
    return () => clearTimeout(t)
  }, [edits, basePlan, scoredKey, planId])

  const addEdit = useCallback((edit: Edit, label: string) => dispatch({ type: 'add_edit', edit, label }), [])
  const runSimulation = useCallback(
    async (stopId: string) => {
      const result = await simulateCount(planId, stopId)
      dispatch({ type: 'simulated', result })
    },
    [planId],
  )

  const value = useMemo(() => ({ state, dispatch, addEdit, runSimulation }), [state, addEdit, runSimulation])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePlan(): PlanCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('usePlan outside PlanProvider')
  return c
}
