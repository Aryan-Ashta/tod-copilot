// Iso massing of one building, drawn only from its record: stories x story height, a square plate of the typical floor
// area, converted floors in the best-use colour, and the depth limit as a dashed plate on the roof. Missing inputs are
// drawn as ghosts labelled "missing"; nothing is invented.
import { memo } from 'react'
import { IsoFloors, IsoGhost, IsoLabel, IsoTile, ISO, isoViewBox } from '../../iso'
import type { Building, UseType } from '../../types'
import { fmtNum, humanize } from '../../format'

export const USE_HEX: Record<UseType, string> = {
  residential: ISO.blue,
  hotel: ISO.mustard,
  mixed_use: ISO.green,
  keep_current: '#c4c9c1',
}

/** Which floors change use, bottom first: mixed use keeps the ground floor commercial, keep changes none. */
function floorColors(n: number, use: UseType): string[] {
  return Array.from({ length: n }, (_, i) =>
    use === 'keep_current' || (use === 'mixed_use' && i === 0) ? ISO.block : USE_HEX[use],
  )
}

export const MassingFigure = memo(function MassingFigure({ b, use, storyFt, limitFt }: {
  b: Building
  use: UseType
  /** factor story_height_ft */
  storyFt: number | null
  /** factor reuse_max_floor_depth_ft_<use>; null for keep_current or while factors load */
  limitFt: number | null
}) {
  const stories = b.stories.value
  const plate = b.typical_floor_sqft.value
  const depth = b.floor_depth_ft.value
  const name = b.name.value || 'building'

  if (!stories || !plate || !storyFt) {
    const g = { x: 0, y: 0, w: 60, d: 60, h: 60 }
    const missing = [!stories && 'stories', !plate && 'typical floor', !storyFt && 'story height'].filter(Boolean).join(', ')
    return (
      <svg viewBox={isoViewBox([g], 20)} className="mx-auto block h-56 w-auto" role="img" aria-label={`${name}: ${missing} missing`}>
        <IsoGhost {...g} label={`${missing} missing`} labelSize={7} />
      </svg>
    )
  }

  const side = Math.sqrt(plate) // ft; plate drawn as a square of the same area
  const H = stories * storyFt
  // Along one axis: window at 0, the depth limit at L, the core edge at D (floor depth = core to window). Floor area
  // between L and D is farther than L from any window: drawn on the roof as a red ring between the L-square (dashed)
  // and the core.
  const lim = depth !== null && limitFt !== null ? Math.max(0, side - 2 * limitFt) : null
  const core = depth !== null ? Math.max(0, side - 2 * depth) : null
  const tooDeep = depth !== null && limitFt !== null && depth > limitFt
  const roof = H + 0.4
  const top = H + storyFt * 4
  const boxes = [{ x: 0, y: 0, w: side, d: side, h: top }]
  const vb = isoViewBox(boxes, side * 0.25)
  const vbH = Number(vb.split(' ')[3])
  const sw = vbH / 260
  const fs = vbH * 0.045
  const label =
    `${name}: ${stories} stories, ${fmtNum(plate)} sq ft floor plate, ${humanize(use)} on ` +
    `${floorColors(stories, use).filter((c) => c !== ISO.block).length} floors` +
    (depth !== null && limitFt !== null ? `; floor depth ${fmtNum(depth)} ft against a ${fmtNum(limitFt)} ft limit` : '; floor depth missing')
  const o = (s: number) => (side - s) / 2

  return (
    <svg viewBox={vb} className="mx-auto block h-72 w-auto max-w-full" role="img" aria-label={label}>
      <IsoFloors x={0} y={0} w={side} d={side} floorH={storyFt} colors={floorColors(stories, use)} sw={sw} title={label} />
      {lim !== null && core !== null ? (
        <>
          {tooDeep && lim > 0 && (
            <IsoTile x={o(lim)} y={o(lim)} z={roof} w={lim} d={lim} h={0.4} color={ISO.gap} title="Floor area beyond the depth limit" />
          )}
          {core > 0 && <IsoTile x={o(core)} y={o(core)} z={roof + 0.4} w={core} d={core} h={0.4} color={ISO.block} title="Core" />}
          {lim > 0 && (
            <IsoGhost x={o(lim)} y={o(lim)} z={roof} w={lim} d={lim} h={storyFt * 1.5} sw={sw * 1.4}
              color={tooDeep ? ISO.gap : ISO.ink} title={`${fmtNum(limitFt!)} ft from a window`} />
          )}
          <IsoLabel at={[0, 0, top]} size={fs} anchor="middle" fill={tooDeep ? ISO.gap : ISO.ink} weight={600}>
            {`${fmtNum(depth!)} ft deep · ${fmtNum(limitFt!)} ft limit`}
          </IsoLabel>
        </>
      ) : depth === null ? (
        <IsoGhost x={0} y={0} z={H} w={side} d={side} h={storyFt * 2} sw={sw} label="floor depth missing" labelSize={fs} />
      ) : (
        <IsoLabel at={[0, 0, top]} size={fs} anchor="middle">
          {`${fmtNum(depth)} ft deep${use === 'keep_current' ? ' · kept as is' : ''}`}
        </IsoLabel>
      )}
    </svg>
  )
})
