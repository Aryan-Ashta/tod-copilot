import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** Header shown on every screen: the site's nav (name left, small links right), with the disclaimer kept visible. */
export default function Disclaimer({ children, large = false }: { children?: ReactNode; large?: boolean }) {
  return (
    <header
      className={`flex shrink-0 items-baseline gap-5 border-b border-rule bg-paper px-6 ${large ? 'py-3 text-lg' : 'py-2.5 text-sm'}`}
    >
      <Link to="/" className={`wide font-bold text-ink no-underline hover:underline ${large ? 'text-2xl' : 'text-[19px]'}`}>
        TOD Copilot
      </Link>
      <span className="text-slate">Concept · estimates, not legal or financial advice</span>
      <nav className="ml-auto flex items-baseline gap-5 text-sm">{children}</nav>
    </header>
  )
}
