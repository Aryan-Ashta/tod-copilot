import { useLayoutEffect, useRef, useState } from 'react'
import { usePlan, statValue, type HistoryItem } from '../state/PlanContext'
import { STAT_META, deltaGood, deltaShown, fmtStat, fmtStatDelta, type StatMeta } from './Scoreboard'
import { BarMarkers, currentSnapshot } from './TargetBars'
import { historyColor, historyInk, setHistoryFocus, useHistoryFocus } from './HistoryPanel'
import AnimatedNumber from './AnimatedNumber'
import FactorHover from './FactorHover'

/** A segment shows its entry's number when at least this wide (px). */
const LABEL_MIN_PX = 18

/** The last change of `value` (null → number is no change), counted so a badge keyed on `n` replays per change. */
function useLastChange(value: number | null): { delta: number | null; n: number } {
  const [track, setTrack] = useState({ value, delta: null as number | null, n: 0 })
  if (track.value !== value) {
    setTrack({
      value,
      delta: value !== null && track.value !== null ? value - track.value : null,
      n: track.n + 1,
    })
  }
  return track
}

/** Width of an element in px, kept current with a ResizeObserver. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

interface Segment {
  h: HistoryItem
  d: number
  /** Left edge and width on the row's scale, percent. */
  left: number
  width: number
}

/**
 * The stat as a stack: a grey existing-conditions block from zero, then each history entry's gain as a segment in
 * its colour, in history order. Losses are hatched in the entry's colour over the end of the stack, so the solid
 * part left of the hatching is the plan's value and the hatching is what was taken away.
 */
function ContributionBar({ m, existing, current, agents }: { m: StatMeta; existing: number; current: number; agents: number | null }) {
  const { state } = usePlan()
  const focus = useHistoryFocus()
  const [ref, barW] = useWidth()
  const parts = state.history.flatMap((h) => {
    const d = h.delta[m.key]
    return d !== undefined && deltaShown(m, d) ? [{ h, d }] : []
  })
  const base = Math.max(existing, 0)
  const top = base + parts.reduce((a, p) => a + Math.max(p.d, 0), 0)
  const scale = m.pct ? 100 : Math.max(Math.abs(existing), Math.abs(current), Math.abs(agents ?? 0), top) * 1.1
  const at = (v: number) => (scale > 0 ? Math.min(100, Math.max(0, (v / scale) * 100)) : 0)

  const gains: Segment[] = []
  const losses: Segment[] = []
  let x = base
  let y = top
  for (const { h, d } of parts) {
    if (d > 0) {
      gains.push({ h, d, left: at(x), width: at(x + d) - at(x) })
      x += d
    } else {
      losses.push({ h, d, left: at(y + d), width: at(y) - at(y + d) })
      y += d
    }
  }

  const seg = (s: Segment, loss: boolean) => {
    const color = historyColor(s.h.index)
    const dim = focus !== null && focus !== s.h.id
    const lit = focus === s.h.id
    const label = `#${s.h.index} ${s.h.title}${s.h.where ? ` · ${s.h.where}` : ''}: ${fmtStatDelta(m, s.d)} ${m.short}`
    return (
      <span
        key={`${loss ? 'l' : 'g'}${s.h.id}`}
        title={label}
        onMouseEnter={() => setHistoryFocus(s.h.id)}
        onMouseLeave={() => setHistoryFocus(null)}
        className={`seg ${loss ? 'seg-loss' : 'seg-grow'} absolute inset-y-0 flex items-center justify-center overflow-hidden text-[10px] leading-none font-bold tabular-nums ${
          lit ? 'z-10 -translate-y-px shadow-[0_0_0_1.5px_var(--color-ink)]' : ''
        } ${dim ? 'opacity-35' : ''}`}
        style={{
          left: `${s.left}%`,
          width: `${s.width}%`,
          color: loss ? 'var(--color-ink)' : historyInk(s.h.index),
          ...(loss
            ? {
                background: `repeating-linear-gradient(135deg, ${color} 0 2.5px, rgb(237 239 234 / .75) 2.5px 5px)`,
                boxShadow: lit ? undefined : `inset 0 0 0 1px ${color}`,
              }
            : { background: color }),
        }}
      >
        {(s.width / 100) * barW >= LABEL_MIN_PX && (
          <span className={loss ? 'rounded-full bg-paper px-0.5' : ''}>{s.h.index}</span>
        )}
      </span>
    )
  }

  return (
    <div className="relative mt-3.5 h-3.5" ref={ref}>
      <div className="absolute inset-0 overflow-hidden rounded-[5px] bg-rule/60">
        {m.pct &&
          [25, 50, 75].map((q) => <span key={q} className="absolute inset-y-0 w-px bg-paper" style={{ left: `${q}%` }} />)}
        <span
          className="seg absolute inset-y-0 left-0 bg-ink/20"
          style={{ width: `${at(base)}%` }}
          title={`Existing: ${fmtStat(m, existing)}${m.unit ? ` ${m.unit}` : ''}`}
        />
        {gains.map((s) => seg(s, false))}
        {losses.map((s) => seg(s, true))}
      </div>
      <BarMarkers existing={existing} agents={agents} at={at} labels />
      <span
        className="bar-move pointer-events-none absolute -inset-y-1 w-[3px] -translate-x-1/2 rounded-full bg-ink shadow-[0_0_0_1.5px_var(--color-paper)]"
        style={{ left: `${at(current)}%` }}
        aria-hidden
      />
    </div>
  )
}

function StatRow({ m }: { m: StatMeta }) {
  const { state } = usePlan()
  const cur = currentSnapshot(state)
  const current = statValue(cur, m.key)
  const existing = statValue(state.existing, m.key)
  const agents = statValue(state.suggested, m.key)
  const change = useLastChange(current)
  const target = cur?.targets.find((t) => t.key === m.key)
  const unit = target?.unit ?? m.unit
  const factors = target?.factor_keys ?? m.factors
  if (current === null) return null
  const vsAgents = agents === null ? null : current - agents
  return (
    <li data-stat={m.key} className="py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <FactorHover keys={factors}>
          <span className="text-[14px] text-slate">{m.label}</span>
        </FactorHover>
        <span className="flex items-baseline gap-1.5 whitespace-nowrap">
          {change.delta !== null && deltaShown(m, change.delta) && (
            <span
              key={change.n}
              className={`stat-diff rounded-[5px] px-1.5 text-[12px] leading-[18px] font-bold tabular-nums ${
                deltaGood(m, change.delta) ? 'bg-emerald-900 text-emerald-200' : 'bg-rose-900 text-rose-200'
              }`}
            >
              {fmtStatDelta(m, change.delta)}
            </span>
          )}
          <span className="display text-[24px]">
            <AnimatedNumber value={current} format={(v) => fmtStat(m, v)} />
          </span>
          {unit && <span className="text-[13px] text-slate">{unit}</span>}
        </span>
      </div>
      <ContributionBar m={m} existing={existing ?? 0} current={current} agents={agents} />
      <div className="mt-1 truncate text-[12px] text-slate tabular-nums">
        existing {existing === null ? '—' : fmtStat(m, existing)} · plan {fmtStat(m, current)}
        {agents !== null && vsAgents !== null && (
          <>
            {' '}
            · agents {fmtStat(m, agents)}{' '}
            <span className={deltaShown(m, vsAgents) ? 'font-semibold text-ink' : ''}>
              ({deltaShown(m, vsAgents) ? `plan ${fmtStatDelta(m, vsAgents)}` : 'same'})
            </span>
          </>
        )}
      </div>
    </li>
  )
}

/** Meeting mode's stats: each stat's value, its change, and a bar built from the plan history's contributions,
 *  with existing conditions and the agents' suggestion marked on the same scale. */
export default function StatsPanel() {
  const { state } = usePlan()
  if (!state.scoreboard) {
    return (
      <p className="text-[15px] text-slate">
        {state.rescoreError ? `Stats unavailable: ${state.rescoreError}` : 'Scoring existing conditions…'}
      </p>
    )
  }
  const palette = [1, 2, 3].map(historyColor)
  return (
    <section aria-label="Stats" className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate" aria-hidden>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-4 rounded-[3px] bg-ink/20" /> Existing
        </span>
        <span className="flex items-center gap-1">
          <span className="flex h-2.5 w-6 overflow-hidden rounded-[3px]">
            {palette.map((c) => (
              <span key={c} className="flex-1" style={{ background: c }} />
            ))}
          </span>
          Your plan
        </span>
        <span className="flex items-center gap-1">
          <span className="h-3 border-l-[1.5px] border-dashed border-ink" /> Agents
        </span>
        <span className="flex items-center gap-1">
          <span
            className="h-2.5 w-4 rounded-[3px]"
            style={{ background: `repeating-linear-gradient(135deg, ${palette[0]} 0 2.5px, transparent 2.5px 5px)` }}
          />
          Removed
        </span>
      </div>
      <ul className="divide-y divide-rule">
        {STAT_META.map((m) => (
          <StatRow key={m.key} m={m} />
        ))}
      </ul>
    </section>
  )
}
