import { usePlan } from '../state/PlanContext'
import { fmtNum } from '../format'
import TargetBars from './TargetBars'
import FactorHover from './FactorHover'
import MapPanel from './MapPanel'

/**
 * Strip along the bottom of the plan map: target bars side by side plus the homes ↔ green-space slider
 * (sends Edit {kind: 'slider', value}). Left offset clears the map's zoom control.
 */
export default function TargetsPanel() {
  const { state, addEdit } = usePlan()
  const v = state.edits.find((e) => e.edit.kind === 'slider')?.edit.value ?? 0
  const sb = state.scoreboard
  const ready = !!state.basePlan
  return (
    <MapPanel
      title="Targets"
      defaultOpen
      right={state.rescoring ? <span>updating…</span> : null}
      className="absolute right-3 bottom-8 left-14 z-10"
    >
      <TargetBars row />
      <div className="mt-2 flex items-center gap-3 border-t border-rule pt-2 text-xs">
        <span>Homes</span>
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
          className="min-w-0 flex-1"
          aria-label="Homes versus green space"
        />
        <FactorHover keys={['slider_max_open_space_share']}>
          <span>Green space</span>
        </FactorHover>
        {sb && (
          <span className="ml-3 tabular-nums text-slate">
            {fmtNum(sb.homes)} homes · walk access {fmtNum(sb.walk_access_pct, 1)}%
          </span>
        )}
      </div>
      {state.rescoreError && <div className="mt-1 text-xs text-gap">Rescore failed: {state.rescoreError}</div>}
    </MapPanel>
  )
}
