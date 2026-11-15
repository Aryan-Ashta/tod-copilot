import { memo, useEffect, useRef } from 'react'
import { REDUCED_MOTION } from '../construction'
import { IsoBox, IsoGhost, IsoTile, ISO, isoViewBox } from '../iso'
import { usePlan } from '../state/PlanContext'
import type { TileKind } from '../types'

export const TILES: { kind: TileKind; label: string; target: 'parcel' | 'building' }[] = [
  { kind: 'homes', label: 'Homes', target: 'parcel' },
  { kind: 'park', label: 'Park', target: 'parcel' },
  { kind: 'stop', label: 'Stop', target: 'parcel' },
  { kind: 'convert_residential', label: 'Convert to housing', target: 'building' },
  { kind: 'convert_hotel', label: 'Convert to hotel', target: 'building' },
]

export const tileInfo = (k: TileKind) => TILES.find((t) => t.kind === k)!

const VB = isoViewBox([{ x: 0, y: 0, w: 20, d: 20, h: 24 }], 2)

/**
 * One iso block per tile on a 20×20 lot: new homes a blue block, a park a green lot with a tree, a stop a teal
 * shelter by the kerb, a conversion an existing grey block whose upper floors take the new use's colour.
 * `ghost` draws the same massing dashed, for the drag preview.
 */
export const TileGlyph = memo(function TileGlyph({ kind, ghost = false, className }: { kind: TileKind; ghost?: boolean; className?: string }) {
  const parts: { x: number; y: number; z?: number; w: number; d: number; h: number; color: string }[] =
    kind === 'homes'
      ? [{ x: 4, y: 4, w: 12, d: 12, h: 20, color: ISO.blue }]
      : kind === 'park'
        ? [
            { x: 9, y: 9, w: 2, d: 2, h: 6, color: '#8a6a4a' },
            { x: 6, y: 6, z: 6, w: 8, d: 8, h: 8, color: ISO.green },
          ]
        : kind === 'stop'
          ? [
              { x: 3, y: 12, w: 12, d: 4, h: 1, color: ISO.block },
              { x: 4, y: 13, z: 1, w: 1, d: 1, h: 8, color: ISO.ink },
              { x: 3, y: 12, z: 9, w: 12, d: 4, h: 1.5, color: ISO.transit },
            ]
          : [
              { x: 4, y: 4, w: 12, d: 12, h: 8, color: '#c4c9c1' },
              { x: 4, y: 4, z: 8, w: 12, d: 12, h: 12, color: kind === 'convert_hotel' ? ISO.mustard : ISO.blue },
            ]
  return (
    <svg viewBox={VB} className={className} aria-hidden>
      <IsoTile x={0} y={0} w={20} d={20} color={kind === 'park' ? '#cfe0d2' : ISO.blockLight} stroke={!ghost} sw={0.5} />
      {parts.map((p, i) =>
        ghost ? (
          <IsoGhost key={i} {...p} sw={0.6} />
        ) : (
          <IsoBox key={i} {...p} sw={0.5} shadow={i === 0 && kind !== 'stop'} />
        ),
      )}
    </svg>
  )
})

/** Click a tile to arm it, then click a highlighted parcel (Homes, Park, Stop) or building (conversions) on the map. */
export default function TileTray() {
  const { state, dispatch } = usePlan()
  const armed = state.tool
  const disabled = !state.basePlan
  const glyphs = useRef(new Map<TileKind, HTMLSpanElement>())

  // Esc anywhere disarms.
  useEffect(() => {
    if (!armed) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'tool', tool: null })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [armed, dispatch])

  // The armed tile's glyph does a small springy hop.
  useEffect(() => {
    if (!armed || REDUCED_MOTION) return
    glyphs.current.get(armed)?.animate(
      [
        { transform: 'translateY(0) scale(1)' },
        { transform: 'translateY(-7px) scale(1.06, 0.96)', offset: 0.4 },
        { transform: 'translateY(1px) scale(1.04, 0.95)', offset: 0.75 },
        { transform: 'translateY(0) scale(1)' },
      ],
      { duration: 420, easing: 'cubic-bezier(0.34, 1.4, 0.5, 1)' },
    )
  }, [armed])

  return (
    <div
      data-hint-anchor="tray"
      className="flex rounded-[12px] border-[1.5px] border-ink bg-paper shadow-[1.5px_1.5px_0_var(--color-ink),0_8px_24px_rgb(28_34_48/.12)]"
      role="toolbar"
      aria-label="Tiles: click one, then click a highlighted lot or building"
    >
      {TILES.map((t) => {
        const on = armed === t.kind
        const dim = !!armed && !on
        return (
          <button
            key={t.kind}
            type="button"
            data-tile={t.kind}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => dispatch({ type: 'tool', tool: on ? null : t.kind })}
            title={
              disabled
                ? 'Tiles unlock once the plan has loaded'
                : on
                  ? 'Click again or press Esc to cancel'
                  : `Click, then click a highlighted ${t.target === 'building' ? 'building' : 'lot'}`
            }
            className={`group relative flex items-center gap-1.5 border-l border-rule py-1 pr-3.5 pl-2 text-[15px] font-semibold select-none first:rounded-l-[11px] first:border-l-0 last:rounded-r-[11px] transition-[translate,opacity,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.34,1.4,0.5,1)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue motion-reduce:transition-none ${
              disabled
                ? 'cursor-not-allowed opacity-40'
                : on
                  ? 'z-10 -translate-y-1.5 rounded-[10px] bg-white shadow-[0_0_0_2px_var(--color-ink),2px_3px_0_var(--color-ink)]'
                  : `cursor-pointer hover:bg-ink/[0.04] ${dim ? 'opacity-55 hover:opacity-90' : ''}`
            }`}
          >
            <span
              ref={(el) => {
                if (el) glyphs.current.set(t.kind, el)
                else glyphs.current.delete(t.kind)
              }}
              className="block origin-bottom"
            >
              <TileGlyph
                kind={t.kind}
                className={`block h-9 w-9 transition-[translate] duration-150 ${on || disabled ? '' : 'group-hover:-translate-y-0.5'}`}
              />
            </span>
            {t.label}
            <span
              aria-hidden
              className={`absolute inset-x-2.5 bottom-0.5 h-[2.5px] rounded-full bg-ink transition-transform duration-200 motion-reduce:transition-none ${on ? 'scale-x-100' : 'scale-x-0'}`}
            />
          </button>
        )
      })}
    </div>
  )
}
