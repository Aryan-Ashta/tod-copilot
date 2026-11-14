import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createPlan, getLocales } from '../api'
import Disclaimer from '../components/Disclaimer'
import type { Locale, LocaleId } from '../types'

export default function PromptScreen() {
  const navigate = useNavigate()
  const [locales, setLocales] = useState<Locale[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<LocaleId | null>(null)
  const [prompt, setPrompt] = useState('')
  const [replay, setReplay] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    getLocales()
      .then((ls) => {
        setLocales(ls)
        if (ls.length) setSelected((s) => s ?? ls[0].id)
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const submit = async () => {
    if (!selected) return
    if (replay) {
      navigate(`/plan/demo-${selected}?replay=1`)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const { plan_id } = await createPlan(selected, prompt.trim())
      navigate(`/plan/${plan_id}`)
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  const canSubmit = !!selected && !submitting && (replay || prompt.trim().length > 0)

  return (
    <div className="flex h-full flex-col">
      <Disclaimer />
      <div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-10">
        <h1 className="mb-1 text-3xl font-semibold tracking-tight">Plan transit and the homes around it</h1>
        <p className="mb-8 text-neutral-400">
          One prompt: existing transit and infrastructure, buildings that can be converted, land that can be built on, what
          the law allows, how to get the land and pay for it, and how the plan scores on carbon and health.
        </p>
        {error && <div className="mb-4 rounded border border-rose-900 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
          {!locales && !error && <p className="text-neutral-500">Loading locales…</p>}
          {locales?.map((l) => (
            <button
              key={l.id}
              onClick={() => setSelected(l.id)}
              className={`rounded-lg border p-4 text-left transition-colors ${
                selected === l.id ? 'border-sky-500 bg-sky-950/40' : 'border-neutral-800 bg-neutral-900 hover:border-neutral-600'
              }`}
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <span className="font-semibold">{l.name}</span>
                <span
                  className={`shrink-0 rounded px-1.5 py-px text-[11px] ${
                    l.data_tier === 'costar_full' ? 'bg-sky-900 text-sky-200' : 'bg-amber-900 text-amber-200'
                  }`}
                >
                  {l.data_tier === 'costar_full' ? 'CoStar full' : 'Public only'}
                </span>
              </div>
              <p className="text-sm text-neutral-400">{l.purpose}</p>
              <p className="mt-2 text-xs text-neutral-500">{l.transit_agency}</p>
            </button>
          ))}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="e.g. Plan transit-oriented development around the rail stations"
          className="mb-3 w-full rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-neutral-100 placeholder:text-neutral-600 focus:border-sky-600 focus:outline-none"
        />
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={replay} onChange={(e) => setReplay(e.target.checked)} />
            Replay recorded run
          </label>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="ml-auto rounded-lg bg-sky-600 px-6 py-2 font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {submitting ? 'Starting…' : 'Plan it'}
          </button>
        </div>
      </div>
    </div>
  )
}
