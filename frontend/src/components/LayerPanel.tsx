import { usePlan } from '../state/PlanContext'
import { LAYER_DEFS, LAYER_SWATCH } from '../mapLayers'
import MapPanel from './MapPanel'

export default function LayerPanel() {
  const { state, dispatch } = usePlan()
  const infra = state.plan.infrastructure
  const noUtilities = infra !== undefined && !infra.some((f) => f.kind === 'water_main' || f.kind === 'sewer_main' || f.kind === 'power_substation')
  return (
    <MapPanel title="Layers" className="absolute top-3 left-3 z-10 w-72">
      <div className="max-h-[60vh] overflow-y-auto">
        {(['Base', 'Infrastructure', 'Plan'] as const).map((g) => (
          <fieldset key={g} className="mb-2">
            <legend className="mb-0.5 text-xs text-slate">{g}</legend>
            {LAYER_DEFS.filter((d) => d.group === g).map((d) => (
              <label key={d.key} className="flex cursor-pointer items-center gap-2 py-0.5">
                <input type="checkbox" checked={state.layers[d.key]} onChange={() => dispatch({ type: 'toggle_layer', key: d.key })} />
                {LAYER_SWATCH[d.key] && <span className="h-2 w-4 border border-ink/20" style={{ background: LAYER_SWATCH[d.key] }} />}
                <span>{d.label}</span>
                {d.key === 'utilities' && noUtilities && <span className="text-amber-300">not public here</span>}
              </label>
            ))}
          </fieldset>
        ))}
        <p className="text-xs text-slate">
          Conversion colours: residential blue, hotel purple, mixed use teal, keep grey; opacity = overall score. Amber
          sidewalk lines = frontage mapped without sidewalk.
        </p>
      </div>
    </MapPanel>
  )
}
