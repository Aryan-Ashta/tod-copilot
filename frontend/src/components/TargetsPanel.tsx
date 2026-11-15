import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { optimizeGreenSpace } from '../api'
import { fmtNum } from '../format'
import { usePlan } from '../state/PlanContext'
import TargetBars from './TargetBars'
import FactorHover from './FactorHover'
import MapPanel from './MapPanel'
import Slider from './Slider'
import type { GreenSpaceOptimum } from '../types'

function LeafIcon() {
  return (
    <svg viewBox="0 0 28 28" className="h-5 w-5 shrink-0" aria-hidden>
      <path d="M6 22C6 12 12 6 23 5c0 11-6 17-15 17z" fill="#9cc4b0" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 22c4-5 8-9 13-12" fill="none" stroke="var(--color-green)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

const OPTIMUM_WIDTH = 300
/** How long the optimizer's explanation stays up unless it is closed or the slider is moved. */
const OPTIMUM_MS = 14000

/** The optimizer's answer in words; every number is from the response. */
function optimumText(r: GreenSpaceOptimum): { head: string; detail: string } {
  const years = fmtNum(r.horizon_years)
  const saved = fmtNum(r.full_embodied_saved_tonnes)
  const lost = fmtNum(r.full_transport_lost_tonnes_per_year)
  if (r.full_embodied_saved_tonnes === 0 && r.full_transport_lost_tonnes_per_year === 0)
    return { head: 'Nothing to optimize yet', detail: 'Green space comes out of new buildings, and the plan has none.' }
  const head = `Best for carbon over ${years} years: ${Math.round(r.value * 100)}%`
  if (r.value === 0)
    return {
      head,
      detail: `At 100%, the homes left unbuilt would save ${saved} t of construction carbon once, but give up ${lost} t a year of avoided driving. That outweighs the saving after ${fmtNum(r.break_even_years, 1)} years.`,
    }
  const trade =
    r.break_even_years === null
      ? `At 100%, the homes left unbuilt save ${saved} t of construction carbon and give up no avoided driving.`
      : `At 100%, the homes left unbuilt save ${saved} t of construction carbon once and give up ${lost} t a year of avoided driving, which would take ${fmtNum(r.break_even_years, 1)} years to outweigh it.`
  return { head, detail: `That avoids ${fmtNum(r.net_co2_tonnes)} t more CO₂ than no green space. ${trade}` }
}

/**
 * The homes ↔ green-space slider as one compact row (sends Edit {kind: 'slider', value}); each step replaces the
 * last slider edit. Homes and walk access are in the stats, so only the share is shown. Also shows a failed rescore.
 * "Optimize" asks the server for the setting that avoids the most carbon over `carbon_horizon_years`, moves the slider
 * there and explains the trade in a note above the button (portalled, so no panel clips it or changes height).
 */
export function GreenSpaceSlider({ className = '' }: { className?: string }) {
  const { state, addEdit } = usePlan()
  const v = state.edits.find((e) => e.edit.kind === 'slider')?.edit.value ?? 0
  const pct = Math.round(v * 100)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ head: string; detail: string; factors: string[]; left: number; bottom: number } | null>(null)
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), OPTIMUM_MS)
    return () => clearTimeout(t)
  }, [note])

  const optimize = async (button: HTMLButtonElement) => {
    const r = button.getBoundingClientRect()
    const at = {
      left: Math.max(8, Math.min(r.left, window.innerWidth - OPTIMUM_WIDTH - 8)),
      bottom: window.innerHeight - r.top + 8,
    }
    setBusy(true)
    try {
      const best = await optimizeGreenSpace(state.planId, state.edits.map((e) => e.edit))
      if (best.value !== v) addEdit({ kind: 'slider', value: best.value }, null)
      setNote({ ...optimumText(best), factors: best.factor_keys, ...at })
    } catch (e) {
      setNote({ head: 'Could not optimize', detail: (e as Error).message, factors: [], ...at })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={className}>
      <div className="flex h-7 items-center gap-1.5 text-[13px]">
        <button
          type="button"
          onClick={(e) => void optimize(e.currentTarget)}
          disabled={!state.basePlan || busy}
          title="Set the green space that avoids the most carbon"
          className="shrink-0 rounded-full border border-ink/25 bg-white/70 px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ink disabled:cursor-default disabled:border-rule disabled:text-slate"
        >
          {busy ? 'Optimizing…' : 'Optimize'}
        </button>
        {note &&
          createPortal(
            <div
              role="status"
              style={{ position: 'fixed', left: note.left, bottom: note.bottom, width: OPTIMUM_WIDTH }}
              className="pop-in z-[150] rounded-xl border border-rule bg-paper p-3 text-[12.5px] leading-snug shadow-[0_8px_24px_rgb(28_34_48/.16)]"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-semibold">
                  <FactorHover keys={note.factors}>{note.head}</FactorHover>
                </span>
                <button type="button" onClick={() => setNote(null)} aria-label="Dismiss" className="-mt-0.5 shrink-0 px-1 text-slate hover:text-ink">
                  ✕
                </button>
              </div>
              <p className="mt-1 text-slate">{note.detail}</p>
            </div>,
            document.body,
          )}
        <LeafIcon />
        <FactorHover keys={['slider_max_open_space_share']}>
          <span className="font-semibold whitespace-nowrap">Green space</span>
        </FactorHover>
        <Slider
          className="min-w-0 flex-1"
          value={v}
          min={0}
          max={1}
          step={0.05}
          disabled={!state.basePlan}
          color="var(--color-green)"
          label="Homes versus green space"
          valueText={`${pct}% toward green space`}
          onChange={(value) => {
            setNote(null)
            addEdit({ kind: 'slider', value }, null)
          }}
        />
        <span className="min-w-[3.25rem] shrink-0 rounded-full bg-green/15 px-2 py-0.5 text-center text-[12px] font-semibold tabular-nums text-green">
          {pct}%
        </span>
      </div>
      {state.rescoreError && <div className="mt-0.5 text-[12px] leading-snug text-gap">Rescore failed: {state.rescoreError}</div>}
    </div>
  )
}

/** Strip along the bottom of the plan map: target bars side by side plus the homes ↔ green-space slider. Left offset clears the map's zoom control. */
export default function TargetsPanel() {
  const { state } = usePlan()
  return (
    <MapPanel
      title="Targets"
      defaultOpen
      right={
        <>
          <span className="hidden items-center gap-2.5 text-[11px] sm:flex">
            <span className="flex items-center gap-1">
              <span className="h-2 w-4 rounded-full bg-green" /> this plan
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-[2px] rounded-full bg-slate" /> existing
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 border-l-[1.5px] border-dashed border-ink" /> agents
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-0.5 bg-ink" /> target
            </span>
          </span>
          {state.rescoring && <span className="hint-in">updating…</span>}
        </>
      }
      className="absolute right-3 bottom-8 left-14 z-10"
      data-map-floor
    >
      <TargetBars row />
      <GreenSpaceSlider className="mt-2 border-t border-rule pt-1.5" />
    </MapPanel>
  )
}
