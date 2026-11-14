import { usePlan, type AgentStatus } from '../state/PlanContext'
import { AGENTS, AGENT_LABELS } from '../types'

const STATUS_STYLE: Record<AgentStatus, { dot: string; text: string }> = {
  pending: { dot: 'bg-neutral-700', text: 'text-neutral-500' },
  running: { dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300' },
  done: { dot: 'bg-emerald-500', text: 'text-emerald-300' },
  error: { dot: 'bg-rose-500', text: 'text-rose-300' },
}

export default function AgentChecklist() {
  const { state, dispatch } = usePlan()
  const coord = state.steps.coordinator
  return (
    <div className="border-b border-neutral-800">
      <ol>
        {AGENTS.map((a, i) => {
          const st = state.agentStatus[a]
          const steps = state.steps[a]
          const err = state.plan.agent_errors?.[a]
          const active = state.selectedAgent === a
          return (
            <li key={a}>
              <button
                onClick={() => dispatch({ type: 'select_agent', agent: a })}
                className={`flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-neutral-900 ${active ? 'bg-neutral-900' : ''}`}
              >
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_STYLE[st].dot}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">
                      {i + 1}. {AGENT_LABELS[a]}
                    </span>
                    <span className={`text-[11px] ${STATUS_STYLE[st].text}`}>{st}</span>
                  </span>
                  {(err || steps.length > 0) && (
                    <span className={`block truncate text-xs ${err ? 'text-rose-400' : 'text-neutral-400'}`}>
                      {err ?? steps[steps.length - 1]}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {coord.length > 0 && (
        <div className="px-4 py-1.5 text-xs text-neutral-500">Coordinator: {coord[coord.length - 1]}</div>
      )}
      {state.stream === 'failed' && !state.basePlan && !state.loadError && (
        <div className="px-4 py-1.5 text-xs text-amber-400">Stream unavailable; loading saved plan…</div>
      )}
      {state.loadError && <div className="px-4 py-1.5 text-xs text-rose-400">Could not load plan: {state.loadError}</div>}
    </div>
  )
}
