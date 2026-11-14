import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../state/AppContext'
import { fmtValue, humanize } from '../format'

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
          className="z-[200] block border border-rule bg-paper p-2.5 text-left text-xs leading-snug"
        >
          <span className="mb-1 block text-xs text-slate">Factors behind this number</span>
          {keys.map((k) => {
            const f = factors[k]
            return (
              <span key={k} className="block border-t border-rule py-1.5 first:border-t-0">
                {f?.label && <span className="block font-medium text-neutral-100">{f.label}</span>}
                <span className="flex items-center gap-2">
                  <code className="text-neutral-400">{k}</code>
                  {f && !f.verified && (
                    <span className="text-[11px] text-amber-300">unverified</span>
                  )}
                </span>
                {f ? (
                  <>
                    <span className="block text-neutral-300">
                      {fmtValue(f.value)} {f.unit}
                    </span>
                    {f.source_url.startsWith('http') ? (
                      <a href={f.source_url} target="_blank" rel="noreferrer" className="block truncate text-sky-400 hover:underline">
                        {f.source_url}
                      </a>
                    ) : (
                      <span className="block text-neutral-400">source: {f.source_url}</span>
                    )}
                    {f.note && <span className="block text-neutral-500">{f.note}</span>}
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
