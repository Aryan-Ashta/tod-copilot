import type {
  AppConfig,
  AreaCheck,
  AgentEvent,
  BuildingDetail,
  CorpusDoc,
  Edit,
  Factor,
  GeocodeResult,
  GreenSpaceOptimum,
  LetterDraft,
  LetterKind,
  Locale,
  PlanOptions,
  StockPrompt,
  MetroOutlines,
  Plan,
  RescoreResponse,
  SimulatedCount,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body)
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new ApiError(res.status, res.status === 409 || res.status === 422 ? detail : `${res.status} ${detail}`)
  }
  return (await res.json()) as T
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) })
const enc = encodeURIComponent

export const getLocales = () => request<Locale[]>('/api/locales')

export const getConfig = () => request<AppConfig>('/api/config')

export interface CreatePlanRequest {
  locale_id: string | null
  boundary: unknown | null
  area_name: string | null
  prompt: string
  options: PlanOptions | null
}

export const createPlan = (req: CreatePlanRequest) => post<{ plan_id: string }>('/api/plan', req)

export const geocode = (q: string) => request<GeocodeResult[]>(`/api/geocode?q=${enc(q)}`)

export const areaCheck = (boundary: unknown) => post<AreaCheck>('/api/area_check', { boundary })

export const metros = () => request<MetroOutlines>('/api/metros')

export const stockPrompts = () => request<StockPrompt[]>('/api/stock_prompts')

export const getPlan = (planId: string) => request<Plan>(`/api/plan/${enc(planId)}`)

export const rescore = (planId: string, edits: Edit[], fromExisting = true) =>
  post<RescoreResponse>(`/api/plan/${enc(planId)}/rescore`, { edits, from_existing: fromExisting })

export const optimizeGreenSpace = (planId: string, edits: Edit[], fromExisting = true) =>
  post<GreenSpaceOptimum>(`/api/plan/${enc(planId)}/optimize_green_space`, { edits, from_existing: fromExisting })

export const simulateCount = (planId: string, stop_id: string) =>
  post<SimulatedCount>(`/api/plan/${enc(planId)}/simulate_count`, { stop_id })

export const getBuilding = (buildingId: string, planId: string) =>
  request<BuildingDetail>(`/api/buildings/${enc(buildingId)}?plan_id=${enc(planId)}`)

export const getCorpusDoc = (docId: string) => request<CorpusDoc>(`/api/corpus/${enc(docId)}`)

export const getFactors = () => request<Factor[]>('/api/factors')

export const getLetter = (planId: string, kind: LetterKind, targetId: string) =>
  request<LetterDraft>(`/api/plan/${enc(planId)}/letter?kind=${enc(kind)}&target_id=${enc(targetId)}`)

export interface StreamHandlers {
  onEvent: (e: AgentEvent) => void
  /** Called once when the coordinator reports done/error; the stream is already closed. */
  onEnd: (final: AgentEvent) => void
  /** Called once if the connection fails before the coordinator's final event. */
  onFail: () => void
}

const LLM_FALLBACK_STEP = 'LLM coordinator unavailable; deterministic driver used'

/** Opens the SSE stream for a plan. Each message's `data` is a JSON AgentEvent. Returns a closer. */
export function openStream(planId: string, replay: boolean, h: StreamHandlers): () => void {
  const url = `/api/plan/${enc(planId)}/stream${replay ? '?replay=1' : ''}`
  const es = new EventSource(url)
  let finished = false
  es.onmessage = (msg) => {
    if (finished) return
    let ev: AgentEvent
    try {
      ev = JSON.parse(msg.data) as AgentEvent
    } catch {
      return
    }
    ev.payload ??= {}
    h.onEvent(ev)
    // The LLM-fallback notice is a coordinator "error" but the run continues (backend/app.py notify).
    if (ev.agent === 'coordinator' && (ev.status === 'done' || (ev.status === 'error' && ev.step !== LLM_FALLBACK_STEP))) {
      finished = true
      es.close()
      h.onEnd(ev)
    }
  }
  es.onerror = () => {
    if (finished) return
    finished = true
    es.close()
    h.onFail()
  }
  return () => {
    finished = true
    es.close()
  }
}
