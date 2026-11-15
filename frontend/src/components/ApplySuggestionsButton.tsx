import { usePlan, suggestionsApplied } from '../state/PlanContext'
import { fmtNum } from '../format'
import { AGENTS } from '../types'
import './ApplySuggestionsButton.css'

/** Small ring showing agents finished out of all agents. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 7
  const c = 2 * Math.PI * r
  return (
    <svg viewBox="0 0 18 18" className="h-4.5 w-4.5 shrink-0 -rotate-90" aria-hidden>
      <circle cx={9} cy={9} r={r} fill="none" stroke="var(--color-rule)" strokeWidth={2.5} />
      <circle
        className="apply-ring__bar"
        cx={9}
        cy={9}
        r={r}
        fill="none"
        stroke="var(--color-blue)"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - (total ? done / total : 0))}
      />
    </svg>
  )
}

function Sparkle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <g className="apply-cta__sparkle">
        <path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z" fill="currentColor" />
      </g>
      <path d="M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="var(--color-mustard)" />
    </svg>
  )
}

/**
 * The one way the agents' suggestions reach the map: adds an `apply_suggestions` edit.
 * Agents running → disabled progress; ready → emphasised call to action; applied → subdued pill with "Remove".
 */
export default function ApplySuggestionsButton({ className = '', large = false }: { className?: string; large?: boolean }) {
  const { state, dispatch } = usePlan()
  const total = AGENTS.length
  const done = AGENTS.filter((a) => state.agentStatus[a] === 'done' || state.agentStatus[a] === 'error').length
  const applyEntry = state.edits.find((e) => e.edit.kind === 'apply_suggestions')

  if (applyEntry && suggestionsApplied(state)) {
    const applying = !state.scoreSteps[applyEntry.id] && !state.rescoreError
    if (applying) {
      return (
        <div
          data-hint-anchor="apply"
          role="status"
          className={`pop-in inline-flex items-center gap-2 rounded-full border-[1.5px] border-ink bg-paper px-3.5 py-1.5 text-[14px] font-semibold shadow-[1.5px_1.5px_0_var(--color-ink)] ${className}`}
        >
          <svg viewBox="0 0 16 16" className="apply-spin h-4 w-4 text-blue" aria-hidden>
            <circle cx={8} cy={8} r={6} fill="none" stroke="var(--color-rule)" strokeWidth={2} />
            <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          </svg>
          Applying agents' plan…
        </div>
      )
    }
    return (
      <div
        data-hint-anchor="apply"
        className={`pop-in inline-flex items-center gap-2.5 rounded-full border border-rule bg-paper/95 px-3.5 py-1 text-[13px] text-slate shadow-[0_2px_8px_rgb(28_34_48/.08)] ${className}`}
      >
        <span className="font-semibold text-green">Agents' plan applied ✓</span>
        <button
          onClick={() => dispatch({ type: 'remove_edit', id: applyEntry.id })}
          className="text-[12px] text-slate underline decoration-rule underline-offset-2 hover:text-gap hover:decoration-gap"
        >
          Remove
        </button>
      </div>
    )
  }

  const running = !state.basePlan || done < total
  if (running) {
    return (
      <button
        data-hint-anchor="apply"
        disabled
        title="Available once every agent has finished"
        className={`inline-flex items-center gap-2 rounded-full border-[1.5px] border-rule bg-paper/95 px-3.5 py-1.5 text-[14px] font-semibold text-slate shadow-[0_2px_8px_rgb(28_34_48/.08)] ${className}`}
      >
        <ProgressRing done={done} total={total} />
        <span>
          Agents working… <span className="tabular-nums">{done}/{total}</span>
        </span>
      </button>
    )
  }

  const homes = state.suggested
    ? state.suggested.scoreboard.homes - (state.existing?.scoreboard.homes ?? 0)
    : null
  const sites = (state.plan.sites ?? []).filter((s) => s.status === 'pursue' || s.status === 'watch').length
  const sub = [homes !== null ? `${homes >= 0 ? '+' : ''}${fmtNum(homes)} homes` : null, `${fmtNum(sites)} ${sites === 1 ? 'site' : 'sites'}`]
    .filter(Boolean)
    .join(' · ')

  return (
    <button
      data-hint-anchor="apply"
      onClick={() => dispatch({ type: 'apply_suggestions' })}
      title="Build the agents' suggested sites and transit on the map"
      className={`apply-cta pop-in inline-flex items-center rounded-[14px] border-[1.5px] border-ink bg-blue text-paper shadow-[2px_2px_0_var(--color-ink),0_10px_28px_rgb(47_91_211/.28)] ${
        large ? 'gap-3 px-5 py-2.5' : 'gap-2 px-3.5 py-1.5'
      } ${className}`}
    >
      <span className="apply-cta__shine" aria-hidden />
      <Sparkle className={large ? 'h-7 w-7 shrink-0' : 'h-5 w-5 shrink-0'} />
      <span className="flex flex-col items-start text-left leading-tight">
        <span className={`font-bold ${large ? 'text-[18px]' : 'text-[15px]'}`}>Apply agent suggestions</span>
        {sub && <span className={`tabular-nums text-paper/80 ${large ? 'text-[13px]' : 'text-[12px]'}`}>{sub}</span>}
      </span>
    </button>
  )
}
