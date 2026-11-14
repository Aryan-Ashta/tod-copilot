import { usePlan } from '../state/PlanContext'
import { fmtNum } from '../format'
import TargetBars from './TargetBars'
import FactorHover from './FactorHover'

/** Bottom-right panel: target bars plus the homes ↔ green-space slider (sends Edit {kind: 'slider', value}). */
export default function TargetsPanel() {
  const { state, addEdit } = usePlan()
  const v = state.edits.find((e) => e.edit.kind === 'slider')?.edit.value ?? 0
  const sb = state.scoreboard
  const ready = !!state.basePlan
  return (
    <div className="absolute right-3 bottom-8 z-10 w-80 rounded-md border border-neutral-800 bg-neutral-950/90 p-3 text-xs shadow-lg backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold">Targets</span>
        {state.rescoring && <span className="text-neutral-500">updating…</span>}
      </div>
      <TargetBars compact />
      <div className="mt-3 border-t border-neutral-800 pt-2">
        <div className="mb-1 flex justify-between text-neutral-300">
          <span>Homes</span>
          <FactorHover keys={['slider_max_open_space_share']}>
            <span>Green space</span>
          </FactorHover>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={v}
          disabled={!ready}
          onChange={(e) => {
            const value = Number(e.target.value)
            addEdit({ kind: 'slider', value }, `Green-space slider at ${Math.round(value * 100)}%`)
          }}
          className="w-full accent-emerald-500"
        />
        {sb && (
          <div className="mt-1 flex justify-between tabular-nums text-neutral-400">
            <span>{fmtNum(sb.homes)} homes</span>
            <span>walk access {fmtNum(sb.walk_access_pct, 1)}%</span>
          </div>
        )}
        {state.rescoreError && <div className="mt-1 text-rose-400">Rescore failed: {state.rescoreError}</div>}
      </div>
    </div>
  )
}
