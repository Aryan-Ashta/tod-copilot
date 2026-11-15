import { useRef, useState, type ReactNode } from 'react'

const MIN_LEFT_PX = 300
const MAX_FRAC = 0.7

/**
 * Side panel and map side by side with a draggable divider. The split is a fraction of the width, kept in
 * localStorage under `storageKey`; arrow keys nudge it, Home/End jump to the limits, double-click resets it.
 */
export default function SplitPane({
  storageKey,
  defaultFrac,
  left,
  right,
  leftLabel,
  leftDemo,
}: {
  storageKey: string
  defaultFrac: number
  left: ReactNode
  right: ReactNode
  leftLabel: string
  /** `data-demo` hook on the left pane's scroll container (the demo sequence scrolls it). */
  leftDemo?: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [frac, setFracState] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return saved > 0 && saved <= MAX_FRAC ? saved : defaultFrac
  })
  const [dragging, setDragging] = useState(false)

  const setFrac = (f: number) => {
    const w = boxRef.current?.clientWidth ?? 1
    const next = Math.min(MAX_FRAC, Math.max(MIN_LEFT_PX / w, f))
    setFracState(next)
    localStorage.setItem(storageKey, String(next))
  }
  const fracAt = (clientX: number) => {
    const r = boxRef.current!.getBoundingClientRect()
    return (clientX - r.left) / r.width
  }

  return (
    <div ref={boxRef} className={`relative flex min-h-0 flex-1 ${dragging ? 'cursor-col-resize select-none' : ''}`}>
      <aside
        aria-label={leftLabel}
        data-demo={leftDemo}
        className="relative flex shrink-0 flex-col overflow-y-auto"
        style={{ width: `${frac * 100}%`, minWidth: MIN_LEFT_PX, maxWidth: `${MAX_FRAC * 100}%` }}
      >
        {left}
      </aside>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel and map"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        tabIndex={0}
        data-dragging={dragging}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => dragging && setFrac(fracAt(e.clientX))}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => setFrac(defaultFrac)}
        onKeyDown={(e) => {
          const k = e.key
          if (k === 'ArrowLeft') setFrac(frac - 0.02)
          else if (k === 'ArrowRight') setFrac(frac + 0.02)
          else if (k === 'Home') setFrac(0)
          else if (k === 'End') setFrac(MAX_FRAC)
          else return
          e.preventDefault()
        }}
        title="Drag to resize; double-click to reset"
        className="group relative z-20 w-px shrink-0 cursor-col-resize bg-rule outline-none"
      >
        {/* wide invisible hit area */}
        <span className="absolute inset-y-0 -right-1.5 -left-1.5" />
        <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ink opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[dragging=true]:opacity-100" />
        <span className="absolute top-1/2 left-1/2 flex h-10 w-3.5 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 rounded-full border-[1.5px] border-ink bg-paper shadow-[1.5px_1.5px_0_var(--color-ink)] transition-[scale] duration-150 group-hover:scale-110 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ink group-data-[dragging=true]:scale-110">
          <span className="h-1 w-1 rounded-full bg-ink" />
          <span className="h-1 w-1 rounded-full bg-ink" />
          <span className="h-1 w-1 rounded-full bg-ink" />
        </span>
      </div>
      <div className="relative min-w-0 flex-1">{right}</div>
    </div>
  )
}
