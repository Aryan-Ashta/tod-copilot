import { Link } from 'react-router-dom'

/** The Transitor mark (same drawing as public/favicon.svg): a rail line and a route forming a T, with two stops. */
function Mark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="inline-block h-[0.95em] w-[0.95em] shrink-0 align-[-0.15em]">
      <rect width="32" height="32" rx="7" fill="#1C2230" />
      <path d="M7 10.5h18" stroke="#13808A" strokeWidth="4" strokeLinecap="round" />
      <path d="M16 10.5V23" stroke="#2F5BD3" strokeWidth="4" strokeLinecap="round" />
      <circle cx="16" cy="10.5" r="3.6" fill="#EDEFEA" stroke="#13808A" strokeWidth="2" />
      <circle cx="16" cy="23.5" r="3.6" fill="#EDEFEA" stroke="#2F5BD3" strokeWidth="2" />
    </svg>
  )
}

/** The Transitor mark and name, linking home. The mark scales with the font size. */
export default function Brand({ className = '' }: { className?: string }) {
  return (
    <Link to="/" className={`wide font-bold whitespace-nowrap text-ink no-underline ${className}`}>
      <Mark />
      <span className="ml-2">Transitor</span>
    </Link>
  )
}
