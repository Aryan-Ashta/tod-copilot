import { useLayoutEffect, useRef } from 'react'
import { usePlan } from '../state/PlanContext'
import { LAYER_DEFS, LAYER_KEY, LAYER_SWATCH } from '../mapLayers'
import MapPanel from './MapPanel'

const GROUPS = ['Base', 'Infrastructure', 'Plan'] as const
/** What the panel must stay above: marked map UI (the targets strip, edit mode's bottom stack) and the map's zoom control. */
const FLOORS = '[data-map-floor], [data-map-floor-items] > *, .maplibregl-ctrl-bottom-left > *'
const GAP_PX = 12
/** MapPanel's body padding and border under the list. */
const BODY_BOTTOM_PX = 13

/**
 * Grows the layer list down to the first floor under the panel (or the map's bottom edge), so it only scrolls when
 * the screen is too short to show every layer without overlapping other map UI.
 */
function useFitAboveFloors() {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const panel = list?.closest('section')
    const box = panel?.parentElement
    if (!list || !panel || !box) return
    let frame = 0
    const observed = new Set<Element>()
    const resize = new ResizeObserver(() => schedule())
    const fit = () => {
      const p = panel.getBoundingClientRect()
      let floor = box.getBoundingClientRect().bottom
      for (const el of box.querySelectorAll(FLOORS)) {
        if (!observed.has(el)) {
          observed.add(el)
          resize.observe(el)
        }
        const r = el.getBoundingClientRect()
        if (r.height > 0 && r.top > p.top && r.left < p.right && r.right > p.left) floor = Math.min(floor, r.top)
      }
      list.style.maxHeight = `${Math.max(120, floor - GAP_PX - BODY_BOTTOM_PX - list.getBoundingClientRect().top)}px`
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    }
    resize.observe(box)
    // floors come and go (the zoom control mounts with the map, the tool hint with a tile)
    const mutations = new MutationObserver(schedule)
    mutations.observe(box, { childList: true, subtree: true })
    fit()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
    }
  }, [])
  return listRef
}

/** Map layer toggles: one switch row per layer, grouped; a layer's colour key shows under it while it is on. */
export default function LayerPanel() {
  const { state, dispatch } = usePlan()
  const listRef = useFitAboveFloors()
  const infra = state.plan.infrastructure
  const noUtilities = infra !== undefined && !infra.some((f) => f.kind === 'water_main' || f.kind === 'sewer_main' || f.kind === 'power_substation')
  const onCount = LAYER_DEFS.filter((d) => state.layers[d.key]).length
  return (
    <MapPanel title="Layers" right={<span className="text-[12px]">{onCount} on</span>} className="absolute top-3 left-3 z-10 w-72">
      <div ref={listRef} className="-mx-1.5 overflow-y-auto">
        {GROUPS.map((g) => (
          <div key={g} role="group" aria-labelledby={`layers-${g}`} className="pt-1.5 first:pt-0.5">
            <div id={`layers-${g}`} className="mb-0.5 px-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-slate uppercase">
              {g}
            </div>
            {LAYER_DEFS.filter((d) => d.group === g).map((d) => {
              const on = state.layers[d.key]
              const key = on ? LAYER_KEY[d.key] : undefined
              return (
                <button
                  key={d.key}
                  type="button"
                  role="switch"
                  aria-checked={on}
                  onClick={() => dispatch({ type: 'toggle_layer', key: d.key })}
                  className="flex w-full items-start gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors duration-150 hover:bg-ink/[0.04]"
                >
                  <span aria-hidden className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors duration-200 ${on ? 'bg-ink' : 'bg-ink/15'}`}>
                    <span
                      className={`absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-paper shadow-sm transition-transform duration-200 ${on ? 'translate-x-[12px]' : ''}`}
                    />
                  </span>
                  <span aria-hidden className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-ink/15 ring-inset" style={{ background: LAYER_SWATCH[d.key] }} />
                  <span className="min-w-0 flex-1">
                    <span className={`transition-colors duration-150 ${on ? 'text-ink' : 'text-slate'}`}>{d.label}</span>
                    {d.key === 'utilities' && noUtilities && <span className="ml-1.5 text-[11.5px] text-slate">· not public here</span>}
                    {key && (
                      <span className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11.5px] text-slate">
                        {key.map((k) => (
                          <span key={k.label} className="flex items-center gap-1">
                            <span aria-hidden className="h-1.5 w-1.5 rounded-full ring-1 ring-ink/10" style={{ background: k.color }} />
                            {k.label}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </MapPanel>
  )
}
