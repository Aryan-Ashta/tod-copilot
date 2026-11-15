import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/** The Transitor mark (same drawing as public/favicon.svg): a rail line and a route forming a T, with two stops. */
function Mark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" className="inline-block shrink-0 align-[-0.15em]">
      <rect width="32" height="32" rx="7" fill="#1C2230" />
      <path d="M7 10.5h18" stroke="#13808A" strokeWidth="4" strokeLinecap="round" />
      <path d="M16 10.5V23" stroke="#2F5BD3" strokeWidth="4" strokeLinecap="round" />
      <circle cx="16" cy="10.5" r="3.6" fill="#EDEFEA" stroke="#13808A" strokeWidth="2" />
      <circle cx="16" cy="23.5" r="3.6" fill="#EDEFEA" stroke="#2F5BD3" strokeWidth="2" />
    </svg>
  )
}

/** Header shown on every screen: the site's nav (name left, small links right), with the disclaimer kept visible. */
export default function Disclaimer({ children, large = false }: { children?: ReactNode; large?: boolean }) {
  return (
    <header
      className={`flex shrink-0 items-baseline gap-5 border-b border-rule bg-paper px-6 ${large ? 'py-3 text-lg' : 'py-2.5 text-sm'}`}
    >
      <Link to="/" className={`wide font-bold text-ink no-underline ${large ? 'text-2xl' : 'text-[19px]'}`}>
        <Mark size={large ? 22 : 18} />
        <span className="ml-2">Transitor</span>
      </Link>
      <span className="text-slate">Concept · estimates, not legal or financial advice</span>
      <nav className="ml-auto flex items-baseline gap-5 text-sm">{children}</nav>
    </header>
  )
}
