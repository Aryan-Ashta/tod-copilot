import { usePlan } from '../state/PlanContext'
import { fmtNum } from '../format'
import TargetBars from './TargetBars'
import FactorHover from './FactorHover'
import MapPanel from './MapPanel'
import Slider from './Slider'

/** The homes ↔ green-space slider (sends Edit {kind: 'slider', value}); each step replaces the last slider edit. */
export function GreenSpaceSlider() {
  const { state, addEdit } = usePlan()
  const v = state.edits.find((e) => e.edit.kind === 'slider')?.edit.value ?? 0
  const sb = state.scoreboard
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span>Homes</span>
        <span className="tabular-nums text-slate">{Math.round(v * 100)}% to green space</span>
        <FactorHover keys={['slider_max_open_space_share']}>
          <span>Green space</span>
        </FactorHover>
      </div>
      <Slider
        value={v}
        min={0}
        max={1}
        step={0.05}
        disabled={!state.basePlan}
        color="var(--color-green)"
        label="Homes versus green space"
        valueText={`${Math.round(v * 100)}% toward green space`}
        onChange={(value) => addEdit({ kind: 'slider', value }, `Green-space slider at ${Math.round(value * 100)}%`)}
      />
      {sb && (
        <div className="mt-1 flex justify-between text-xs tabular-nums text-slate">
          <span>{fmtNum(sb.homes)} homes</span>
          <span>walk access {fmtNum(sb.walk_access_pct, 1)}%</span>
        </div>
      )}
      {state.rescoreError && <div className="mt-1 text-gap">Rescore failed: {state.rescoreError}</div>}
    </div>
  )
}

/** Bottom-right panel: target bars plus the homes ↔ green-space slider. */
export default function TargetsPanel() {
  const { state } = usePlan()
  return (
    <MapPanel
      title="Targets"
      defaultOpen
      right={state.rescoring ? <span>updating…</span> : null}
      className="absolute right-3 bottom-8 z-10 w-80"
    >
      <TargetBars compact />
      <div className="mt-2 border-t border-rule pt-2">
        <GreenSpaceSlider />
      </div>
    </MapPanel>
  )
}
