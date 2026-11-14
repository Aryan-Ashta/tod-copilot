// Construction staging for the plan map: new buildings go up with a tower crane and scaffolding, a building whose
// use changes gets wrapped in scaffolding while it takes its new colour, a building in the way of a new build or a
// park comes down storey by storey in a cloud of dust, and a new park greens over and grows its trees. Pure geometry
// from a build's start time and the clock; MapView owns the clock (requestAnimationFrame while anything is under way).
// Decoration only: no plan numbers come from here.
import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers'
import type { Color, Layer } from '@deck.gl/core'

export type BuildKind = 'new' | 'convert' | 'demolish' | 'park'

export interface Build {
  kind: BuildKind
  /** Outer ring of the footprint (the parcel, for a park), lon/lat. */
  ring: [number, number][]
  heightM: number
  /** Parcels the build stands on: what replaces a demolished building waits until its parcel is cleared. */
  parcels: string[]
  /** performance.now() when the build starts (staggered). */
  start: number
}

export const REDUCED_MOTION =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const DURATION_MS: Record<BuildKind, number> = { new: 4600, convert: 3400, demolish: 3600, park: 2600 }
/** Gap between builds that start together, so a batch goes up one after another. */
export const STAGGER_MS = 450

// Timeline fractions of a new build: crane mast up, then the building rises, then scaffold and crane come down.
const MAST_END = 0.14
const RISE_START = 0.12
const RISE_END = 0.82
const STRIKE_START = 0.84
// Demolition: the scaffold wrap goes up, then the building comes down between these, then the dust settles.
const WRAP_END = 0.15
const FALL_END = 0.8
/** A demolition has cleared the plot this far in; whatever replaces the building starts then. */
export const CLEARED_MS = DURATION_MS.demolish * 0.85

const M_PER_DEG_LAT = 111_320 // unit conversion, not a planning factor
const SCAFFOLD_OFFSET_M = 1.5 // scaffold stands this far off the facade
const STOREY_M = 3.2 // visual ring spacing only
const MAX_RINGS = 14
const MAX_POLES = 12
type Rgb = [number, number, number]
const SCAFFOLD: Rgb = [176, 104, 40]
const CRANE: Rgb = [227, 180, 72]
const CABLE: Rgb = [28, 34, 48]
const DUST: Rgb = [176, 168, 152]
const GRASS: Rgb = [46, 125, 91] // the park green of mapLayers' INFRA_COLORS
const TRUNK: Rgb = [110, 84, 58]
const CROWN: Rgb = [58, 140, 96]
const withAlpha = (c: Rgb, a: number): Color => [c[0], c[1], c[2], Math.round(a)]

const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
// a touch of overshoot, so trees pop
const easeOutBack = (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2

export const buildDuration = (k: BuildKind) => DURATION_MS[k]

/** 0..1 through the build's timeline (1 when done or with reduced motion). */
export function progress(b: Build, now: number): number {
  return REDUCED_MOTION ? 1 : clamp01((now - b.start) / buildDuration(b.kind))
}

/** Share of a new building's height standing at `now`. */
export function riseShare(b: Build, now: number): number {
  return easeInOut(clamp01((progress(b, now) - RISE_START) / (RISE_END - RISE_START)))
}

/** Share of a building under demolition still standing at `now` (it comes down faster as it goes). */
export function standingShare(b: Build, now: number): number {
  return 1 - clamp01((progress(b, now) - WRAP_END) / (FALL_END - WRAP_END)) ** 2
}

// deck's PathLayer extrudes a stroke's width across its ground-plane direction, so a truly vertical segment has none
// and vanishes. Verticals lean this far along the camera's line of sight (it looks north-west): too little to see as
// a lean, and the stroke then faces the camera.
const LEAN_M = 0.05

/** Local metre frame around the footprint centroid (equirectangular; fine at building scale). */
function frame(ring: [number, number][]) {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0])
  const mx = M_PER_DEG_LAT * Math.cos((c[1] * Math.PI) / 180)
  const toLonLat = (x: number, y: number, z: number): [number, number, number] => [c[0] + x / mx, c[1] + y / M_PER_DEG_LAT, z]
  return {
    pts: pts.map((p) => [(p[0] - c[0]) * mx, (p[1] - c[1]) * M_PER_DEG_LAT] as [number, number]),
    toLonLat,
    riser: (x: number, y: number, z0: number, z1: number) => [toLonLat(x, y, z0), toLonLat(x + LEAN_M, y - LEAN_M, z1)],
  }
}

const sample = <T,>(xs: T[], n: number) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]))

interface Stroke {
  path: [number, number, number][]
  color: Color
  width: number
}

function scaffold(b: Build, top: number, alpha: number, out: Stroke[]) {
  if (top <= 0 || alpha <= 0) return
  const { pts, toLonLat, riser } = frame(b.ring)
  const ring = pts.map(([x, y]) => {
    const r = Math.hypot(x, y) || 1
    return [x + (x / r) * SCAFFOLD_OFFSET_M, y + (y / r) * SCAFFOLD_OFFSET_M] as [number, number]
  })
  const color = withAlpha(SCAFFOLD, 255 * alpha)
  const brace = withAlpha(SCAFFOLD, 150 * alpha)
  const step = Math.max(STOREY_M, b.heightM / MAX_RINGS)
  const poles = sample(ring, MAX_POLES)
  let level = 0
  for (let z = 0; z <= top + 1e-6; z += step, level++) {
    out.push({ path: [...ring, ring[0]].map(([x, y]) => toLonLat(x, y, z)), color, width: 1.2 })
    // a diagonal brace on alternate bays of alternate lifts
    const z1 = Math.min(z + step, top)
    if (level % 2 === 0 && z1 > z) {
      poles.forEach(([x, y], i) => {
        if (i % 2) return
        const [x2, y2] = poles[(i + 1) % poles.length]
        out.push({ path: [toLonLat(x, y, z), toLonLat(x2, y2, z1)], color: brace, width: 1 })
      })
    }
  }
  for (const [x, y] of poles) out.push({ path: riser(x, y, 0, top), color, width: 1.2 })
}

/** An ink stroke under a coloured one, so the crane reads as a drawn part on the pale map like the iso figures. */
function inked(path: [number, number, number][], color: Color, width: number, alpha: number, out: Stroke[]) {
  out.push({ path, color: withAlpha(CABLE, 230 * alpha), width: width + 2 })
  out.push({ path, color, width })
}

/** Footprints wider than this (radius, m) get a second crane. */
const TWO_CRANE_RADIUS_M = 35
/** Vertical gap between cranes whose jibs could cross: the upper jib clears the lower one's apex (6 m above its jib). */
const CRANE_CLEARANCE_M = 14
const APEX_M = 6

type Corner = (x: number, y: number) => number

interface Crane {
  b: Build
  slot: number
  phase: number
  /** Mast position in the build's local metre frame, and in lon/lat for comparing cranes across builds. */
  mx: number
  my: number
  lonLat: [number, number]
  reach: number
  /** Tower height from the building alone: the iso camera halves verticals, so it stands well clear of the roof. */
  ownH: number
}

/**
 * A tower crane standing just outside the footprint corner that maximises `corner` (the camera looks north-west, so
 * south-east is in front and south-west / north-east are the visible flanks).
 */
function placeCrane(b: Build, slot: number, corner: Corner, phase: number): Crane {
  const { pts, toLonLat } = frame(b.ring)
  const radius = Math.max(...pts.map(([x, y]) => Math.hypot(x, y)))
  const at = pts.reduce((a, q) => (corner(q[0], q[1]) > corner(a[0], a[1]) ? q : a), pts[0])
  const r = Math.hypot(at[0], at[1]) || 1
  const mx = at[0] + (at[0] / r) * 6
  const my = at[1] + (at[1] / r) * 6
  const [lon, lat] = toLonLat(mx, my, 0)
  return { b, slot, phase, mx, my, lonLat: [lon, lat], reach: Math.max(20, radius * 1.3), ownH: b.heightM * 1.5 + 12 }
}

function cranesFor(b: Build): Crane[] {
  const cranes = [placeCrane(b, 0, (x, y) => x - y, 0)] // south-east, in front
  const { pts } = frame(b.ring)
  if (Math.max(...pts.map(([x, y]) => Math.hypot(x, y))) > TWO_CRANE_RADIUS_M) {
    cranes.push(placeCrane(b, 1, (x, y) => -(x + y), 1700)) // south-west flank, slewing out of step
  }
  return cranes
}

/** Ground distance between two cranes' masts, metres. */
function mastGap(a: Crane, c: Crane): number {
  const dx = (a.lonLat[0] - c.lonLat[0]) * M_PER_DEG_LAT * Math.cos((a.lonLat[1] * Math.PI) / 180)
  const dy = (a.lonLat[1] - c.lonLat[1]) * M_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/** Whether two cranes' slewing circles (jib reach around the mast) overlap, so their jibs could cross. */
const couldCross = (a: Crane, c: Crane) => mastGap(a, c) < a.reach + c.reach

/**
 * A crane whose mast would stand this close to one already up is left out: plots that share a footprint (two
 * parcels with one outline) or sit side by side share the crane instead of stacking two or four on one spot.
 */
const MIN_MAST_GAP_M = 30

// Decided once per build and crane slot, so a crane never pops in or jumps when a neighbour finishes:
// whether it stands at all, and at what tower height.
const craneShown = new WeakMap<Build, Map<number, boolean>>()
const towerHeights = new WeakMap<Build, Map<number, number>>()

function memoFor<V>(store: WeakMap<Build, Map<number, V>>, b: Build): Map<number, V> {
  const m = store.get(b) ?? new Map<number, V>()
  store.set(b, m)
  return m
}

/** Cranes in build order, minus any standing on (or next to) a spot an earlier crane already has. */
function dedupeCranes(cranes: Crane[]): Crane[] {
  const kept: Crane[] = []
  for (const c of [...cranes].sort((a, b) => a.b.start - b.b.start || a.slot - b.slot)) {
    const memo = memoFor(craneShown, c.b)
    let shown = memo.get(c.slot)
    if (shown === undefined) {
      shown = kept.every((k) => mastGap(c, k) >= MIN_MAST_GAP_M)
      memo.set(c.slot, shown)
    }
    if (shown) kept.push(c)
  }
  return kept
}

/**
 * Real sites stagger the heights of cranes that share airspace; here too. Earlier builds keep their height; a later
 * crane that could cross one already standing goes up by the clearance until it clears every one of them.
 */
function assignTowerHeights(cranes: Crane[]): Map<Crane, number> {
  const placed = new Map<Crane, number>()
  for (const c of [...cranes].sort((a, b) => a.b.start - b.b.start || a.slot - b.slot)) {
    const memo = memoFor(towerHeights, c.b)
    let h = memo.get(c.slot)
    if (h === undefined) {
      h = c.ownH
      // h only ever rises, and only by a real step, so this settles (a float tie must not loop)
      for (let moved = true; moved; ) {
        moved = false
        for (const [o, oh] of placed) {
          const clear = oh + CRANE_CLEARANCE_M
          if (couldCross(c, o) && Math.abs(h - oh) < CRANE_CLEARANCE_M - 1e-6 && clear > h) {
            h = clear
            moved = true
          }
        }
      }
      memo.set(c.slot, h)
    }
    placed.set(c, h)
  }
  return placed
}

function drawCrane(c: Crane, towerH: number, now: number, p: number, out: Stroke[]) {
  const { b, mx, my, reach } = c
  const { toLonLat, riser } = frame(b.ring)
  const mastH = towerH * easeInOut(clamp01(p / MAST_END))
  const alpha = p < STRIKE_START ? 1 : 1 - clamp01((p - STRIKE_START) / (1 - STRIKE_START))
  const color = withAlpha(CRANE, 255 * alpha)
  inked(riser(mx, my, 0, mastH), color, 4, alpha, out)
  if (p < MAST_END) return
  const t = now - b.start + c.phase
  const toward = Math.atan2(-my, -mx) + 0.6 * Math.sin(t / 900)
  const [ux, uy] = [Math.cos(toward), Math.sin(toward)]
  const tip = [mx + ux * reach, my + uy * reach]
  const tail = [mx - ux * reach * 0.32, my - uy * reach * 0.32]
  inked([toLonLat(tail[0], tail[1], towerH), toLonLat(tip[0], tip[1], towerH)], color, 3, alpha, out)
  // operator's cab under the jib, counterweight on the tail, tie bars from the apex
  inked([toLonLat(mx, my, towerH - 3), toLonLat(mx + ux * 2.5, my + uy * 2.5, towerH - 3)], color, 6, alpha, out)
  inked([toLonLat(tail[0], tail[1], towerH - 1.5), toLonLat(mx - ux * reach * 0.2, my - uy * reach * 0.2, towerH - 1.5)],
    withAlpha(CABLE, 255 * alpha), 6, alpha, out)
  out.push({ path: [toLonLat(tail[0], tail[1], towerH), toLonLat(mx, my, towerH + APEX_M), toLonLat(tip[0], tip[1], towerH)],
    color: withAlpha(CABLE, 200 * alpha), width: 1 })
  // Trolley rides the jib; the hook line drops to a storey above the rising roof, with a load on it.
  const trolley = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t / 650))
  const hx = mx + ux * reach * trolley
  const hy = my + uy * reach * trolley
  const hook = Math.min(towerH - 2, b.heightM * riseShare(b, now) + STOREY_M * 2)
  out.push({ path: riser(hx, hy, towerH, hook), color: withAlpha(CABLE, 220 * alpha), width: 1 })
  inked([toLonLat(hx - ux * 2, hy - uy * 2, hook), toLonLat(hx + ux * 2, hy + uy * 2, hook)], withAlpha(SCAFFOLD, 255 * alpha), 5, alpha, out)
}

interface Puff {
  position: [number, number, number]
  radius: number
  color: Color
}

/** Dust kicked up round the falling roof line: puffs that rise, swell and thin out on their own cycles. */
function dust(b: Build, now: number, p: number, out: Puff[]) {
  if (p < WRAP_END) return
  const { pts, toLonLat } = frame(b.ring)
  const roof = b.heightM * standingShare(b, now)
  const settle = p < FALL_END ? 1 : 1 - (p - FALL_END) / (1 - FALL_END)
  const ring = sample(pts, 16)
  ring.forEach(([x, y], i) => {
    const q = ((now - b.start) / 900 + i / ring.length) % 1
    const spread = 1 + q * 0.35
    out.push({ position: toLonLat(x * spread, y * spread, roof + q * 10), radius: 4 + q * 14, color: withAlpha(DUST, 150 * (1 - q) * settle) })
  })
}

/** Even-odd ray test in the local metre frame. */
function inside([x, y]: [number, number], ring: [number, number][]): boolean {
  let hit = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

const MAX_TREES = 12
const TREE_GRID = 5

/** Trees on a grid over the parcel, kept to points inside it. */
function treeSpots(ring: [number, number][]): [number, number][] {
  const xs = ring.map((q) => q[0])
  const ys = ring.map((q) => q[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const spots: [number, number][] = []
  for (let i = 0; i < TREE_GRID; i++) {
    for (let j = 0; j < TREE_GRID; j++) {
      // offset alternate rows so the planting reads as informal
      const s: [number, number] = [x0 + ((i + 0.5 + (j % 2) * 0.3) / TREE_GRID) * (x1 - x0), y0 + ((j + 0.5) / TREE_GRID) * (y1 - y0)]
      if (inside(s, ring)) spots.push(s)
    }
  }
  return sample(spots, MAX_TREES)
}

/** A new park: the parcel greens over, then its trees pop up one after another (and stay). */
function park(b: Build, p: number, grass: { polygon: [number, number, number][]; color: Color }[], strokes: Stroke[], crowns: Puff[]) {
  const { pts, toLonLat, riser } = frame(b.ring)
  if (p < 1) grass.push({ polygon: pts.map(([x, y]) => toLonLat(x, y, 0.3)), color: withAlpha(GRASS, 200 * clamp01(p / 0.35)) })
  treeSpots(pts).forEach(([x, y], i) => {
    const grow = Math.max(0, easeOutBack(clamp01((p - 0.25 - i * 0.04) / 0.35)))
    if (grow <= 0) return
    strokes.push({ path: riser(x, y, 0, 3.5 * grow), color: withAlpha(TRUNK, 255), width: 2 })
    crowns.push({ position: toLonLat(x, y, 3.5 * grow + 2), radius: 6 * grow, color: withAlpha(CROWN, 235) })
  })
}

/**
 * Cranes, scaffolding, dust and park planting for every build under way (parks keep their trees once done); empty
 * layers when nothing is.
 */
export function constructionLayer(builds: Iterable<Build>, now: number): Layer[] {
  const strokes: Stroke[] = []
  const cranes: Crane[] = []
  const puffs: Puff[] = []
  const crowns: Puff[] = []
  const grass: { polygon: [number, number, number][]; color: Color }[] = []
  for (const b of builds) {
    const p = progress(b, now)
    if (b.kind === 'park') {
      if (p > 0) park(b, p, grass, strokes, crowns)
      continue
    }
    if (p <= 0 || p >= 1) continue
    if (b.kind === 'new') {
      const roof = b.heightM * riseShare(b, now)
      // the scaffold runs a storey ahead of the rising floors, then is struck with the crane
      const top = Math.min(b.heightM, roof + STOREY_M)
      scaffold(b, p < RISE_START ? STOREY_M : top, p < STRIKE_START ? 1 : 1 - (p - STRIKE_START) / (1 - STRIKE_START), strokes)
      cranes.push(...cranesFor(b))
    } else if (b.kind === 'convert') {
      // conversion: the wrap climbs the facade, holds while the use changes, then comes down
      const top = b.heightM * easeInOut(clamp01(p / 0.4))
      scaffold(b, top, p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25, strokes)
    } else {
      // demolition: wrap the building, then the wrap follows the roof down a storey above it, in a cloud of dust
      const top = p < WRAP_END ? b.heightM * easeInOut(p / WRAP_END) : b.heightM * standingShare(b, now) + STOREY_M
      scaffold(b, Math.max(top, STOREY_M), p < FALL_END ? 1 : 1 - (p - FALL_END) / (1 - FALL_END), strokes)
      dust(b, now, p, puffs)
    }
  }
  for (const [c, h] of assignTowerHeights(dedupeCranes(cranes))) drawCrane(c, h, now, progress(c.b, now), strokes)
  return [
    new SolidPolygonLayer<(typeof grass)[number]>({
      id: 'construction-grass',
      data: grass,
      getPolygon: (g) => g.polygon,
      getFillColor: (g) => g.color,
      pickable: false,
    }),
    new PathLayer<Stroke>({
      id: 'construction',
      data: strokes,
      getPath: (s) => s.path,
      getColor: (s) => s.color,
      getWidth: (s) => s.width,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      pickable: false,
    }),
    new ScatterplotLayer<Puff>({
      id: 'construction-crowns',
      data: crowns,
      getPosition: (c) => c.position,
      getRadius: (c) => c.radius,
      radiusUnits: 'pixels',
      getFillColor: (c) => c.color,
      stroked: true,
      getLineColor: [28, 34, 48, 200],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      billboard: true,
      pickable: false,
    }),
    new ScatterplotLayer<Puff>({
      id: 'construction-dust',
      data: puffs,
      getPosition: (c) => c.position,
      getRadius: (c) => c.radius,
      radiusUnits: 'pixels',
      getFillColor: (c) => c.color,
      billboard: true,
      pickable: false,
      // soft puffs overlap without hiding each other or what is behind
      parameters: { depthWriteEnabled: false },
    }),
  ]
}
