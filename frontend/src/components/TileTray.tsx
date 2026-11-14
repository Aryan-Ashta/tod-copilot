import { memo } from 'react'
import { IsoBox, IsoGhost, IsoTile, ISO, isoViewBox } from '../iso'
import type { TileKind } from '../types'

export const TILE_MIME = 'application/x-tod-tile'

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

/** Drag a tile onto a parcel (Homes, Park, Stop) or a building (conversions). */
export default function TileTray({ disabled }: { disabled: boolean }) {
  return (
    <div className="flex border border-ink bg-paper" role="toolbar" aria-label="Tiles: drag onto the map">
      {TILES.map((t) => (
        <div
          key={t.kind}
          data-tile={t.kind}
          draggable={!disabled}
          tabIndex={-1}
          onDragStart={(e) => {
            e.dataTransfer.setData(TILE_MIME, t.kind)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          className={`flex cursor-grab items-center gap-2 border-l border-rule py-2 pr-5 pl-3 text-lg font-semibold select-none first:border-l-0 hover:bg-ink/[0.04] active:cursor-grabbing ${disabled ? 'opacity-40' : ''}`}
          title={`Drag onto a ${t.target}`}
        >
          <TileGlyph kind={t.kind} className="h-12 w-12" />
          {t.label}
        </div>
      ))}
    </div>
  )
}
