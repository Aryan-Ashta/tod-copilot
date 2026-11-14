import { useState, type ReactNode } from 'react'

const WIDTH_PX = 440

/**
 * Fixed-width side panel beside the map that slides shut and open. Its content keeps its width while the panel
 * animates, so nothing reflows; the map takes the freed space. Open or shut is kept per browser under `storageKey`.
 */
export default function SidePanel({
  storageKey,
  label,
  panel,
  children,
}: {
  storageKey: string
  label: string
  panel: ReactNode
  children: ReactNode
}) {
  const [open, setOpenState] = useState(() => localStorage.getItem(storageKey) !== 'closed')
  const setOpen = (v: boolean) => {
    setOpenState(v)
    localStorage.setItem(storageKey, v ? 'open' : 'closed')
  }
  return (
    <div className="flex min-h-0 flex-1">
      <aside
        id={storageKey}
        aria-label={label}
        inert={!open}
        className={`side-panel shrink-0 overflow-hidden ${open ? 'border-r border-rule' : ''}`}
        style={{ width: open ? WIDTH_PX : 0 }}
      >
        <div
          className={`side-panel-body flex h-full flex-col overflow-y-auto ${open ? '' : 'opacity-0'}`}
          style={{ width: WIDTH_PX, translate: open ? '0' : `-${WIDTH_PX / 4}px 0` }}
        >
          {panel}
        </div>
      </aside>
      <div className="relative min-w-0 flex-1">
        {children}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          aria-controls={storageKey}
          aria-label={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          title={open ? 'Hide panel' : 'Show panel'}
          className="group absolute top-1/2 left-0 z-20 flex h-14 w-6 -translate-y-1/2 items-center justify-center rounded-r-xl border border-l-0 border-rule bg-paper/95 shadow-[0_6px_18px_rgb(28_34_48/.12)] backdrop-blur-sm transition-[width,background-color] duration-200 hover:w-7 hover:bg-white"
        >
          <svg
            viewBox="0 0 6 10"
            className={`h-2.5 w-1.5 text-ink transition-transform duration-300 ${open ? '' : 'rotate-180'}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden
          >
            <path d="M5 1L1 5l4 4" />
          </svg>
        </button>
      </div>
    </div>
  )
}
