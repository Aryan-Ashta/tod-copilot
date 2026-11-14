import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** Header shown on every screen. */
export default function Disclaimer({ children, large = false }: { children?: ReactNode; large?: boolean }) {
  return (
    <header
      className={`flex shrink-0 items-center gap-4 border-b border-neutral-800 bg-neutral-950 px-4 ${large ? 'h-14 text-lg' : 'h-10 text-sm'}`}
    >
      <Link to="/" className="font-semibold tracking-tight text-neutral-100">
        TOD Copilot
      </Link>
      <span className="text-neutral-400">Concept · estimates, not legal or financial advice</span>
      <div className="ml-auto flex items-center gap-3">{children}</div>
    </header>
  )
}
