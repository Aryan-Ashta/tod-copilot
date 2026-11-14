import type { ReactNode } from 'react'
import { sourceLabel } from '../format'
import type { Confidence, Provenance, Sourced } from '../types'

const CONF_CLASS: Record<Confidence, string> = {
  high: 'border-emerald-700 bg-emerald-950 text-emerald-300',
  medium: 'border-sky-700 bg-sky-950 text-sky-300',
  low: 'border-amber-700 bg-amber-950 text-amber-300',
  missing: 'border-rose-800 bg-rose-950 text-rose-300',
}

/** "<source> · <confidence>"; a missing value shows just "missing". */
export default function SourceBadge({ prov }: { prov: Provenance }) {
  const text = prov.confidence === 'missing' ? 'missing' : `${sourceLabel(prov.source)} · ${prov.confidence}`
  const title = [
    `source: ${sourceLabel(prov.source)}`,
    `confidence: ${prov.confidence}`,
    `retrieved: ${prov.retrieved_at}`,
    prov.url ? `url: ${prov.url}` : null,
    prov.note ? `note: ${prov.note}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] leading-4 font-medium whitespace-nowrap ${CONF_CLASS[prov.confidence]}`}
    >
      {text}
    </span>
  )
}

/** A Sourced value with its badge; missing values render as "missing", never filled in. */
export function SourcedValue<T>({ s, fmt }: { s: Sourced<T> | undefined; fmt?: (v: T) => ReactNode }) {
  if (!s) return <span className="text-neutral-500">—</span>
  const shown = s.value === null || s.value === undefined ? null : fmt ? fmt(s.value) : String(s.value)
  return (
    <span className="inline-flex items-center gap-1.5">
      {shown === null ? <span className="text-neutral-500 italic">missing</span> : <span>{shown}</span>}
      <SourceBadge prov={s.prov} />
    </span>
  )
}
