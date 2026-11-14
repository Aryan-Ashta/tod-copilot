import type { ReactNode } from 'react'
import { useApp } from '../../state/AppContext'
import type { Citation } from '../../types'

export function CardShell({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {note && <p className="rounded border border-neutral-800 bg-neutral-900 p-2 text-sm text-neutral-300">{note}</p>}
      {children}
    </div>
  )
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">{title}</h3>
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
  return (
    <button
      onClick={() => openCitation(c)}
      title={c.quote}
      className="rounded bg-neutral-800 px-1.5 py-px text-[11px] text-sky-300 hover:bg-neutral-700"
    >
      § {c.section} cited
    </button>
  )
}

export function Bar({ value, max, color = 'bg-sky-500' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-neutral-800">
      <div className={`h-full ${color} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
    </div>
  )
}

export const th = 'px-2 py-1 text-left text-[11px] font-medium text-neutral-400'
export const td = 'px-2 py-1 align-top'
