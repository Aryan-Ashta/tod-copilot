import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getFactors } from '../api'
import type { Citation, Factor } from '../types'
import CitationDrawer from '../components/CitationDrawer'

interface AppCtx {
  /** Factors from /api/factors keyed by factor key; empty until loaded. */
  factors: Record<string, Factor>
  factorsError: string | null
  /** Numeric factor value (per-locale mappings resolved with `localeId`), or null if not loaded / not a number. */
  factorNumber: (key: string, localeId?: string) => number | null
  openCitation: (c: Citation) => void
}

const Ctx = createContext<AppCtx | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [factors, setFactors] = useState<Record<string, Factor>>({})
  const [factorsError, setFactorsError] = useState<string | null>(null)
  const [citation, setCitation] = useState<Citation | null>(null)

  useEffect(() => {
    getFactors()
      .then((list) => setFactors(Object.fromEntries(list.map((f) => [f.key, f]))))
      .catch((e: Error) => setFactorsError(e.message))
  }, [])

  const factorNumber = useCallback(
    (key: string, localeId?: string) => {
      let v = factors[key]?.value
      if (localeId && v && typeof v === 'object' && !Array.isArray(v) && localeId in v) {
        v = (v as Record<string, unknown>)[localeId]
      }
      return typeof v === 'number' ? v : null
    },
    [factors],
  )

  const value = useMemo<AppCtx>(
    () => ({ factors, factorsError, factorNumber, openCitation: setCitation }),
    [factors, factorsError, factorNumber],
  )

  return (
    <Ctx.Provider value={value}>
      {children}
      {citation && (
        <CitationDrawer
          key={`${citation.doc_id}§${citation.section}`}
          citation={citation}
          onClose={() => setCitation(null)}
        />
      )}
    </Ctx.Provider>
  )
}

export function useApp(): AppCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useApp outside AppProvider')
  return c
}
