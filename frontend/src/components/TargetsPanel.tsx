import { usePlan } from '../state/PlanContext'
import TargetBars from './TargetBars'
import FactorHover from './FactorHover'
import MapPanel from './MapPanel'
import Slider from './Slider'

function LeafIcon() {
  return (
    <svg viewBox="0 0 28 28" className="h-5 w-5 shrink-0" aria-hidden>
      <path d="M6 22C6 12 12 6 23 5c0 11-6 17-15 17z" fill="#9cc4b0" stroke="var(--color-ink)" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 22c4-5 8-9 13-12" fill="none" stroke="var(--color-green)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The homes ↔ green-space slider as one compact row (sends Edit {kind: 'slider', value}); each step replaces the
 * last slider edit. Homes and walk access are in the stats, so only the share is shown. Also shows a failed rescore.
 */
export function GreenSpaceSlider({ className = '' }: { className?: string }) {
  const { state, addEdit } = usePlan()
  const v = state.edits.find((e) => e.edit.kind === 'slider')?.edit.value ?? 0
  const pct = Math.round(v * 100)
  return (
    <div className={className}>
      <div className="flex h-7 items-center gap-1.5 text-[13px]">
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
          onChange={(value) => addEdit({ kind: 'slider', value }, null)}
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
