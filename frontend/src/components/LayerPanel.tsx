import { useState } from 'react'
import { usePlan } from '../state/PlanContext'
import { LAYER_DEFS, type LayerKey } from '../mapLayers'

const SWATCH: Partial<Record<LayerKey, string>> = {
  transit_existing: 'linear-gradient(90deg,#e63946 50%,#8c8c8c 50%)',
  walk_bike: 'linear-gradient(90deg,#737373 50%,#a3e635 50%)',
  utilities: 'repeating-linear-gradient(90deg,#3b82f6 0 3px,transparent 3px 5px)',
  amenities: 'linear-gradient(90deg,#22d3ee,#facc15,#f43f5e,#22c55e,#fb923c)',
  flood: 'rgba(37,99,235,0.5)',
  proposed_transit: 'linear-gradient(90deg,#14b8a6 50%,#a855f7 50%)',
  parcels: '#f59e0b',
  buildings: 'linear-gradient(90deg,#3b82f6,#a855f7,#14b8a6,#8c8c8c)',
  sites: '#ffffff',
  new_buildings: '#60a5fa',
}

export default function LayerPanel() {
  const { state, dispatch } = usePlan()
  const [open, setOpen] = useState(true)
  const infra = state.plan.infrastructure
  const noUtilities = infra !== undefined && !infra.some((f) => f.kind === 'water_main' || f.kind === 'sewer_main' || f.kind === 'power_substation')
  return (
    <div className="absolute top-3 left-3 z-10 w-72 rounded-md border border-neutral-800 bg-neutral-950/90 text-xs shadow-lg backdrop-blur">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 font-semibold">
        Layers <span className="text-neutral-500">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="max-h-[60vh] overflow-y-auto px-3 pb-3">
          {(['Base', 'Infrastructure', 'Plan'] as const).map((g) => (
            <div key={g} className="mb-2">
              <div className="mb-1 text-[10px] tracking-wide text-neutral-500 uppercase">{g}</div>
              {LAYER_DEFS.filter((d) => d.group === g).map((d) => (
                <label key={d.key} className="flex cursor-pointer items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    checked={state.layers[d.key]}
                    onChange={() => dispatch({ type: 'toggle_layer', key: d.key })}
                  />
                  {SWATCH[d.key] && <span className="h-2 w-4 rounded-sm" style={{ background: SWATCH[d.key] }} />}
                  <span className="text-neutral-200">{d.label}</span>
                  {d.key === 'utilities' && noUtilities && <span className="text-amber-400">not public here</span>}
                </label>
              ))}
            </div>
          ))}
          <div className="text-[10px] leading-snug text-neutral-500">
            Conversion colours: residential blue, hotel purple, mixed use teal, keep grey; opacity = overall score. Amber
            sidewalk lines = frontage mapped without sidewalk.
          </div>
        </div>
      )}
    </div>
  )
}
