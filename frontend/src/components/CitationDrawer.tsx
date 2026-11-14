import { useEffect, useRef, useState } from 'react'
import { getCorpusDoc } from '../api'
import type { Citation, CorpusDoc } from '../types'

/**
 * Right-side drawer with the corpus excerpt; mounted per citation (keyed). URL fragments never reach the
 * server, so the section is scrolled into view client-side.
 */
export default function CitationDrawer({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const [doc, setDoc] = useState<CorpusDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    getCorpusDoc(citation.doc_id)
      .then((d) => alive && setDoc(d))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [citation.doc_id])

  useEffect(() => {
    if (!doc) return
    const el = bodyRef.current?.querySelector(`[data-section="${CSS.escape(citation.section)}"]`)
    el?.scrollIntoView({ block: 'start' })
  }, [doc, citation.section])

  return (
    <div className="fixed inset-0 z-[100] flex justify-end bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-[560px] max-w-full flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-neutral-800 p-4">
          <div>
            <div className="text-xs text-neutral-400">{citation.doc_id}</div>
            <div className="font-semibold">{doc?.title ?? 'Loading…'}</div>
            <div className="text-sm text-neutral-300">§ {citation.section}</div>
            {(doc?.url || citation.url) && (
              <a
                href={citation.url ?? doc?.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-sky-400 hover:underline"
              >
                Official source ↗
              </a>
            )}
          </div>
          <button onClick={onClose} className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-white">
            ✕
          </button>
        </header>
        <div className="border-b border-neutral-800 bg-neutral-900 p-4 text-sm">
          <div className="mb-1 text-[10px] tracking-wide text-neutral-400 uppercase">Cited text</div>
          <blockquote className="border-l-2 border-sky-500 pl-3 text-neutral-100">“{citation.quote}”</blockquote>
        </div>
        <div ref={bodyRef} className="flex-1 overflow-y-auto p-4 text-sm leading-relaxed">
          {error && <div className="text-rose-400">Could not load corpus document: {error}</div>}
          {doc?.sections.map((s) => {
            const active = s.section === citation.section
            return (
              <section
                key={s.section}
                data-section={s.section}
                className={`mb-4 rounded p-2 ${active ? 'bg-sky-950/60 ring-1 ring-sky-700' : ''}`}
              >
                <h3 className="mb-1 font-semibold text-neutral-200">§ {s.section}</h3>
                <p className="whitespace-pre-wrap text-neutral-300">
                  {active ? <Highlighted text={s.text} quote={citation.quote} /> : s.text}
                </p>
              </section>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

function Highlighted({ text, quote }: { text: string; quote: string }) {
  const i = quote ? text.indexOf(quote) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-sky-700/60 text-white">{quote}</mark>
      {text.slice(i + quote.length)}
    </>
  )
}
