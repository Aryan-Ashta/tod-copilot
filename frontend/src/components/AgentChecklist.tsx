import { usePlan } from '../state/PlanContext'
import { AGENTS, AGENT_LABELS } from '../types'
import { AgentGlyph } from '../iso/glyphs'

/** Hairline-ruled list of the eight agents, each with a small iso glyph whose colour shows its status. */
export default function AgentChecklist() {
  const { state, dispatch } = usePlan()
  const coord = state.steps.coordinator
  return (
    <div className="border-b border-rule">
      <ol className="divide-y divide-rule">
        {AGENTS.map((a, i) => {
          const st = state.agentStatus[a]
          const steps = state.steps[a]
          const err = state.plan.agent_errors?.[a]
          const active = state.selectedAgent === a
          return (
            <li key={a}>
              <button
                onClick={() => dispatch({ type: 'select_agent', agent: a })}
                aria-current={active ? 'step' : undefined}
                className={`flex w-full items-center gap-3 px-5 py-2 text-left hover:bg-ink/[0.03] ${active ? 'bg-ink/[0.05]' : ''}`}
              >
                <AgentGlyph agent={a} status={st} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`text-[15px] ${active ? 'font-bold' : 'font-semibold'}`}>
                      <span className="tnum text-slate">{String(i + 1).padStart(2, '0')}</span> {AGENT_LABELS[a]}
                    </span>
                    <span className={`text-xs ${st === 'error' ? 'text-gap' : 'text-slate'}`}>{st}</span>
                  </span>
                  {(err || steps.length > 0) && (
                    <span className={`block truncate text-[13px] ${err ? 'text-gap' : 'text-slate'}`}>{err ?? steps[steps.length - 1]}</span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
      {coord.length > 0 && <div className="border-t border-rule px-5 py-1.5 text-xs text-slate">Coordinator: {coord[coord.length - 1]}</div>}
      {state.stream === 'failed' && !state.basePlan && !state.loadError && (
        <div className="px-5 py-1.5 text-xs text-amber-300">Stream unavailable; loading saved plan…</div>
      )}
      {state.loadError && <div className="px-5 py-1.5 text-xs text-gap">Could not load plan: {state.loadError}</div>}
    </div>
  )
}
