import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../state/AppContext'
import { fmtValue, humanize } from '../format'
import type { Factor } from '../types'

/** "la_wilshire_koreatown" → "LA Wilshire Koreatown": locale ids and mapping keys as words. */
const titleWords = (s: string) =>
  humanize(s).replace(/\b\w+/g, (w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))

/**
 * Prose from factors.yaml can name other factors (`stop_catchment_m`) or source columns (`type_of_service`):
 * a factor key becomes its label, any other snake_case identifier its spaced-out words.
 */
function readable(text: string, factors: Record<string, Factor>): string {
  return text.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (k) => factors[k]?.label ?? humanize(k))
}

/** A factor value as people read it: ranges as a–b, per-place or per-part mappings as one row each. */
function FactorValue({ value, unit }: { value: unknown; unit: string }) {
  if (Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number')) {
    return <span className="block text-neutral-300">{fmtValue(value[0])}–{fmtValue(value[1])} {unit}</span>
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (
      <span className="my-0.5 grid grid-cols-[auto_1fr] gap-x-3 text-neutral-300">
        {Object.entries(value).map(([k, v]) => (
          <Fragment key={k}>
            <span className="text-neutral-400">{titleWords(k)}</span>
            <span className="tabular-nums">
              {v && typeof v === 'object'
                ? Object.entries(v).map(([k2, v2]) => `${humanize(k2)} ${fmtValue(v2)}`).join(' · ')
                : `${fmtValue(v)} ${unit}`}
            </span>
          </Fragment>
        ))}
      </span>
    )
  }
  return <span className="block text-neutral-300">{fmtValue(value)} {unit}</span>
}

const MARGIN = 8
const WIDTH = 384

/** Fixed-position style that keeps the popover inside the viewport: below the trigger, or above when it would
 *  run off the bottom; clamped horizontally; scrolls inside when taller than the viewport. */
function placement(trigger: DOMRect, height: number | null): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(WIDTH, vw - 2 * MARGIN)
  const left = Math.min(Math.max(trigger.left, MARGIN), vw - width - MARGIN)
  const h = Math.min(height ?? 0, vh - 2 * MARGIN)
  const below = trigger.bottom + 4
  const top = below + h <= vh - MARGIN ? below : Math.max(MARGIN, trigger.top - 4 - h)
  return { position: 'fixed', left, top, width, maxHeight: vh - 2 * MARGIN, overflowY: 'auto',
           visibility: height === null ? 'hidden' : 'visible' }
}

/** Hover a score or target to see the factors behind it: value, unit, source link and "unverified" mark. */
export default function FactorHover({ keys, children }: { keys: string[]; children: ReactNode }) {
  const { factors, factorsError } = useApp()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const pop = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (rect && pop.current) setHeight(pop.current.scrollHeight)
  }, [rect])
  if (!keys.length) return <>{children}</>
  // the popover is portalled to <body> so no ancestor can clip or widen; React events still bubble to this span
  const show = (e: MouseEvent<HTMLSpanElement>) => {
    window.clearTimeout(closeTimer.current)
    if (!rect) setRect(e.currentTarget.getBoundingClientRect())
  }
  const hide = () => {
    closeTimer.current = window.setTimeout(() => {
      setRect(null)
      setHeight(null)
    }, 120)
  }
  return (
    <span className="relative inline-block" onMouseEnter={show} onMouseLeave={hide}>
      <span className="cursor-help underline decoration-neutral-600 decoration-dotted underline-offset-2">{children}</span>
      {rect && createPortal(
        <span
          ref={pop}
          style={placement(rect, height)}
          className="z-[200] block rounded-xl border border-rule bg-paper p-2.5 text-left text-xs leading-snug shadow-[0_8px_24px_rgb(28_34_48/.12)]"
        >
          <span className="mb-1 block text-xs text-slate">Factors behind this number</span>
          {keys.map((k) => {
            const f = factors[k]
            return (
              <span key={k} className="block border-t border-rule py-1.5 first:border-t-0">
                <span className="flex items-baseline gap-2">
                  <span className="font-medium text-neutral-100" title={k}>{f?.label ?? humanize(k)}</span>
                  {f && !f.verified && (
                    <span className="text-[11px] text-amber-300">unverified</span>
                  )}
                </span>
                {f ? (
                  <>
                    <FactorValue value={f.value} unit={readable(f.unit, factors)} />
                    {f.source_url.startsWith('http') ? (
                      <a href={f.source_url} target="_blank" rel="noreferrer" className="block truncate text-sky-400 hover:underline">
                        {f.source_url}
                      </a>
                    ) : (
                      <span className="block text-neutral-400">source: {readable(f.source_url, factors)}</span>
                    )}
                    {f.note && <span className="block text-neutral-500">{readable(f.note, factors)}</span>}
                  </>
                ) : (
                  <span className="block text-neutral-500">{factorsError ? `factors unavailable (${factorsError})` : 'loading…'}</span>
                )}
              </span>
            )
          })}
        </span>,
        document.body,
      )}
    </span>
  )
}

/** Factor's human label, falling back to the key with underscores spaced out. */
export function useFactorLabel(): (key: string) => string {
  const { factors } = useApp()
  return (key: string) => factors[key]?.label ?? humanize(key)
}

/** Text that may name factors as `key` (blockers, agent notes): each becomes its label, with the factor on hover. */
export function FactorText({ text }: { text: string }) {
  const { factors } = useApp()
  const parts = text.split(/`([^`]+)`/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 0 ? (
          <Fragment key={i}>{p}</Fragment>
        ) : factors[p] ? (
          <FactorHover key={i} keys={[p]}>
            {factors[p].label ?? humanize(p)}
          </FactorHover>
        ) : (
          <Fragment key={i}>{humanize(p)}</Fragment>
        ),
      )}
    </>
  )
}
