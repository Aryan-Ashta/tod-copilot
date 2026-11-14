import { useId, useState, type ReactNode } from 'react'

/** Panel over the map: paper, hairline border, square, collapsible (the map gets the room when collapsed). */
export default function MapPanel({
  title,
  defaultOpen = false,
  className = '',
  right,
  children,
}: {
  title: ReactNode
  defaultOpen?: boolean
  className?: string
  /** Shown in the header next to the toggle (e.g. "updating…"). */
  right?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <section className={`border border-rule bg-paper/95 text-[13px] leading-snug ${className}`}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left"
      >
        <span className="wide font-bold">{title}</span>
        <span className="flex items-baseline gap-3 text-slate">
          {right}
          <span aria-hidden>{open ? '−' : '+'}</span>
        </span>
      </button>
      {open && (
        <div id={id} className="border-t border-rule px-3 pt-2 pb-3">
          {children}
        </div>
      )}
    </section>
  )
}
