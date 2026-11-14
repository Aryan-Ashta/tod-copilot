import type { ReactNode } from 'react'
import { useApp } from '../../state/AppContext'
import { FactorText } from '../FactorHover'
import { sectionLabel } from '../../format'
import type { Citation } from '../../types'

export function CardShell({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="space-y-6 px-5 pt-5 pb-10">
      <h2 className="wide border-t-2 border-ink pt-3 text-[28px] leading-tight font-bold">{title}</h2>
      {note && (
        <p className="max-w-[68ch] border-l-2 border-rule pl-4 text-[15px] leading-relaxed">
          <FactorText text={note} />
        </p>
      )}
      {children}
    </div>
  )
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between border-b border-rule pb-1">
        <h3 className="text-sm font-semibold text-slate">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-neutral-500 italic">{children}</p>
}

export function CiteLink({ c }: { c: Citation }) {
  const { openCitation } = useApp()
  const quotes = c.quotes ?? [c.quote]
  return (
    <button
      onClick={() => openCitation(c)}
      title={quotes.join('\n\n')}
      className="border-b border-rule text-xs text-sky-300 hover:border-sky-300"
    >
      {sectionLabel(c.section)} cited
      {quotes.length > 1 && <span className="text-slate"> · {quotes.length} provisions</span>}
    </button>
  )
}

/** One chip per (doc_id, section); repeated sections merge their quotes so the drawer highlights each one. */
export function CiteList({ citations, label }: { citations: Citation[]; label?: string }) {
  const groups = new Map<string, Citation>()
  for (const c of citations) {
    const k = `${c.doc_id}\u0000${c.section}`
    const g = groups.get(k)
    if (!g) groups.set(k, { ...c, quotes: [c.quote] })
    else if (!g.quotes!.includes(c.quote)) g.quotes!.push(c.quote)
  }
  if (!groups.size) return null
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      {label && <span className="text-xs text-slate">{label}</span>}
      {[...groups.entries()].map(([k, c]) => (
        <CiteLink key={k} c={c} />
      ))}
    </div>
  )
}

export function Bar({ value, max, color = 'bg-sky-500' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-rule">
      <div className={`h-full rounded-full ${color} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export const th = 'py-1.5 pr-3 text-left text-[13px] font-semibold text-slate border-b border-rule'
export const td = 'py-1.5 pr-3 align-top border-b border-rule'
