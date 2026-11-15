import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { getLetter } from '../api'
import { humanize } from '../format'
import { usePlan } from '../state/PlanContext'
import { CiteList } from './cards/common'
import type { LetterDraft as Letter, LetterKind } from '../types'

// Display only: the letter, its numbers and its citations come from backend/models/letters.py.

const PAPER: CSSProperties = {
  backgroundColor: '#fbfaf5',
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .11 0 0 0 0 .13 0 0 0 0 .19 0 0 0 .07 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\"), linear-gradient(180deg, rgba(28,34,48,.025), rgba(28,34,48,0) 40%)",
  boxShadow: '3px 3px 0 var(--color-ink)',
}
const SERIF: CSSProperties = { fontFamily: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif' }
const BTN = 'ctl inline-flex items-center gap-1.5 px-3 py-1 text-[13px]'

function EnvelopeIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" className="shrink-0">
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 5.5l7 5.5 7-5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

function fmtFigure(key: string, v: number): string {
  return key.endsWith('_usd')
    ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const plainText = (l: Letter) => `To: ${l.to}\nSubject: ${l.subject}\n\n${l.body}\n`

/** "Draft letter" button that opens an inline letter sheet filled from the stored plan. */
export default function LetterDraft({ kind, targetId, label = 'Draft letter' }: { kind: LetterKind; targetId: string; label?: string }) {
  const { planId } = usePlan().state
  const reqKey = `${planId}|${kind}|${targetId}`
  const [data, setData] = useState<{ key: string; letter: Letter } | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const latest = useRef(reqKey)
  useEffect(() => {
    latest.current = reqKey
  }, [reqKey])
  const sheet = useRef<HTMLDivElement>(null)

  const letter = data?.key === reqKey ? data.letter : null
  const isOpen = open && letter !== null

  const toggle = async () => {
    setError(null)
    if (isOpen) return setOpen(false)
    if (letter) return setOpen(true)
    setLoading(true)
    try {
      const l = await getLetter(planId, kind, targetId)
      if (latest.current !== reqKey) return
      setData({ key: reqKey, letter: l })
      setOpen(true)
    } catch (e) {
      if (latest.current === reqKey) setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const copy = async () => {
    if (!letter) return
    try {
      await navigator.clipboard.writeText(plainText(letter))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Copy failed: the browser blocked clipboard access.')
    }
  }

  const download = () => {
    if (!letter) return
    const url = URL.createObjectURL(new Blob([plainText(letter)], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${letter.kind.replace(/_/g, '-')}-${letter.target_id.replace(/[^\w.-]+/g, '_')}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const figures = letter ? Object.entries(letter.figures) : []

  return (
    <div className="mt-2">
      <button type="button" onClick={toggle} disabled={loading} aria-expanded={isOpen} className={BTN}>
        <EnvelopeIcon />
        {loading ? 'Drafting…' : isOpen ? 'Hide letter' : label}
      </button>
      {error && <p className="mt-1 text-xs text-gap">{error}</p>}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
        onTransitionEnd={(e) => {
          if (e.target === e.currentTarget && isOpen) sheet.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }}
      >
        <div className="min-h-0 overflow-hidden" inert={!isOpen} aria-hidden={!isOpen}>
          {letter && (
            <div ref={sheet} className="mt-3 mr-1 mb-1 rounded-sm border-[1.5px] border-ink px-5 pt-4 pb-4 text-ink" style={PAPER}>
              {letter.refusal ? (
                <>
                  <p className="border-l-2 border-rule pl-3 text-[14px] leading-relaxed text-slate" style={SERIF}>
                    <span className="font-semibold text-ink">No letter here. </span>
                    {letter.refusal}
                  </p>
                  <div className="mt-3 flex justify-end">
                    <button type="button" className={BTN} onClick={() => setOpen(false)}>
                      Close
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="mb-3 flex items-start justify-between gap-3 border-b border-rule pb-2">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
                      <dt className="text-[11px] font-semibold tracking-wider text-slate uppercase">To</dt>
                      <dd className="font-medium">{letter.to}</dd>
                      <dt className="text-[11px] font-semibold tracking-wider text-slate uppercase">Subject</dt>
                      <dd className="font-medium">{letter.subject}</dd>
                    </dl>
                    <span
                      className="shrink-0 rotate-3 rounded-sm border-[1.5px] border-gap px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-gap uppercase"
                      title="Filled from the plan's numbers and the legal corpus; nothing has been sent"
                    >
                      Draft
                    </span>
                  </div>
                  <div className="max-w-[68ch] text-[14.5px] leading-[1.65] whitespace-pre-wrap [overflow-wrap:anywhere]" style={SERIF}>
                    {letter.body}
                  </div>
                  {letter.citations.length > 0 && (
                    <div className="mt-3 border-t border-rule pt-2">
                      <CiteList citations={letter.citations} label="Cites" />
                    </div>
                  )}
                  {figures.length > 0 && (
                    <div className="mt-3 border-t border-rule pt-2 text-xs">
                      <div className="mb-1 text-slate">Every number in this letter, from the plan:</div>
                      <ul className="flex flex-wrap gap-1.5">
                        {figures.map(([k, v]) => (
                          <li key={k} title={k} className="rounded-sm border border-rule bg-paper/60 px-1.5 py-0.5">
                            <span className="text-slate">{humanize(k.replace(/^allows\./, ''))}</span>{' '}
                            <span className="font-semibold tabular-nums">{fmtFigure(k, v)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button type="button" className={BTN} onClick={copy}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button type="button" className={BTN} onClick={download}>
                      Download .txt
                    </button>
                    <a
                      className={BTN}
                      href={`mailto:?subject=${encodeURIComponent(letter.subject)}&body=${encodeURIComponent(letter.body)}`}
                    >
                      Email
                    </a>
                    <button type="button" className={`${BTN} ml-auto`} onClick={() => setOpen(false)}>
                      Close
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
