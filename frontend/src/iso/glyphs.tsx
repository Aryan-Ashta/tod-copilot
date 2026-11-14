// Tiny iso glyph per agent for the checklist. Colour carries status: grey pending, blue running, green done, red error.
import { memo, type ReactNode } from 'react'
import type { AgentName } from '../types'
import { IsoBox, IsoGhost, IsoTile, isoViewBox } from './kit'
import { ISO } from './shade'

const VB = isoViewBox([{ x: 0, y: 0, w: 24, d: 24, h: 20 }], 2)

function draw(agent: AgentName, c: string): ReactNode {
  const sw = 0.8
  switch (agent) {
    case 'infrastructure': // a street tile with a utility main along it
      return (
        <>
          <IsoTile x={0} y={0} w={24} d={24} color={ISO.block} stroke sw={sw} />
          <IsoBox x={0} y={10} z={1.5} w={24} d={4} h={2} color={c} sw={sw} shadow={false} />
        </>
      )
    case 'transit_network': // rail line with a station block
      return (
        <>
          <IsoBox x={0} y={9} w={24} d={5} h={2} color={c} sw={sw} />
          <IsoBox x={8} y={15} w={8} d={6} h={6} color={ISO.block} sw={sw} />
        </>
      )
    case 'zoning_legislation': // parcel with its legal envelope as a ghost
      return (
        <>
          <IsoTile x={2} y={2} w={20} d={20} color={c} stroke sw={sw} />
          <IsoGhost x={4} y={4} w={16} d={16} h={16} sw={sw} />
        </>
      )
    case 'site': // underused parcel tiles
      return (
        <>
          <IsoTile x={0} y={0} w={11} d={24} color={ISO.block} stroke sw={sw} />
          <IsoTile x={13} y={0} w={11} d={24} color={c} stroke sw={sw} />
        </>
      )
    case 'building_reuse': // stacked floors
      return [0, 1, 2, 3].map((i) => (
        <IsoBox key={i} x={5} y={5} z={i * 4.5} w={14} d={14} h={4} color={i >= 2 ? c : ISO.block} sw={sw} shadow={i === 0} />
      ))
    case 'land_deal': // two parcels joined into one site
      return (
        <>
          <IsoTile x={0} y={2} w={12} d={20} color={c} stroke sw={sw} />
          <IsoTile x={12} y={2} w={12} d={20} color={c} stroke sw={sw} />
          <IsoBox x={8} y={8} w={8} d={8} h={8} color={ISO.block} sw={sw} />
        </>
      )
    case 'funding': // coin stack
      return [0, 1, 2, 3, 4].map((i) => (
        <IsoBox key={i} x={6} y={6} z={i * 3} w={12} d={12} h={2.4} color={c} sw={sw} shadow={i === 0} />
      ))
    case 'sustainability_health': // a tree on a green tile
      return (
        <>
          <IsoTile x={2} y={2} w={20} d={20} color={ISO.block} stroke sw={sw} />
          <IsoBox x={10} y={10} w={4} d={4} h={6} color="#8a6f4e" sw={sw} shadow={false} />
          <IsoBox x={6} y={6} z={6} w={12} d={12} h={10} color={c} sw={sw} shadow={false} />
        </>
      )
    default:
      return <IsoBox x={6} y={6} w={12} d={12} h={12} color={c} sw={sw} />
  }
}

const STATUS_COLOR = { pending: '#c4c9c1', running: ISO.blue, done: ISO.green, error: ISO.gap } as const

export const AgentGlyph = memo(function AgentGlyph({ agent, status }: { agent: AgentName; status: keyof typeof STATUS_COLOR }) {
  return (
    <svg viewBox={VB} className={`block h-9 w-10 shrink-0 ${status === 'running' ? 'iso-running' : ''}`} aria-hidden>
      {draw(agent, STATUS_COLOR[status])}
    </svg>
  )
})
