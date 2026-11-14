import { Fragment, useState, type ReactNode } from 'react'
import { useApp } from '../state/AppContext'
import { fmtValue, humanize } from '../format'

/** Hover a score or target to see the factors behind it: value, unit, source link and "unverified" mark. */
export default function FactorHover({ keys, children }: { keys: string[]; children: ReactNode }) {
  const { factors, factorsError } = useApp()
  const [open, setOpen] = useState(false)
  if (!keys.length) return <>{children}</>
  return (
    <span className="relative inline-block" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="cursor-help underline decoration-neutral-600 decoration-dotted underline-offset-2">{children}</span>
      {open && (
        <span className="absolute top-full left-0 z-50 mt-1 block w-96 max-w-[80vw] rounded-md border border-neutral-700 bg-neutral-900 p-2 text-left text-xs shadow-xl">
          <span className="mb-1 block text-[10px] tracking-wide text-neutral-400 uppercase">Factors behind this number</span>
          {keys.map((k) => {
            const f = factors[k]
            return (
              <span key={k} className="block border-t border-neutral-800 py-1 first:border-t-0">
                {f?.label && <span className="block font-medium text-neutral-100">{f.label}</span>}
                <span className="flex items-center gap-2">
                  <code className="text-neutral-400">{k}</code>
                  {f && !f.verified && (
                    <span className="rounded bg-amber-900/60 px-1 text-[10px] text-amber-300">unverified</span>
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
        </span>
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
