import { useId, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react'

/**
 * Panel over the map: paper, hairline border, collapsible (the map gets the room when collapsed). The body opens
 * and closes with a height transition (grid rows 0fr ↔ 1fr) and the chevron turns with it.
 */
export default function MapPanel({
  title,
  defaultOpen = false,
  className = '',
  right,
  children,
  ...rest
}: {
  title: ReactNode
  defaultOpen?: boolean
  className?: string
  /** Shown in the header next to the toggle (e.g. "updating…"). */
  right?: ReactNode
  children: ReactNode
} & Omit<ComponentPropsWithoutRef<'section'>, 'title' | 'className' | 'children'>) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <section
      {...rest}
      className={`overflow-hidden rounded-[12px] border border-rule bg-paper/95 text-[13px] leading-snug shadow-[0_6px_20px_rgb(28_34_48/.1)] backdrop-blur-sm ${className}`}
    >
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={id}
        className="group flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-ink/[0.04]"
      >
        <span className="wide font-bold">{title}</span>
        <span className="flex items-center gap-3 text-slate">
          {right}
          <span
            aria-hidden
            className={`flex h-6 w-6 items-center justify-center rounded-full border border-rule transition-[rotate,border-color] duration-300 group-hover:border-ink ${open ? 'rotate-180' : ''}`}
          >
            <svg viewBox="0 0 10 6" className="h-1.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M1 1l4 4 4-4" />
            </svg>
          </span>
        </span>
      </button>
      <div id={id} className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`} inert={!open}>
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-rule px-3 pt-2 pb-3">{children}</div>
        </div>
      </div>
    </section>
  )
}
