import type { TileKind } from '../types'

export const TILE_MIME = 'application/x-tod-tile'

export const TILES: { kind: TileKind; label: string; target: 'parcel' | 'building'; cls: string }[] = [
  { kind: 'homes', label: 'Homes', target: 'parcel', cls: 'bg-blue-600' },
  { kind: 'park', label: 'Park', target: 'parcel', cls: 'bg-green-600' },
  { kind: 'stop', label: 'Stop', target: 'parcel', cls: 'bg-teal-600' },
  { kind: 'convert_residential', label: 'Convert to housing', target: 'building', cls: 'bg-indigo-600' },
  { kind: 'convert_hotel', label: 'Convert to hotel', target: 'building', cls: 'bg-purple-600' },
]

export const tileInfo = (k: TileKind) => TILES.find((t) => t.kind === k)!

/** Drag a tile onto a parcel (Homes, Park, Stop) or a building (conversions). */
export default function TileTray({ disabled }: { disabled: boolean }) {
  return (
    <div className="flex gap-3 rounded-lg border border-neutral-800 bg-neutral-950/90 p-3 shadow-xl backdrop-blur">
      {TILES.map((t) => (
        <div
          key={t.kind}
          data-tile={t.kind}
          draggable={!disabled}
          onDragStart={(e) => {
            e.dataTransfer.setData(TILE_MIME, t.kind)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          className={`${t.cls} cursor-grab rounded-lg px-5 py-3 text-xl font-semibold text-white shadow select-none active:cursor-grabbing ${disabled ? 'opacity-40' : ''}`}
          title={`Drag onto a ${t.target}`}
        >
          {t.label}
        </div>
      ))}
    </div>
  )
}
