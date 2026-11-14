// The three recorded locales as posters in the style of aryanashta.me's work cards. Illustrations are thematic (what the
// locale is about), drawn with src/iso; every number on a poster comes from the locale record.
import { memo, type ReactNode } from 'react'
import { IsoBox, IsoFloors, IsoGhost, IsoTile, ISO, Poster, isoViewBox, type BoxGeom } from '../iso'
import type { Locale } from '../types'

const GREY = ISO.block

interface Scene {
  boxes: BoxGeom[]
  draw: ReactNode
  aria: string
}

// Houston: an office tower with its upper floors drawn as homes, beside the Main St light rail.
const HOUSTON: Scene = (() => {
  const floors = [...Array(6).fill(GREY), ...Array(9).fill('#bfe0cc')]
  const boxes = [{ x: 0, y: 0, w: 40, d: 40, h: 15 * 9 }, { x: -70, y: 62, w: 230, d: 10, h: 3 }]
  return {
    boxes,
    aria: 'Office tower with its upper floors converted to homes, next to a light rail line',
    draw: (
      <>
        <IsoBox x={-60} y={-40} w={34} d={30} h={22} color={GREY} />
        <IsoBox x={60} y={-30} w={30} d={24} h={34} color={GREY} />
        <IsoFloors x={0} y={0} w={40} d={40} floorH={9} colors={floors} title="Office floors below, homes above" />
        <IsoBox x={70} y={8} w={26} d={26} h={16} color={GREY} />
        {/* rail: track bed with sleepers as texture, a platform */}
        <IsoBox x={-70} y={62} w={230} d={10} h={2} color="#9aa7b4" />
        {Array.from({ length: 23 }, (_, i) => (
          <IsoBox key={i} x={-68 + i * 10} y={63} z={2} w={3} d={8} h={1} color={ISO.transit} stroke={false} shadow={false} />
        ))}
        <IsoBox x={20} y={76} w={60} d={10} h={5} color={ISO.mustard} />
      </>
    ),
  }
})()

// LA: two parcels on Wilshire, one new-build massing, one converted tower, the subway line beneath.
const LA: Scene = (() => {
  const tower = [...Array(5).fill(GREY), ...Array(8).fill(ISO.accentTint)]
  const boxes = [{ x: -10, y: -10, w: 150, d: 70, h: 13 * 8 }, { x: -40, y: 75, w: 210, d: 10, h: 2 }]
  return {
    boxes,
    aria: 'Two parcels: a new-build massing and a converted office tower, above a subway line',
    draw: (
      <>
        <IsoTile x={-10} y={-10} w={64} d={70} color="#e6ebef" stroke />
        <IsoTile x={66} y={-10} w={74} d={70} color="#e6ebef" stroke />
        <IsoBox x={0} y={0} w={44} d={50} h={42} color="#f3f5f7" title="New construction" />
        <IsoFloors x={80} y={6} w={44} d={44} floorH={8} colors={tower} title="Converted tower" />
        <IsoBox x={-40} y={75} w={210} d={10} h={2} color={ISO.transit} />
        <IsoBox x={60} y={64} w={12} d={8} h={8} color={ISO.mustard} title="Station entrance" />
      </>
    ),
  }
})()

// Brevard: low blocks on parcels, a flood-zone band, the planned station as a ghost.
const BREVARD: Scene = (() => {
  const lots = [0, 1, 2, 3].flatMap((i) => [0, 1, 2].map((j) => ({ x: i * 34, y: j * 34 })))
  const boxes = [{ x: -10, y: -10, w: 170, d: 150, h: 40 }]
  return {
    boxes,
    aria: 'Low buildings on parcels, a flood-zone band, and a dashed box for the planned rail station',
    draw: (
      <>
        {lots.map((l, k) => (
          <IsoTile key={k} x={l.x} y={l.y} w={30} d={30} color={ISO.paper} />
        ))}
        <IsoTile x={-10} y={104} w={150} d={26} h={0.6} color="#a9bfe7" title="FEMA flood zone" />
        {lots
          .filter((_, k) => k % 3 !== 2)
          .map((l, k) => (
            <IsoBox key={k} x={l.x + 6} y={l.y + 6} w={18} d={16} h={6 + (k % 3) * 3} color={ISO.mustard} />
          ))}
        <IsoGhost x={140} y={-6} w={26} d={60} h={34} title="Planned Brightline station" />
      </>
    ),
  }
})()

const STYLE: Record<string, { color: string; title: string[]; scene: Scene; ink?: boolean }> = {
  houston_downtown: { color: ISO.green, title: ['Houston', 'Main St rail'], scene: HOUSTON },
  la_wilshire_koreatown: { color: ISO.blue, title: ['Wilshire', 'Koreatown'], scene: LA },
  brevard_cocoa: { color: ISO.mustard, title: ['Cocoa,', 'Brevard'], scene: BREVARD, ink: true },
}

function stationsValue(l: Locale): string {
  const planned = l.stations.filter((s) => s.mode.endsWith('_planned')).length
  return planned === l.stations.length && planned > 0 ? `${planned} planned` : String(l.stations.length)
}

export const LocalePoster = memo(function LocalePoster({ locale, index }: { locale: Locale; index: number }) {
  const s = STYLE[locale.id] ?? { color: ISO.blue, title: [locale.name.split(':')[0]], scene: LA }
  const metrics = [
    { label: 'Stations', value: stationsValue(locale) },
    { label: 'Data', value: locale.data_tier === 'costar_full' ? 'CoStar' : 'Public' },
  ]
  return (
    <Poster
      color={s.color}
      ink={s.ink}
      number={`No. ${String(index + 1).padStart(2, '0')}`}
      year={String(new Date().getFullYear())}
      title={s.title}
      metrics={metrics}
      sceneViewBox={isoViewBox(s.scene.boxes, 18)}
      label={`${locale.name}. ${s.scene.aria}. ${metrics.map((m) => `${m.label}: ${m.value}`).join(', ')}`}
    >
      {s.scene.draw}
    </Poster>
  )
})
