import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Context, type Dispatch, type ReactNode } from 'react'
import { getLocales, getPlan, openStream, rescore, simulateCount } from '../api'
import { LAYER_DEFS, type LayerKey } from '../mapLayers'
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
  ScoreSnapshot,
  SimulatedCount,
  TargetKey,
  TileKind,
} from '../types'
import { AGENTS, RECORDED_LOCALE_IDS } from '../types'

export type AgentStatus = 'pending' | 'running' | 'done' | 'error'

export type ScoreKey =
  | 'homes'
  | 'affordable_homes'
  | 'walk_access_pct'
  | 'transport_co2_tonnes_per_year'
  | 'embodied_co2_saved_tonnes'
  | 'funding_required_usd'
/** Scoreboard and target keys are disjoint strings. */
export type StatKey = ScoreKey | TargetKey

const SCORE_KEYS: ScoreKey[] = [
  'homes',
  'affordable_homes',
  'walk_access_pct',
  'transport_co2_tonnes_per_year',
  'embodied_co2_saved_tonnes',
  'funding_required_usd',
]
const TARGET_KEYS: TargetKey[] = ['transport_co2', 'embodied_co2_saved', 'rooftop_solar', 'walk_access', 'flood_exposure']
const STAT_KEYS: StatKey[] = [...SCORE_KEYS, ...TARGET_KEYS]
const isScoreKey = (k: StatKey): k is ScoreKey => (SCORE_KEYS as string[]).includes(k)

/** Smallest |delta| worth showing in history: percentage points 0.05, USD 1, counts/tonnes/MWh 0.5. */
const DELTA_EPSILON: Record<StatKey, number> = {
  homes: 0.5,
  affordable_homes: 0.5,
  walk_access_pct: 0.05,
  transport_co2_tonnes_per_year: 0.5,
  embodied_co2_saved_tonnes: 0.5,
  funding_required_usd: 1,
  transport_co2: 0.5,
  embodied_co2_saved: 0.5,
  rooftop_solar: 0.5,
  walk_access: 0.05,
  flood_exposure: 0.05,
}

export function statValue(s: ScoreSnapshot | null | undefined, k: StatKey): number | null {
  if (!s) return null
  if (isScoreKey(k)) return s.scoreboard[k]
  return s.targets.find((t) => t.key === k)?.value ?? null
}

const TILE_TITLES: Record<TileKind, string> = {
  homes: 'New homes',
  park: 'Park',
  stop: 'Transit stop',
  convert_residential: 'Convert to housing',
  convert_hotel: 'Convert to hotel',
}

export function editTitle(e: Edit): string {
  switch (e.kind) {
    case 'place_tile':
      return e.tile ? TILE_TITLES[e.tile] : 'Tile'
    case 'remove_tile':
      return 'Removed tile'
    case 'slider':
      return `Green space ${Math.round((e.value ?? 0) * 100)}%`
    case 'apply_suggestions':
      return 'Agent suggestions'
  }
}

export interface EditEntry {
  id: number
  edit: Edit
  /** Where the edit applies, e.g. "1021 Main St" (parcelLabel/buildingLabel); null for slider/suggestions. */
  where: string | null
}

export interface HistoryItem {
  /** EditEntry id */
  id: number
  /** 1-based position in the history list: the badge shown on contributions. */
  index: number
  kind: 'suggestions' | 'tile' | 'slider' | 'remove'
  tile: TileKind | null
  title: string
  where: string | null
  /** This step minus the previous step (previous of index 1 = existing); only visible changes. */
  delta: Partial<Record<StatKey, number>>
}

export interface RejectionNotice {
  rejection: Rejection
  title: string
  where: string | null
  tile: TileKind | null
  nonce: number
}

export interface PlanState {
  planId: string
  locale: Locale | null
  /** Full plan from GET /api/plan/{id}; rescore patches always apply on top of this. */
  basePlan: Plan | null
  /** The agents' suggestions (agent cards): SSE payloads merged while streaming, then basePlan. Never rescore-patched. */
  plan: Partial<Plan>
  /** Map/stats view: existing conditions + accepted edits (existingView(plan) until the first rescore lands). */
  current: Partial<Plan>
  /** Proposed features from rescore (parks placed in meeting mode). */
  infraAdded: InfraFeature[]
  agentStatus: Record<AgentName, AgentStatus>
  steps: Record<AgentName, string[]>
  stream: 'connecting' | 'streaming' | 'ended' | 'failed' | 'static'
  loadError: string | null
  selectedAgent: AgentName
  /** Increments on every agent pick, so picking the same agent again still re-runs its map focus. */
  agentPick: number
  /** flyTo: card links (not map clicks) ask the map to fly here; a fresh tuple re-flies even to the same spot.
   *  routeKey: a transit route (mapLayers.routeKey) the map keeps in focus. */
  selected: { parcelId?: string; buildingId?: string; stopId?: string; routeKey?: string; flyTo?: [number, number] }
  /** Route key hovered in the transit card; the map focuses it like a hovered line. */
  hoverRouteKey: string | null
  layers: Record<LayerKey, boolean>
  edits: EditEntry[]
  /** Comma-joined ids of the edit list the current scoreboard reflects. */
  scoredKey: string | null
  scoreboard: Scoreboard | null
  prevScoreboard: Scoreboard | null
  /** Deltas vs the agents' plan, from the server. */
  deltas: Record<string, number>
  /** Increments whenever the scoreboard changes (keys the delta animation). */
  scoreTick: number
  /** Existing conditions, no edits (null until the first rescore). */
  existing: ScoreSnapshot | null
  /** The agents' plan as built, no edits. */
  suggested: ScoreSnapshot | null
  /** Edit id -> snapshot after that edit. */
  scoreSteps: Record<number, ScoreSnapshot>
  /** Id of the newest accepted edit of the latest rescore; null after undo/remove/reset. */
  lastChangeId: number | null
  /** Armed tile in meeting mode. */
  tool: TileKind | null
  /** Recomputed from edits + scoreSteps on every rescore. */
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
  | { type: 'hover_route'; key: string | null }
  | { type: 'toggle_layer'; key: LayerKey; on?: boolean }
  | { type: 'tool'; tool: TileKind | null }
  | { type: 'add_edit'; edit: Edit; where: string | null }
  | { type: 'remove_edit'; id: number }
  | { type: 'apply_suggestions' }
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

export const suggestionsApplied = (s: PlanState): boolean => s.edits.some((e) => e.edit.kind === 'apply_suggestions')

/**
 * Id for a new edit, derived from the state (reducers stay pure: StrictMode runs them twice, and dev hot updates
 * re-run this module, which reset a module-level counter and handed out duplicate ids). Ids of edits undone since the
 * last rescore stay taken while history rows still show them.
 */
const nextEditId = (s: PlanState) => Math.max(0, ...s.edits.map((e) => e.id), ...s.history.map((h) => h.id)) + 1

const storageKey = (planId: string) => `transitor.edits.${planId}`

/** Edits saved for this plan (plan screen ↔ meeting mode share them); [] on missing or bad data. */
function loadEdits(planId: string): EditEntry[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(storageKey(planId)) ?? '[]')
    if (!Array.isArray(raw)) return []
    const edits = raw.filter(
      (e): e is EditEntry =>
        !!e && typeof e === 'object' && typeof e.id === 'number' && !!e.edit && typeof e.edit.kind === 'string',
    )
    // numbered afresh: ids only need to be unique within this session's list (older saves could repeat one)
    return edits.map((e, i) => ({ id: i + 1, edit: e.edit, where: typeof e.where === 'string' ? e.where : null }))
  } catch {
    return []
  }
}

function saveEdits(planId: string, edits: EditEntry[]) {
  try {
    sessionStorage.setItem(storageKey(planId), JSON.stringify(edits))
  } catch {
    // storage full or unavailable: edits just do not survive a reload
  }
}

/** Existing conditions: no agent sites/stacks/deals/targets, only existing transit routes and no plan stops. */
function existingView(plan: Partial<Plan>): Partial<Plan> {
  const view: Partial<Plan> = { ...plan, sites: [], stacks: [], deals: [] }
  delete view.targets
  if (plan.transit) {
    view.transit = {
      ...plan.transit,
      routes: plan.transit.routes.filter((r) => r.kind === 'rail_existing' || r.kind === 'bus_existing'),
      stops: [],
    }
  }
  return view
}

function initState(planId: string, isStatic: boolean): PlanState {
  const edits = loadEdits(planId)
  return {
    planId,
    locale: null,
    basePlan: null,
    plan: {},
    current: {},
    infraAdded: [],
    agentStatus: Object.fromEntries(ALL_AGENTS.map((a) => [a, 'pending'])) as Record<AgentName, AgentStatus>,
    steps: Object.fromEntries(ALL_AGENTS.map((a) => [a, []])) as unknown as Record<AgentName, string[]>,
    stream: isStatic ? 'static' : 'connecting',
    loadError: null,
    selectedAgent: 'infrastructure',
    agentPick: 0,
    selected: {},
    hoverRouteKey: null,
    layers: Object.fromEntries(LAYER_DEFS.map((d) => [d.key, d.on])) as Record<LayerKey, boolean>,
    edits,
    scoredKey: null,
    scoreboard: null,
    prevScoreboard: null,
    deltas: {},
    scoreTick: 0,
    existing: null,
    suggested: null,
    scoreSteps: {},
    lastChangeId: null,
    tool: null,
    history: [],
    rejection: null,
    rescoring: false,
    rescoreError: null,
    simulated: {},
  }
}

const editsKey = (edits: EditEntry[]) => edits.map((e) => e.id).join(',')

const HISTORY_KIND: Record<Edit['kind'], HistoryItem['kind']> = {
  apply_suggestions: 'suggestions',
  place_tile: 'tile',
  slider: 'slider',
  remove_tile: 'remove',
}

/** History rows for the live edits; each delta is its step minus the previous step (or existing). */
function buildHistory(edits: EditEntry[], steps: Record<number, ScoreSnapshot>, existing: ScoreSnapshot): HistoryItem[] {
  let prev = existing
  return edits.map((e, i) => {
    const step = steps[e.id]
    const delta: Partial<Record<StatKey, number>> = {}
    if (step) {
      for (const k of STAT_KEYS) {
        const a = statValue(prev, k)
        const b = statValue(step, k)
        if (a === null || b === null) continue
        const d = b - a
        if (Math.abs(d) >= DELTA_EPSILON[k]) delta[k] = d
      }
      prev = step
    }
    return {
      id: e.id,
      index: i + 1,
      kind: HISTORY_KIND[e.edit.kind],
      tile: e.edit.tile ?? null,
      title: editTitle(e.edit),
      where: e.where,
      delta,
    }
  })
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

/** Drops edits by id; history rows follow until the next rescore recomputes them. */
function withEdits(s: PlanState, edits: EditEntry[]): PlanState {
  const keep = new Set(edits.map((e) => e.id))
  return { ...s, edits, history: s.history.filter((h) => keep.has(h.id)), lastChangeId: null, rejection: null }
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
      const current = s.existing || plan === s.plan ? s.current : existingView(plan)
      return { ...s, steps, agentStatus, plan, current, locale, stream: 'streaming' }
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
      const current = s.existing ? s.current : existingView(p)
      // scoredKey reset: a reloaded plan (drawn-area agent research rebuilt it) re-applies the current edits via rescore.
      return { ...s, basePlan: p, plan: p, current, locale: p.locale, agentStatus, loadError: null, scoredKey: null }
    }
    case 'load_error':
      return { ...s, loadError: a.message }
    case 'select_agent':
      return { ...s, selectedAgent: a.agent, agentPick: s.agentPick + 1 }
    case 'select':
      return { ...s, selected: a.selected }
    case 'hover_route':
      return { ...s, hoverRouteKey: a.key }
    case 'toggle_layer':
      return { ...s, layers: { ...s.layers, [a.key]: a.on ?? !s.layers[a.key] } }
    case 'tool':
      return { ...s, tool: a.tool }
    case 'add_edit': {
      const entry: EditEntry = { id: nextEditId(s), edit: a.edit, where: a.where }
      // The slider is one control: its latest value replaces the earlier slider edit in place (history indices stay).
      const at = a.edit.kind === 'slider' ? s.edits.findIndex((e) => e.edit.kind === 'slider') : -1
      const edits = at >= 0 ? s.edits.map((e, i) => (i === at ? entry : e)) : [...s.edits, entry]
      return { ...s, edits, rejection: null }
    }
    case 'apply_suggestions': {
      if (suggestionsApplied(s)) return s
      const entry: EditEntry = { id: nextEditId(s), edit: { kind: 'apply_suggestions' }, where: null }
      return { ...s, edits: [...s.edits, entry], rejection: null }
    }
    case 'remove_edit':
      return withEdits(s, s.edits.filter((e) => e.id !== a.id))
    case 'undo':
      return withEdits(s, s.edits.slice(0, -1))
    case 'reset':
      return { ...s, edits: [], history: [], lastChangeId: null, rejection: null }
    case 'rescoring':
      return { ...s, rescoring: true }
    case 'rescored': {
      if (!s.basePlan) return s
      const { res, sent } = a
      const scoreSteps: Record<number, ScoreSnapshot> = {}
      sent.forEach((e, i) => {
        const step = res.steps[i]
        if (step) scoreSteps[e.id] = step
      })
      let edits = s.edits
      let rejection: RejectionNotice | null = null
      let accepted = sent
      if (res.rejected) {
        const bad = sent[res.rejected.edit_index]
        if (bad) {
          edits = edits.filter((e) => e.id !== bad.id)
          accepted = sent.filter((e) => e.id !== bad.id)
          delete scoreSteps[bad.id]
          rejection = {
            rejection: res.rejected,
            title: editTitle(bad.edit),
            where: bad.where,
            tile: bad.edit.tile ?? null,
            nonce: bad.id,
          }
        }
      }
      const live = new Set(edits.map((e) => e.id))
      const scored = new Set(s.history.map((h) => h.id))
      const fresh = accepted.filter((e) => live.has(e.id) && !scored.has(e.id))
      const lastChangeId = fresh.length ? Math.max(...fresh.map((e) => e.id)) : null
      const { plan: current, infraAdded } = applyPatch(s.basePlan, res)
      const changed = JSON.stringify(s.scoreboard) !== JSON.stringify(res.scoreboard)
      return {
        ...s,
        current,
        infraAdded,
        edits,
        scoredKey: editsKey(accepted),
        prevScoreboard: changed ? s.scoreboard : s.prevScoreboard,
        scoreboard: res.scoreboard,
        scoreTick: changed ? s.scoreTick + 1 : s.scoreTick,
        deltas: res.deltas,
        existing: res.existing,
        suggested: res.suggested,
        scoreSteps,
        lastChangeId,
        history: buildHistory(edits, scoreSteps, res.existing),
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
  addEdit: (edit: Edit, where?: string | null) => void
  runSimulation: (stopId: string) => Promise<void>
}

// Dev hot updates re-run this module whenever anything it imports changes (mapLayers.ts and everything below it);
// reusing the one context object keeps already-mounted providers and freshly loaded consumers talking to each other
// (otherwise: "usePlan outside PlanProvider"). Production builds have no import.meta.hot.
const Ctx: Context<PlanCtx | null> = import.meta.hot?.data.planCtx ?? createContext<PlanCtx | null>(null)
if (import.meta.hot) import.meta.hot.data.planCtx = Ctx

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

  // Debounced rescore (150 ms). Stateless server: the full edit list is sent every time (from existing conditions),
  // so undo/remove/reset restore exact numbers. Also fetches the base scoreboard (edits = []) once the plan is loaded.
  const { edits, basePlan, scoredKey } = state
  useEffect(() => {
    if (!basePlan || editsKey(edits) === scoredKey) return
    const sent = edits
    const t = setTimeout(() => {
      const n = ++seq.current
      dispatch({ type: 'rescoring' })
      rescore(planId, sent.map((e) => e.edit), true)
        .then((res) => n === seq.current && dispatch({ type: 'rescored', res, sent }))
        .catch((e: Error) => n === seq.current && dispatch({ type: 'rescore_error', message: e.message }))
    }, 150)
    return () => clearTimeout(t)
  }, [edits, basePlan, scoredKey, planId])

  useEffect(() => saveEdits(planId, edits), [planId, edits])

  const addEdit = useCallback((edit: Edit, where: string | null = null) => dispatch({ type: 'add_edit', edit, where }), [])
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
