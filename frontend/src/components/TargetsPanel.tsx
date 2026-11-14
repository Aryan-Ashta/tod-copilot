import { usePlan } from '../state/PlanContext'
import { fmtNum } from '../format'
import TargetBars from './TargetBars'
import FactorHover from './FactorHover'
import MapPanel from './MapPanel'

/** Bottom-right panel: target bars plus the homes ↔ green-space slider (sends Edit {kind: 'slider', value}). */
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
      className="absolute right-3 bottom-8 z-10 w-80"
    >
      <TargetBars compact />
      <div className="mt-2 border-t border-rule pt-2">
        <div className="mb-1 flex justify-between text-xs">
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
          className="w-full"
          aria-label="Homes versus green space"
        />
        {sb && (
          <div className="mt-1 flex justify-between text-xs tabular-nums text-slate">
            <span>{fmtNum(sb.homes)} homes</span>
            <span>walk access {fmtNum(sb.walk_access_pct, 1)}%</span>
          </div>
        )}
        {state.rescoreError && <div className="mt-1 text-gap">Rescore failed: {state.rescoreError}</div>}
      </div>
    </MapPanel>
  )
}
