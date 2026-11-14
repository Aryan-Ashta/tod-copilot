// Isometric SVG kit in the drawing language of aryanashta.me.
//
// 2:1 dimetric projection: screen x = (x − y), screen y = (x + y) / 2 − z, in world units (callers pick the scale
// through the SVG viewBox). Edges run at ±26.57°. A box at (x, y, z) with extents w (along x), d (along y) and h (up)
// shows three faces: top (lightest), left = the y + d face, right = the x + w face (darkest), plus a flat ink
// contact shadow of its footprint offset (+1.3, +1.3) at 12% opacity. Primary blocks carry a 1 px ink outline with
// round joins; small repeated blocks (stroke = false) read as texture. A ghost is a dashed wireframe.
import { memo, type ReactNode } from 'react'
import { ISO, shade } from './shade'

export type Pt = [number, number]

export function project(x: number, y: number, z = 0): Pt {
  return [x - y, (x + y) / 2 - z]
}

const pts = (ps: Pt[]) => ps.map(([a, b]) => `${+a.toFixed(2)},${+b.toFixed(2)}`).join(' ')

export interface BoxGeom {
  x: number
  y: number
  z?: number
  w: number
  d: number
  h: number
}

interface BoxProps extends BoxGeom {
  color: string
  /** 1 px ink outline (primary blocks). Off for repeated sub-blocks. */
  stroke?: boolean
  /** Outline width in world units; the figure's scale decides how thick it looks, as on the site. */
  sw?: number
  shadow?: boolean
  opacity?: number
  title?: string
  /** Edges only (no faces): frames a block whose faces are drawn by unstroked sub-blocks (floors, units). */
  outline?: boolean
}

function corners({ x, y, z = 0, w, d, h }: BoxGeom) {
  const P = project
  return {
    ground: [P(x, y, z), P(x + w, y, z), P(x + w, y + d, z), P(x, y + d, z)] as Pt[],
    top: [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)] as Pt[],
    left: [P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)] as Pt[],
    right: [P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)] as Pt[],
  }
}

/** A solid block: contact shadow, left face, right face, top face. */
export const IsoBox = memo(function IsoBox({ color, stroke = true, sw = 1, shadow = true, opacity, title, outline, ...g }: BoxProps) {
  const f = shade(color)
  const c = corners(g)
  const line = stroke || outline ? { stroke: ISO.ink, strokeWidth: sw, strokeLinejoin: 'round' as const } : {}
  const fill = (tone: string) => (outline ? 'none' : tone)
  const off = 1.32 * sw
  return (
    <g opacity={opacity}>
      {title && <title>{title}</title>}
      {shadow && !outline && (g.z ?? 0) === 0 && (
        <polygon points={pts(c.ground.map(([a, b]) => [a + off, b + off]))} fill={ISO.ink} opacity={0.12} />
      )}
      {g.h > 0 && <polygon points={pts(c.left)} fill={fill(f.left)} {...line} />}
      {g.h > 0 && <polygon points={pts(c.right)} fill={fill(f.right)} {...line} />}
      <polygon points={pts(c.top)} fill={fill(f.top)} {...line} />
    </g>
  )
})

interface GhostProps extends BoxGeom {
  sw?: number
  color?: string
  /** Text placed above the ghost's top face, e.g. "missing" or "gap $13.1M". */
  label?: string
  labelSize?: number
  title?: string
}

/** Dashed wireframe: "what it would become" or "what is missing". Verticals 3/5 dash, top face 4/4. */
export const IsoGhost = memo(function IsoGhost({ sw = 1, color = ISO.ink, label, labelSize = 10, title, ...g }: GhostProps) {
  const c = corners(g)
  const [, right, front, left] = c.ground
  const verts: Pt[][] = [
    [front, c.top[2]],
    [right, c.top[1]],
    [left, c.top[3]],
  ]
  const top = c.top
  const lx = (top[0][0] + top[2][0]) / 2
  const ly = Math.min(...top.map((p) => p[1])) - labelSize * 0.6
  return (
    <g>
      {title && <title>{title}</title>}
      {verts.map(([a, b], i) => (
        <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={sw} strokeDasharray={`${3 * sw} ${5 * sw}`} opacity={0.45} />
      ))}
      <polyline points={pts([c.ground[3], c.ground[2], c.ground[1]])} fill="none" stroke={color} strokeWidth={sw}
        strokeDasharray={`${3 * sw} ${5 * sw}`} opacity={0.35} />
      <polygon points={pts(top)} fill="none" stroke={color} strokeWidth={sw} strokeDasharray={`${4 * sw} ${4 * sw}`} opacity={0.6} />
      {label && (
        <text x={lx} y={ly} textAnchor="middle" fontSize={labelSize} fill={color} fontFamily="inherit">
          {label}
        </text>
      )}
    </g>
  )
})

export interface StackLayer {
  h: number
  color: string
  /** Draw this layer as a dashed ghost (e.g. the funding gap). */
  ghost?: boolean
  stroke?: boolean
  title?: string
  label?: string
}

/** Layers on one footprint, bottom to top (floors of a building, slices of a capital stack). */
export const IsoStack = memo(function IsoStack({ x, y, w, d, layers, sw = 1, z0 = 0 }: {
  x: number
  y: number
  w: number
  d: number
  layers: StackLayer[]
  sw?: number
  z0?: number
}) {
  const out: ReactNode[] = []
  let z = z0
  layers.forEach((l, i) => {
    if (l.h <= 0) return
    out.push(
      l.ghost ? (
        <IsoGhost key={i} x={x} y={y} z={z} w={w} d={d} h={l.h} sw={sw} color={l.color} label={l.label} title={l.title} />
      ) : (
        <IsoBox key={i} x={x} y={y} z={z} w={w} d={d} h={l.h} color={l.color} stroke={l.stroke ?? true} sw={sw}
          shadow={z === z0 && z0 === 0} title={l.title} />
      ),
    )
    z += l.h
  })
  return <g>{out}</g>
})

/** A flat parcel: a thin slab, no outline by default so rows of tiles read as texture. */
export const IsoTile = memo(function IsoTile({ x, y, z = 0, w, d, color, h = 1.5, stroke = false, sw = 1, title }: {
  x: number
  y: number
  z?: number
  w: number
  d: number
  color: string
  h?: number
  stroke?: boolean
  sw?: number
  title?: string
}) {
  return <IsoBox x={x} y={y} z={z} w={w} d={d} h={h} color={color} stroke={stroke} sw={sw} title={title} />
})

/** A building as floor slabs: one unstroked slab per floor (colour per floor, so converted floors can differ), a thin
 *  gap between slabs so floors read as texture, and one ink outline around the whole mass. */
export const IsoFloors = memo(function IsoFloors({ x, y, w, d, floorH, colors, sw = 1, title }: {
  x: number
  y: number
  w: number
  d: number
  floorH: number
  /** Bottom floor first. */
  colors: string[]
  sw?: number
  title?: string
}) {
  const gap = Math.min(floorH * 0.12, 1.2)
  return (
    <g>
      {title && <title>{title}</title>}
      {colors.map((c, i) => (
        <IsoBox key={i} x={x} y={y} z={i * floorH} w={w} d={d} h={floorH - gap} color={c} stroke={false} shadow={i === 0} />
      ))}
      <IsoBox x={x} y={y} w={w} d={d} h={colors.length * floorH - gap} color={ISO.ink} outline sw={sw} />
    </g>
  )
})

/** viewBox string that frames the given boxes with `pad` world units of margin. */
export function isoViewBox(boxes: BoxGeom[], pad = 8): string {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const b of boxes) {
    const c = corners(b)
    for (const [a, v] of [...c.ground, ...c.top]) {
      x0 = Math.min(x0, a)
      y0 = Math.min(y0, v)
      x1 = Math.max(x1, a)
      y1 = Math.max(y1, v)
    }
  }
  if (!Number.isFinite(x0)) return '0 0 100 100'
  return `${+(x0 - pad).toFixed(2)} ${+(y0 - pad).toFixed(2)} ${+(x1 - x0 + 2 * pad).toFixed(2)} ${+(y1 - y0 + 2 * pad).toFixed(2)}`
}

/** Painter's order for non-overlapping boxes: far (small x + y) first, then low z first. */
export function byDepth<T extends BoxGeom>(a: T, b: T): number {
  return a.x + a.y - (b.x + b.y) || (a.z ?? 0) - (b.z ?? 0)
}

/** Screen-space label anchored at a world point. */
export function IsoLabel({ at, children, size = 10, anchor = 'start', fill = ISO.ink, weight = 400 }: {
  at: [number, number, number]
  children: ReactNode
  size?: number
  anchor?: 'start' | 'middle' | 'end'
  fill?: string
  weight?: number
}) {
  const [x, y] = project(...at)
  return (
    <text x={x} y={y} fontSize={size} textAnchor={anchor} fill={fill} fontWeight={weight} fontFamily="inherit"
      style={{ fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </text>
  )
}
