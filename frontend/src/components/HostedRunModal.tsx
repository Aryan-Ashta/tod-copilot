import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import { Link } from 'react-router-dom'

// The LA (Wilshire / Koreatown) recorded demo, played back with the full-plan prompt.
const COMPLETED_SITE = '/plan/demo-la_wilshire_koreatown?replay=1&tags=full_plan'

const FOCUSABLE = 'a[href], button:not([disabled])'

/** Shown instead of a live run on the hosted demo, where the server refuses POST /api/plan. */
export default function HostedRunModal({
  repoUrl,
  onClose,
  returnFocus,
}: {
  repoUrl: string
  onClose: () => void
  returnFocus: RefObject<HTMLElement | null>
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const primaryRef = useRef<HTMLAnchorElement>(null)

  useEffect(() => {
    primaryRef.current?.focus()
    const back = returnFocus.current
    return () => back?.focus()
  }, [returnFocus])

  // Escape closes; Tab cycles within the dialog.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-6 backdrop-blur-[2px]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hosted-run-title"
        aria-describedby="hosted-run-body"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="pop-in relative w-[min(460px,100%)] rounded-3xl bg-paper p-6 text-ink shadow-[0_16px_40px_rgb(28_34_48/.22)] focus:outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 grid h-8 w-8 place-items-center rounded-full text-slate transition-colors hover:bg-ink/5 hover:text-ink"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
        <h2 id="hosted-run-title" className="flex items-center gap-2 text-[18px] font-semibold">
          <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-amber-300" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
            <path d="M10 2.8 18 16.8H2L10 2.8Z" />
            <path d="M10 8v4" strokeLinecap="round" />
            <circle cx="10" cy="14.2" r="0.6" fill="currentColor" stroke="none" />
          </svg>
          Warning
        </h2>
        <div id="hosted-run-body" className="mt-3 space-y-2 text-[14.5px] leading-relaxed text-ink/80">
          <p>Due to limited cloud compute, a live run here may take several hours.</p>
          <p>For a more realistic view of this product, clone it from GitHub, or view a completed site.</p>
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-10 items-center gap-2 rounded-full border border-rule px-4 text-[14px] font-medium text-ink transition-colors hover:bg-ink/5 focus-visible:shadow-[0_0_0_4px_rgb(47_91_211/.2)] focus-visible:outline-none"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            Clone on GitHub
          </a>
          <Link
            ref={primaryRef}
            to={COMPLETED_SITE}
            className="flex h-10 items-center rounded-full bg-blue px-5 text-[14px] font-semibold text-paper shadow-[0_0_0_4px_rgb(47_91_211/.25)] transition-[background-color,box-shadow] hover:bg-sky-300 focus-visible:shadow-[0_0_0_4px_rgb(47_91_211/.4)] focus-visible:outline-none"
          >
            View a completed site
          </Link>
        </div>
      </div>
    </div>
  )
}
