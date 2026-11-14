// The legal paths for one parcel as iso massings on the same lot, side by side and on one scale: the recommended path
// solid in the accent colour, the others as dashed ghosts. A new-construction path is drawn as the floor area its
// FAR allows spread up to its height limit; an adaptive-reuse path as the existing building it keeps. Anything the
// record lacks (no limit in the corpus, no building on record, not eligible) is a ghost with that label.
import { memo } from 'react'
import { IsoBox, IsoGhost, IsoLabel, IsoTile, ISO, isoViewBox, type BoxGeom } from '../../iso'
import { fmtNum } from '../../format'
import type { Building, LegalPath, Parcel, ZoningEnvelope } from '../../types'

const SQFT_PER_ACRE = 43_560 // unit conversion

interface Mass {
  box: BoxGeom | null
  caption: string
}

function massFor(p: LegalPath, lotSide: number, building: Building | undefined, storyFt: number | null): Mass {
  if (p.eligible !== true) return { box: null, caption: p.eligible === false ? 'not eligible' : 'not covered' }
  const h = typeof p.allows.max_height_ft === 'number' ? p.allows.max_height_ft : null
  const far = typeof p.allows.max_far === 'number' ? p.allows.max_far : null
  if (h !== null && far !== null && storyFt) {
    const floors = Math.max(1, Math.floor(h / storyFt))
    const cover = Math.min(1, far / floors) // share of the lot one floor covers when the FAR is spread to the height limit
    const side = lotSide * Math.sqrt(cover)
    const o = (lotSide - side) / 2
    return { box: { x: o, y: o, w: side, d: side, h }, caption: `${fmtNum(h)} ft · FAR ${fmtNum(far, 2)}` }
  }
  const stories = building?.stories.value
  const plate = building?.typical_floor_sqft.value
  if (/reuse/i.test(p.name)) {
    if (!stories || !plate || !storyFt) return { box: null, caption: 'no building on record' }
    const side = Math.min(lotSide, Math.sqrt(plate))
    const o = (lotSide - side) / 2
    return { box: { x: o, y: o, w: side, d: side, h: stories * storyFt }, caption: `existing ${stories} stories kept` }
  }
  return { box: null, caption: h === null ? 'no height or FAR limit in the corpus' : `${fmtNum(h)} ft, FAR not in the corpus` }
}

export const EnvelopeFigures = memo(function EnvelopeFigures({ env, parcel, building, storyFt }: {
  env: ZoningEnvelope
  parcel: Parcel | undefined
  building: Building | undefined
  storyFt: number | null
}) {
  const acres = parcel?.area_acres.value
  if (!acres) return null
  const lot = Math.sqrt(acres * SQFT_PER_ACRE)
  const masses = env.paths.map((p) => massFor(p, lot, building, storyFt))
  const tallest = Math.max(lot * 0.6, ...masses.map((m) => m.box?.h ?? 0))
  const vb = isoViewBox([{ x: 0, y: 0, w: lot, d: lot, h: tallest }], lot * 0.18)
  const fs = Number(vb.split(' ')[3]) * 0.05
  const sw = Number(vb.split(' ')[3]) / 220
  return (
    <div className={`grid gap-3 ${env.paths.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
      {env.paths.map((p, i) => {
        const m = masses[i]
        const win = env.recommended_path === p.name
        const ghostH = m.box?.h ?? tallest * 0.5
        return (
          <figure key={p.name} className={`rounded-xl border p-2 ${win ? 'border-ink' : 'border-rule'}`}>
            <svg viewBox={vb} className="block h-auto w-full" role="img" aria-label={`${p.name}: ${m.caption}${win ? ', recommended' : ''}`}>
              <IsoTile x={0} y={0} w={lot} d={lot} color={ISO.block} stroke sw={sw} title={`Lot ${fmtNum(acres, 2)} acres`} />
              {m.box && win ? (
                <IsoBox {...m.box} z={1.5} color={ISO.blue} sw={sw} />
              ) : (
                <IsoGhost {...(m.box ?? { x: lot * 0.2, y: lot * 0.2, w: lot * 0.6, d: lot * 0.6, h: ghostH })} z={1.5} sw={sw} />
              )}
              <IsoLabel at={[0, 0, ghostH + 4]} size={fs} anchor="middle" weight={win ? 700 : 400}>
                {m.caption}
              </IsoLabel>
            </svg>
            <figcaption className="mt-1 text-[13px]">
              <span className={win ? 'font-semibold' : 'text-slate'}>{p.name}</span>
              {p.homes != null && <span className="tnum text-slate"> · {fmtNum(p.homes)} homes</span>}
            </figcaption>
          </figure>
        )
      })}
    </div>
  )
})
