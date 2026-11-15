// Construction staging for the plan map, played when a tile is placed or the agents' suggestions are applied. New
// buildings go up with a tower crane and scaffolding and land with a springy overshoot (a touch over full height, then
// settling to exactly it) and a soft ring of dust; a building whose use changes gets a 'paint wipe': its scaffold rings
// sweep up the facade and back down while it takes its new colour; a building in the way of a new build or a park comes
// down storey by storey in rounded, drifting dust puffs; and a new park greens over and pops its trees with
// squash-and-stretch, each tree leaning, sizing and swaying its own way. Trees are solid: a bark trunk under two or three
// stacked, lit crown tiers (rounded broadleaf or conical pine) over a soft ground shade; a big park also builds a
// fountain at its centre (stone basin, water, a column with a bowl, and spray arcs whose droplets keep playing for as
// long as the park stands: fountainDropsLayer draws just them, so MapView can redraw that one layer on a light clock).
// A build, conversion or park closes with a short burst of confetti and twinkling stars that fades out within its last
// BURST_MS. parkDecorLayers draws the same trees (and, unless told not to, the fountain), fully grown and still, for
// any plot.
//
// Every random choice (crane jib start angle and slew direction, tree size and lean, puff placement, the yaw of the
// celebratory bits) is drawn from a seed hashed from the build's footprint, so nothing jumps between frames. Pure
// geometry from a build's start time and the clock; MapView owns the clock (requestAnimationFrame while anything is
// under way, up to the end of buildDuration, which includes the burst). With reduced motion every build is at its end
// state: no cranes, puffs or bursts, parks drawn with their trees standing and the spray still. Decoration only: every
// number here is visual, none is a planning factor or comes into the plan.
import { PathLayer, ScatterplotLayer, SolidPolygonLayer } from '@deck.gl/layers'
import type { Color, Layer } from '@deck.gl/core'
import { pointInRing } from './geo'

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
const DURATION_MS: Record<BuildKind, number> = { new: 3800, convert: 2800, demolish: 3000, park: 2200 }
/** Gap between builds that start together, so a batch goes up one after another. */
export const STAGGER_MS = 380
/** The celebratory burst fills the last this-many ms of a build's, conversion's or park's timeline. */
const BURST_MS = 850

// Timeline fractions of a new build: crane mast up, then the building rises (and settles from its overshoot just as
// the burst starts), then scaffold and crane come down.
const MAST_END = 0.12
const RISE_START = 0.1
const RISE_END = 0.74
const STRIKE_START = 0.78
// Conversion: the scaffold wrap sweeps up the facade until WIPE_UP_END, then back down until WIPE_DOWN_END.
const WIPE_UP_END = 0.36
const WIPE_DOWN_END = 0.66
// Demolition: the scaffold wrap goes up, then the building comes down between these, then the dust settles.
const WRAP_END = 0.15
const FALL_END = 0.8
/** A demolition has cleared the plot this far in; whatever replaces the building starts then. */
export const CLEARED_MS = DURATION_MS.demolish * 0.85
// Park: the green spreads until GREEN_END; tree i starts popping at TREE_START + i * stagger for TREE_POP, the stagger
// shrinking from TREE_STAGGER so all trees start within TREE_SPREAD; the fountain is built from FOUNTAIN_START to
// FOUNTAIN_END.
const GREEN_END = 0.3
const TREE_START = 0.15
const TREE_STAGGER = 0.025
const TREE_SPREAD = 0.45
const TREE_POP = 0.28
const FOUNTAIN_START = 0.08
const FOUNTAIN_END = 0.75

const M_PER_DEG_LAT = 111_320 // unit conversion, not a planning factor
const SCAFFOLD_OFFSET_M = 1.5 // scaffold stands this far off the facade
const STOREY_M = 3.2 // visual ring spacing only
const MAX_RINGS = 14
const MAX_POLES = 12
const MAX_PUFFS = 14 // dust puffs per demolition (each drawn as a core and a soft halo)
const MAX_LAND_PUFFS = 8 // dust puffs round a new building's base as it lands
const MAX_CONFETTI = 14 // confetti dots per burst
const MAX_SPARKS = 4 // twinkling stars per burst
const MAX_TREES = 32
const TREE_GRID_MAX = 8 // tree grid cells per side, at most
const TREE_SPACING_M = 14 // grid pitch the tree grid aims for
const TREE_EDGE_M = 2 // trunks stand at least this far inside the plot
const TRUNK_M = 3.4 // trunk height up to the crown, before the per-tree size
const TRUNK_R_M = 0.4
const CROWN_R_M = 4.2 // crown's widest radius
const CROWN_H_M = 6.6
const CROWN_SIDES = 8
const MATURE_SIDE_M = 70 // plots wider than this (√area) grow proportionally bigger trees, up to MAX_TREE_SCALE
const MAX_TREE_SCALE = 1.7
const CONIFER_SHARE = 0.3
/** Plots at least this big (m²) get a fountain. */
const FOUNTAIN_MIN_M2 = 2500
const BASIN_SIDES = 18
const BASIN_RIM_M = 0.5
const BASIN_H_M = 0.7
const WATER_H_M = 0.5
const COLUMN_H_M = 2.2
const BOWL_H_M = 0.3
const JET_M = 1.4
const SPRAY_ARCS = 8
const SPRAY_DROPS = 2 // droplets riding each arc
const SPRAY_PEAK_M = 1.7 // how far an arc rises above the jet top
const SPRAY_MS = 1100 // a droplet's trip along its arc

type Rgb = [number, number, number]
const SCAFFOLD: Rgb = [176, 104, 40]
const CRANE: Rgb = [227, 180, 72]
const CABLE: Rgb = [28, 34, 48]
const DUST: Rgb = [176, 168, 152]
const DUST_LIGHT: Rgb = [205, 199, 186]
const GRASS: Rgb = [46, 125, 91] // the park green of mapLayers' INFRA_COLORS
const TRUNK: Rgb = [110, 84, 58]
const CROWN: Rgb = [58, 140, 96]
const CROWN_LIGHT: Rgb = [92, 166, 112]
const PINE: Rgb = [38, 106, 78]
const SHADE: Rgb = [24, 62, 44]
const STONE: Rgb = [198, 192, 180]
const PAVING: Rgb = [226, 220, 204]
const WATER: Rgb = [132, 192, 222]
const SPRAY: Rgb = [232, 246, 252]
/** mapLayers' MATTE: flat, so the lit faces read as the iso figures' three tones rather than gloss. */
const MATTE = { ambient: 0.62, diffuse: 0.5, shininess: 0, specularColor: [0, 0, 0] as Rgb }
const PAPER: Rgb = [250, 246, 232]
// the index.css theme accents: mustard, blue, green, gap red, transit teal
const MUSTARD: Rgb = [227, 180, 72]
const CONFETTI: Rgb[] = [MUSTARD, [47, 91, 211], [46, 125, 91], [185, 58, 46], [19, 128, 138]]
const LEAVES: Rgb[] = [GRASS, CROWN, CROWN_LIGHT, MUSTARD]
const withAlpha = (c: Rgb, a: number): Color => [c[0], c[1], c[2], Math.round(Math.min(255, Math.max(0, a)))]

const clamp01 = (t: number) => Math.min(1, Math.max(0, t))
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
/**
 * Ease-out-back: overshoots by 4c³ / (27 (c + 1)²) before landing on exactly 1 at t = 1 (c = 1.7 → 10 %, a pop;
 * c = 1.05 → 4 %, a gentle spring).
 */
const easeOutBack = (t: number, c = 1.7) => 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2
const RISE_SPRING = 1.05
/** A decaying wobble for squash-and-stretch and sway: 0 at both ends, swinging out and back `turns` times. */
const wobble = (t: number, turns = 1.25) => Math.sin(2 * Math.PI * turns * t) * (1 - t) ** 2
const TAU = 2 * Math.PI

export const buildDuration = (k: BuildKind) => DURATION_MS[k]

/** 0..1 through the build's timeline (1 when done or with reduced motion). */
export function progress(b: Build, now: number): number {
  return REDUCED_MOTION ? 1 : clamp01((now - b.start) / buildDuration(b.kind))
}

/**
 * Share of a new building's height standing at `now`: eases in, springs about 4 % past full height and settles back to
 * exactly 1 by RISE_END (so it briefly exceeds 1).
 */
export function riseShare(b: Build, now: number): number {
  return easeOutBack(clamp01((progress(b, now) - RISE_START) / (RISE_END - RISE_START)) ** 1.6, RISE_SPRING)
}

/** Share of a building under demolition still standing at `now` (it comes down faster as it goes). */
export function standingShare(b: Build, now: number): number {
  return 1 - clamp01((progress(b, now) - WRAP_END) / (FALL_END - WRAP_END)) ** 2
}

/** 0..1 through the closing burst (the last BURST_MS of the timeline); null outside it, so never at p = 1. */
function burstT(b: Build, p: number): number | null {
  const share = Math.min(1, BURST_MS / buildDuration(b.kind))
  const t = (p - (1 - share)) / share
  return t > 0 && t < 1 ? t : null
}

/** Hash of the footprint rounded to ~1 m: a build's seed, steady from frame to frame. */
function hashRing(ring: [number, number][]): number {
  let h = 0x811c9dc5
  for (const [lon, lat] of ring) {
    h = Math.imul(h ^ Math.round(lon * 1e5), 0x01000193)
    h = Math.imul(h ^ Math.round(lat * 1e5), 0x01000193)
  }
  return h >>> 0
}

/** Hash of a plot key: parkDecorLayers' seed, so a plot keeps its planting whatever its ring's vertex order. */
function hashKey(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Deterministic draw `k` in 0..1 from `seed` (a stateless integer hash, so the same k always gives the same value). */
function rand(seed: number, k: number): number {
  let t = (seed + Math.imul(k + 1, 0x9e3779b9)) | 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
// Draw ranges per use, so the choices for one part never shadow another's. Each item takes up to 8 draws.
const SALT_CRANE = 0
const SALT_PUFF = 300
const SALT_LAND = 500
const SALT_BURST = 700
const SALT_SPARK = 900
const SALT_GRID = 1100 // two draws per tree-grid cell
const SALT_FOUNTAIN = 1300
const SALT_TREE = 1500 // MAX_TREES × 8 draws

// deck's PathLayer extrudes a stroke's width across its ground-plane direction, so a truly vertical segment has none
// and vanishes. Verticals lean this far along the camera's line of sight (it looks north-west): too little to see as
// a lean, and the stroke then faces the camera.
const LEAN_M = 0.05

type LonLatZ = [number, number, number]

type ToLonLat = (x: number, y: number, z: number) => LonLatZ

/** A ring's local metre frame around its vertex centroid (equirectangular; fine at plot scale). */
function localFrame(ring: [number, number][]): { pts: [number, number][]; toLonLat: ToLonLat } {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)![0] && ring[0][1] === ring.at(-1)![1] ? ring.slice(0, -1) : ring
  const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0])
  const mx = M_PER_DEG_LAT * Math.cos((c[1] * Math.PI) / 180)
  return {
    pts: pts.map((p) => [(p[0] - c[0]) * mx, (p[1] - c[1]) * M_PER_DEG_LAT] as [number, number]),
    toLonLat: (x, y, z) => [c[0] + x / mx, c[1] + y / M_PER_DEG_LAT, z],
  }
}

/** A build's local metre frame around the footprint centroid and its seed. */
interface Geom {
  pts: [number, number][]
  /** The footprint pushed out by SCAFFOLD_OFFSET_M: where the scaffold stands. */
  wrap: [number, number][]
  radius: number
  seed: number
  toLonLat: ToLonLat
  riser: (x: number, y: number, z0: number, z1: number) => LonLatZ[]
  park?: ParkPlan
}

const geoms = new WeakMap<Build, Geom>()

function geom(b: Build): Geom {
  const known = geoms.get(b)
  if (known) return known
  const { pts: local, toLonLat } = localFrame(b.ring)
  const g: Geom = {
    pts: local,
    wrap: local.map(([x, y]) => {
      const r = Math.hypot(x, y) || 1
      return [x + (x / r) * SCAFFOLD_OFFSET_M, y + (y / r) * SCAFFOLD_OFFSET_M] as [number, number]
    }),
    radius: Math.max(1, ...local.map(([x, y]) => Math.hypot(x, y))),
    seed: hashRing(b.ring),
    toLonLat,
    riser: (x, y, z0, z1) => [toLonLat(x, y, z0), toLonLat(x + LEAN_M, y - LEAN_M, z1)],
  }
  geoms.set(b, g)
  return g
}

const sample = <T,>(xs: T[], n: number) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]))

interface Stroke {
  path: LonLatZ[]
  color: Color
  width: number
}

function scaffold(b: Build, top: number, alpha: number, out: Stroke[]) {
  if (top <= 0 || alpha <= 0) return
  const { wrap: ring, toLonLat, riser } = geom(b)
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

/**
 * A conversion's paint wipe: the scaffold sweeps up the facade and back down, its leading ring drawn like a roller
 * (a soft mustard wash under a bright line) while mapLayers fades the building to its new colour.
 */
function paintWipe(b: Build, p: number, out: Stroke[]) {
  const up = p < WIPE_UP_END
  const down = clamp01((p - WIPE_UP_END) / (WIPE_DOWN_END - WIPE_UP_END))
  const top = b.heightM * (up ? easeInOut(p / WIPE_UP_END) : 1 - easeInOut(down))
  if (top < 0.3) return
  const alpha = up ? 1 : 1 - 0.6 * down * down
  scaffold(b, top, alpha, out)
  const { wrap, toLonLat } = geom(b)
  const path = [...wrap, wrap[0]].map(([x, y]) => toLonLat(x, y, top))
  out.push({ path, color: withAlpha(MUSTARD, 110 * alpha), width: 7 })
  out.push({ path, color: withAlpha(PAPER, 255 * alpha), width: 2.5 })
}

/** An ink stroke under a coloured one, so the crane reads as a drawn part on the pale map like the iso figures. */
function inked(path: LonLatZ[], color: Color, width: number, alpha: number, out: Stroke[]) {
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
  const { pts, radius, toLonLat } = geom(b)
  const at = pts.reduce((a, q) => (corner(q[0], q[1]) > corner(a[0], a[1]) ? q : a), pts[0])
  const r = Math.hypot(at[0], at[1]) || 1
  const mx = at[0] + (at[0] / r) * 6
  const my = at[1] + (at[1] / r) * 6
  const [lon, lat] = toLonLat(mx, my, 0)
  return { b, slot, phase, mx, my, lonLat: [lon, lat], reach: Math.max(20, radius * 1.3), ownH: b.heightM * 1.5 + 12 }
}

function cranesFor(b: Build): Crane[] {
  const cranes = [placeCrane(b, 0, (x, y) => x - y, 0)] // south-east, in front
  if (geom(b).radius > TWO_CRANE_RADIUS_M) {
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

/**
 * The mast climbs, the jib pops out (with a little overshoot) pointing a random way and slews round to the building,
 * then sways on its own rhythm and direction. When struck the crane fades, telescopes down a little and swings clear.
 */
function drawCrane(c: Crane, towerH: number, now: number, p: number, out: Stroke[]) {
  const { b, mx, my, reach } = c
  const { toLonLat, riser, seed } = geom(b)
  const r = (j: number) => rand(seed, SALT_CRANE + c.slot * 8 + j)
  const strike = clamp01((p - STRIKE_START) / (1 - STRIKE_START))
  const alpha = 1 - strike
  const top = towerH * (1 - 0.25 * strike * strike)
  const mastH = top * easeInOut(clamp01(p / MAST_END))
  const color = withAlpha(CRANE, 255 * alpha)
  inked(riser(mx, my, 0, mastH), color, 4, alpha, out)
  if (p < MAST_END) return
  const t = now - b.start + c.phase
  const dir = r(0) < 0.5 ? -1 : 1
  const startOff = dir * (0.8 + 1.6 * r(1)) // radians off the working heading when the jib goes on
  const slewIn = easeOutBack(clamp01((p - MAST_END) / 0.14))
  const sway = dir * (0.4 + 0.3 * r(2)) * Math.sin(t / (780 + 260 * r(3)) + TAU * r(4))
  const toward = Math.atan2(-my, -mx) + startOff * (1 - slewIn) + sway + dir * 0.9 * strike * strike
  const [ux, uy] = [Math.cos(toward), Math.sin(toward)]
  const jib = reach * easeOutBack(clamp01((p - MAST_END) / 0.06))
  const tip = [mx + ux * jib, my + uy * jib]
  const tail = [mx - ux * jib * 0.32, my - uy * jib * 0.32]
  inked([toLonLat(tail[0], tail[1], top), toLonLat(tip[0], tip[1], top)], color, 3, alpha, out)
  // operator's cab under the jib, counterweight on the tail, tie bars from the apex
  inked([toLonLat(mx, my, top - 3), toLonLat(mx + ux * 2.5, my + uy * 2.5, top - 3)], color, 6, alpha, out)
  inked([toLonLat(tail[0], tail[1], top - 1.5), toLonLat(mx - ux * jib * 0.2, my - uy * jib * 0.2, top - 1.5)],
    withAlpha(CABLE, 255 * alpha), 6, alpha, out)
  out.push({ path: [toLonLat(tail[0], tail[1], top), toLonLat(mx, my, top + APEX_M), toLonLat(tip[0], tip[1], top)],
    color: withAlpha(CABLE, 200 * alpha), width: 1 })
  // Trolley rides the jib; the hook line drops to a storey above the rising roof, with a load on it.
  const trolley = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t / (560 + 180 * r(5)) + TAU * r(6)))
  const hx = mx + ux * jib * trolley
  const hy = my + uy * jib * trolley
  const hook = Math.min(top - 2, b.heightM * Math.min(1, riseShare(b, now)) + STOREY_M * 2)
  out.push({ path: riser(hx, hy, top, hook), color: withAlpha(CABLE, 220 * alpha), width: 1 })
  inked([toLonLat(hx - ux * 2, hy - uy * 2, hook), toLonLat(hx + ux * 2, hy + uy * 2, hook)], withAlpha(SCAFFOLD, 255 * alpha), 5, alpha, out)
}

interface Puff {
  position: LonLatZ
  radius: number
  color: Color
}

/** A soft rounded puff: a faint wide halo round the core, so overlapping puffs read as one cloud. */
function puff(position: LonLatZ, radius: number, tone: Rgb, alpha: number, out: Puff[]) {
  if (alpha <= 0 || radius <= 0) return
  out.push({ position, radius: radius * 1.5, color: withAlpha(tone, alpha * 0.3) })
  out.push({ position, radius, color: withAlpha(tone, alpha) })
}

/**
 * Dust kicked up round the falling roof line: puffs at seeded spots that rise, swell, drift out and twist round the
 * footprint, fading in and out on their own cycles.
 */
function dust(b: Build, now: number, p: number, out: Puff[]) {
  if (p < WRAP_END) return
  const { pts, toLonLat, seed } = geom(b)
  const roof = b.heightM * standingShare(b, now)
  const settle = p < FALL_END ? 1 : 1 - (p - FALL_END) / (1 - FALL_END)
  const age = now - b.start
  sample(pts, MAX_PUFFS).forEach(([x, y], i) => {
    const r = (j: number) => rand(seed, SALT_PUFF + i * 8 + j)
    const q = (age / (820 + 300 * r(0)) + r(1)) % 1
    const grow = easeOutCubic(q)
    const turn = (r(2) - 0.5) * 0.5 * grow
    const spread = 1 + grow * (0.25 + 0.2 * r(3))
    const [cos, sin] = [Math.cos(turn), Math.sin(turn)]
    const position = toLonLat((x * cos - y * sin) * spread, (x * sin + y * cos) * spread, roof + grow * (6 + 6 * r(5)))
    puff(position, (4 + 13 * grow) * (0.8 + 0.45 * r(4)), r(6) < 0.5 ? DUST : DUST_LIGHT, 150 * settle * Math.sin(Math.PI * q) ** 0.8, out)
  })
}

/** A new building settles onto its plot with a soft ring of dust spreading out from its base. */
function landing(b: Build, p: number, out: Puff[]) {
  const t = burstT(b, p)
  if (t === null) return
  const { wrap, toLonLat, seed } = geom(b)
  sample(wrap, MAX_LAND_PUFFS).forEach(([x, y], i) => {
    const r = (j: number) => rand(seed, SALT_LAND + i * 8 + j)
    const q = clamp01(t * 1.3 - 0.2 * r(0))
    if (q <= 0 || q >= 1) return
    const grow = easeOutCubic(q)
    const spread = 1.05 + 0.35 * grow
    puff(toLonLat(x * spread, y * spread, 0.5 + 2.5 * grow), (3 + 7 * grow) * (0.8 + 0.4 * r(1)), r(2) < 0.5 ? DUST : DUST_LIGHT,
      130 * (1 - q) ** 2, out)
  })
}

/** Shoelace area of a local ring, m². */
function ringArea(pts: [number, number][]): number {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
  return Math.abs(a) / 2
}

/** Distance from a point to the nearest edge of a local ring, m. */
function edgeDistance(x: number, y: number, pts: [number, number][]): number {
  let d = Infinity
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j]
    const [dx, dy] = [pts[i][0] - ax, pts[i][1] - ay]
    const s = clamp01(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1))
    d = Math.min(d, Math.hypot(x - ax - s * dx, y - ay - s * dy))
  }
  return d
}

function bbox(pts: [number, number][]): [number, number, number, number] {
  const xs = pts.map((q) => q[0])
  const ys = pts.map((q) => q[1])
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
}

/** Area centroid of a local ring (its vertex centroid when the ring has no area). */
function ringCentroid(pts: [number, number][]): [number, number] {
  let [a, cx, cy] = [0, 0, 0]
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const cross = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
    a += cross
    cx += (pts[j][0] + pts[i][0]) * cross
    cy += (pts[j][1] + pts[i][1]) * cross
  }
  if (Math.abs(a) < 1e-9) return [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length]
  return [cx / (3 * a), cy / (3 * a)]
}

interface Fountain {
  x: number
  y: number
  /** Basin radius, m. */
  r: number
}

/** A plot laid out for planting: its frame and seed, tree size and spots and, on a big plot, a fountain. */
interface ParkPlan {
  toLonLat: ToLonLat
  seed: number
  /** Tree size multiplier: big plots grow bigger, more spaced trees, so they read at the zoom that shows them. */
  scale: number
  trees: [number, number][]
  fountain: Fountain | null
}

/**
 * A big plot's fountain: at its centroid when the basin (and a walk round it) fits there, else at the fitting spot
 * nearest the centroid.
 */
function fountainSpot(pts: [number, number][], area: number, scale: number): Fountain | null {
  if (pts.length < 3 || area < FOUNTAIN_MIN_M2) return null
  const r = Math.min(6 * scale, Math.max(4.5, Math.sqrt(area) * 0.09))
  const fits = (x: number, y: number) => pointInRing([x, y], pts) && edgeDistance(x, y, pts) >= r + 2
  const [cx, cy] = ringCentroid(pts)
  if (fits(cx, cy)) return { x: cx, y: cy, r }
  const [x0, x1, y0, y1] = bbox(pts)
  let best: Fountain | null = null
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < 9; j++) {
      const [x, y] = [x0 + ((i + 0.5) / 9) * (x1 - x0), y0 + ((j + 0.5) / 9) * (y1 - y0)]
      if (fits(x, y) && (!best || Math.hypot(x - cx, y - cy) < Math.hypot(best.x - cx, best.y - cy))) best = { x, y, r }
    }
  }
  return best
}

/**
 * Trees on a seeded, loosely jittered grid of about TREE_SPACING_M × `scale` over the plot, kept to points inside it
 * and clear of the fountain.
 */
function treeSpots(pts: [number, number][], seed: number, scale: number, fountain: Fountain | null): [number, number][] {
  if (pts.length < 3) return []
  const [x0, x1, y0, y1] = bbox(pts)
  const cells = (span: number) => Math.min(TREE_GRID_MAX, Math.max(1, Math.round(span / (TREE_SPACING_M * scale))))
  const [nx, ny] = [cells(x1 - x0), cells(y1 - y0)]
  const clear = fountain ? fountain.r + CROWN_R_M * scale * 1.2 + 2.5 : 0
  const spots: [number, number][] = []
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const k = SALT_GRID + (i * TREE_GRID_MAX + j) * 2
      // offset alternate rows and nudge each spot so the planting reads as informal
      const u = (i + 0.5 + (j % 2) * 0.3 + 0.4 * (rand(seed, k) - 0.5)) / nx
      const v = (j + 0.5 + 0.4 * (rand(seed, k + 1) - 0.5)) / ny
      const [x, y] = [x0 + u * (x1 - x0), y0 + v * (y1 - y0)]
      if (!pointInRing([x, y], pts) || edgeDistance(x, y, pts) < TREE_EDGE_M) continue
      if (fountain && Math.hypot(x - fountain.x, y - fountain.y) < clear) continue
      spots.push([x, y])
    }
  }
  return sample(spots, MAX_TREES)
}

/**
 * Lays a plot out in the frame of its longest edge, so a rotated or long, thin plot fills evenly, then turns the tree
 * spots and fountain back into the plot's own frame. Without `fountains`, trees take the whole plot.
 */
function parkPlan(pts: [number, number][], toLonLat: ToLonLat, seed: number, fountains: boolean): ParkPlan {
  const area = ringArea(pts)
  const scale = Math.min(MAX_TREE_SCALE, Math.max(1, Math.sqrt(area) / MATURE_SIDE_M))
  let angle = 0
  let longest = 0
  pts.forEach(([x, y], i) => {
    const [x2, y2] = pts[(i + 1) % pts.length]
    const len = Math.hypot(x2 - x, y2 - y)
    if (len > longest) [longest, angle] = [len, Math.atan2(y2 - y, x2 - x)]
  })
  const [c, s] = [Math.cos(angle), Math.sin(angle)]
  const along = pts.map(([x, y]) => [x * c + y * s, y * c - x * s] as [number, number])
  const back = ([x, y]: [number, number]): [number, number] => [x * c - y * s, x * s + y * c]
  const f = fountains ? fountainSpot(along, area, scale) : null
  const at = f && back([f.x, f.y])
  const fountain = f && at && { x: at[0], y: at[1], r: f.r }
  return { toLonLat, seed, scale, trees: treeSpots(along, seed, scale, f).map(back), fountain }
}

interface Solid {
  /** Base ring(s) at the solid's base height (z); a second ring is a hole. */
  polygon: LonLatZ[] | LonLatZ[][]
  elevation: number
  color: Color
}
interface Flat {
  polygon: LonLatZ[]
  color: Color
}
/** Trees and fountains as drawn: lit solids, flat ground shapes and spray arcs (their droplets are drawn apart). */
interface Decor {
  solids: Solid[]
  flats: Flat[]
  spray: Stroke[]
}

/** A regular n-gon of radius r round (x, y) at height z, turned by `rot`. */
function ngon(toLonLat: ToLonLat, x: number, y: number, r: number, n: number, rot: number, z: number): LonLatZ[] {
  return Array.from({ length: n }, (_, k) => {
    const a = rot + (TAU * k) / n
    return toLonLat(x + Math.cos(a) * r, y + Math.sin(a) * r, z)
  })
}

// Crown tiers, each [base, height] as shares of the crown height and a radius as a share of its widest: a broadleaf
// is narrow at the bottom, widest in the middle and narrow on top (a rounded silhouette); a pine steps in (a cone).
const BROADLEAF: [number, number, number][] = [[0, 0.36, 0.7], [0.2, 0.5, 1], [0.62, 0.38, 0.58]]
const CONIFER: [number, number, number][] = [[0, 0.4, 1], [0.34, 0.38, 0.68], [0.66, 0.34, 0.38]]
// The key light comes from the south-south-west (MapView's LIGHTING), so a tree's ground shade falls north-north-east.
const SHADE_DIR: [number, number] = [0.33, 0.94]
const PAVE_Z_M = 0.4 // flat ground shapes sit just over the park green
const SHADE_Z_M = 0.45

/**
 * Tree `i` of a plan, `t` (0..1) through its pop. It squashes and stretches as it pops (the trunk shoots up tall and
 * thin, then the crown bounces out short and wide) and comes to rest at its own size, shape, shade and lean, swaying
 * through it on the way.
 */
function drawTree(plan: ParkPlan, i: number, t: number, out: Decor) {
  if (t <= 0) return
  const [x, y] = plan.trees[i]
  const { toLonLat, seed } = plan
  const r = (j: number) => rand(seed, SALT_TREE + i * 8 + j)
  const size = (0.8 + 0.4 * r(1)) * plan.scale
  const conifer = r(5) < CONIFER_SHARE
  const w = wobble(t)
  const grow = easeOutBack(clamp01((t - 0.12) / 0.88))
  const trunkH = TRUNK_M * size * (conifer ? 0.7 : 1) * easeOutCubic(t) * (1 + 0.25 * w)
  const crownR = CROWN_R_M * size * (conifer ? 0.8 : 1) * grow * (1 - 0.2 * w)
  const crownH = CROWN_H_M * size * (conifer ? 1.35 : 1) * grow * (1 + 0.3 * w)
  const rot = TAU * r(2)
  const leanAz = TAU * r(3)
  const lean = size * (0.15 + 0.3 * r(6)) * Math.min(1, grow) + 0.6 * wobble(t, 1.5) // metres at the crown top
  const tone = 0.9 + 0.18 * r(4)
  const [base0, top0] = conifer ? [PINE, CROWN] : [CROWN, CROWN_LIGHT]
  const dark = base0.map((c) => Math.min(255, c * tone)) as Rgb
  const light = top0.map((c) => Math.min(255, c * tone)) as Rgb
  const tierColors = [dark, dark.map((c, n) => (c + light[n]) / 2) as Rgb, light]
  out.solids.push({ polygon: ngon(toLonLat, x, y, TRUNK_R_M * size * (1 - 0.15 * w), 6, rot, 0), elevation: trunkH, color: withAlpha(TRUNK, 255) })
  if (crownR <= 0.05 || crownH <= 0.05) return
  const off = crownR * 0.45
  out.flats.push({
    polygon: ngon(toLonLat, x + SHADE_DIR[0] * off, y + SHADE_DIR[1] * off, crownR * 0.95, CROWN_SIDES * 2, rot, SHADE_Z_M),
    color: withAlpha(SHADE, 70 * Math.min(1, grow)),
  })
  const z0 = Math.max(0, trunkH - 0.12 * crownH) // the crown takes in the trunk top
  const tiers = conifer ? CONIFER : BROADLEAF
  tiers.forEach(([base, height, radius], k) => {
    const s = lean * (base + height / 2) // each tier leans out by its height
    out.solids.push({
      polygon: ngon(toLonLat, x + Math.cos(leanAz) * s, y + Math.sin(leanAz) * s, crownR * radius, CROWN_SIDES,
        rot + (k * Math.PI) / CROWN_SIDES, z0 + crownH * base),
      elevation: crownH * height,
      color: withAlpha(tierColors[k], 255),
    })
  })
}

/**
 * A plan's fountain, `t` (0..1) through being built: paving spreads, the basin rim pops up, water fills it, the column
 * and its bowl rise and the jet starts (`spray` 0..1), throwing SPRAY_ARCS arcs into the basin; `arc(k, u)` is the
 * point u (0..1) along arc k. Null without a fountain or before it starts.
 */
function fountainStages(plan: ParkPlan, t: number) {
  const f = plan.fountain
  if (!f || t <= 0) return null
  const { toLonLat, scale } = plan
  const rot = TAU * rand(plan.seed, SALT_FOUNTAIN)
  const water = easeOutCubic(clamp01((t - 0.3) / 0.3))
  const c = easeOutBack(clamp01((t - 0.35) / 0.35), 1.4) * scale // the column and bowl, sized with the park's trees
  const spray = easeOutCubic(clamp01((t - 0.65) / 0.35))
  const zBowl = COLUMN_H_M * c
  const zJet = zBowl + BOWL_H_M * c
  const zTop = zJet + JET_M * scale * spray
  const zWater = WATER_H_M * water
  const inner = f.r - BASIN_RIM_M
  const reach = inner * 0.8
  const peak = SPRAY_PEAK_M * scale
  return {
    f,
    rot,
    pave: easeOutCubic(clamp01(t / 0.3)),
    basin: easeOutBack(clamp01((t - 0.1) / 0.35), 1.4),
    water,
    c,
    zBowl,
    zJet,
    inner,
    spray,
    // from the jet top, up by `peak` and out into the basin
    arc: (k: number, u: number) => {
      const az = rot + (TAU * k) / SPRAY_ARCS
      return toLonLat(f.x + Math.cos(az) * reach * u, f.y + Math.sin(az) * reach * u, zTop + (zWater - zTop) * u + 4 * peak * u * (1 - u))
    },
  }
}

/** A plan's fountain, `t` (0..1) through being built (fountainStages), with its spray arcs but not their droplets. */
function drawFountain(plan: ParkPlan, t: number, out: Decor) {
  const st = fountainStages(plan, t)
  if (!st) return
  const { f, rot, c, zBowl, zJet, inner, spray, arc } = st
  const disc = (r: number, z: number, n = BASIN_SIDES) => ngon(plan.toLonLat, f.x, f.y, r, n, rot, z)
  const solid = (polygon: Solid['polygon'], elevation: number, color: Rgb) => {
    if (elevation > 0.02) out.solids.push({ polygon, elevation, color: withAlpha(color, 255) })
  }
  out.flats.push({ polygon: disc((f.r + 1.4) * st.pave, PAVE_Z_M), color: withAlpha(PAVING, 255 * st.pave) })
  solid([disc(f.r, 0), disc(inner, 0)], BASIN_H_M * st.basin, STONE)
  solid(disc(inner, 0), WATER_H_M * st.water, WATER)
  // a column carrying a shallow bowl (rim and water), the jet rising from it
  solid(disc(0.42 * plan.scale, 0, 8), zBowl, STONE)
  solid([disc(1.5 * c, zBowl, 12), disc(1.2 * c, zBowl, 12)], BOWL_H_M * c, STONE)
  solid(disc(1.2 * c, zBowl, 12), BOWL_H_M * 0.75 * c, WATER)
  solid(disc(0.13 * plan.scale, zJet, 6), JET_M * plan.scale * spray, SPRAY)
  if (spray <= 0) return
  for (let k = 0; k < SPRAY_ARCS; k++) {
    out.spray.push({ path: Array.from({ length: 8 }, (_, s) => arc(k, (spray * s) / 7)), color: withAlpha(SPRAY, 200 * spray), width: 2 })
  }
}

/**
 * The droplets riding a plan's fountain spray, `t` (0..1) through being built: SPRAY_DROPS per arc, each taking
 * SPRAY_MS from jet to basin at `now`; with `now` null they hold still along the arcs.
 */
function drawDrops(plan: ParkPlan, t: number, now: number | null, out: Puff[]) {
  const st = fountainStages(plan, t)
  if (!st || st.spray <= 0) return
  for (let k = 0; k < SPRAY_ARCS; k++) {
    for (let d = 0; d < SPRAY_DROPS; d++) {
      const phase = (d + 0.5) / SPRAY_DROPS
      const u = now === null ? phase : (now / SPRAY_MS + phase + rand(plan.seed, SALT_FOUNTAIN + 1 + k)) % 1
      if (u > st.spray) continue
      out.push({ position: st.arc(k, u), radius: 2.2, color: withAlpha(SPRAY, 245 * st.spray) })
    }
  }
}

function dropsLayer(id: string, drops: Puff[]): Layer {
  return new ScatterplotLayer<Puff>({
    id,
    data: drops,
    getPosition: (p) => p.position,
    getRadius: (p) => p.radius,
    radiusUnits: 'pixels',
    getFillColor: (p) => p.color,
    billboard: true,
    pickable: false,
    parameters: { depthWriteEnabled: false },
  })
}

/** Draws a Decor: ground shapes, then the lit solids, then the spray arcs. Layer ids start with `id`. */
function decorLayers(id: string, d: Decor): Layer[] {
  return [
    new SolidPolygonLayer<Flat>({
      id: `${id}-ground`,
      data: d.flats,
      getPolygon: (f) => f.polygon,
      getFillColor: (f) => f.color,
      pickable: false,
      parameters: { depthWriteEnabled: false },
    }),
    new SolidPolygonLayer<Solid>({
      id: `${id}-solids`,
      data: d.solids,
      extruded: true,
      getPolygon: (s) => s.polygon,
      getElevation: (s) => s.elevation,
      getFillColor: (s) => s.color,
      material: MATTE,
      pickable: false,
    }),
    new PathLayer<Stroke>({
      id: `${id}-spray`,
      data: d.spray,
      getPath: (s) => s.path,
      getColor: (s) => s.color,
      getWidth: (s) => s.width,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      pickable: false,
      parameters: { depthWriteEnabled: false },
    }),
  ]
}

/**
 * Trees and, on a big plot and unless `fountains` is false, a fountain (its droplets still) for each plot, fully grown
 * and still: the planting a new park comes to rest at, laid out from each plot's `key` so it stays put. Layer ids
 * start with `id`.
 */
export function parkDecorLayers(
  id: string,
  plots: { key: string; ring: [number, number][] }[],
  { fountains = true }: { fountains?: boolean } = {},
): Layer[] {
  const d: Decor = { solids: [], flats: [], spray: [] }
  const drops: Puff[] = []
  for (const { key, ring } of plots) {
    const { pts, toLonLat } = localFrame(ring)
    const plan = parkPlan(pts, toLonLat, hashKey(key), fountains)
    plan.trees.forEach((_, i) => drawTree(plan, i, 1, d))
    drawFountain(plan, 1, d)
    drawDrops(plan, 1, null, drops)
  }
  return [...decorLayers(id, d), dropsLayer(`${id}-drops`, drops)]
}

/** A park build's planting, laid out once from its footprint (a big one gets a fountain). */
function parkPlanOf(b: Build): ParkPlan {
  const g = geom(b)
  return (g.park ??= parkPlan(g.pts, g.toLonLat, g.seed, true))
}

/** How far through building its fountain a park is, at `p` through its timeline. */
const fountainT = (p: number) => clamp01((p - FOUNTAIN_START) / (FOUNTAIN_END - FOUNTAIN_START))

/**
 * A new park: the green spreads out from the middle with a little spring, then its trees pop up one after another
 * and its fountain is built (and they stay). The fountain's droplets are fountainDropsLayer's.
 */
function park(b: Build, p: number, grass: { polygon: LonLatZ[]; color: Color }[], decor: Decor) {
  const { pts, toLonLat, seed } = geom(b)
  if (p < 1) {
    const t = clamp01(p / GREEN_END)
    const s = easeOutBack(t, RISE_SPRING)
    grass.push({ polygon: pts.map(([x, y]) => toLonLat(x * s, y * s, 0.3)), color: withAlpha(GRASS, 200 * Math.min(1, t * 1.5)) })
  }
  const plan = parkPlanOf(b)
  const stagger = Math.min(TREE_STAGGER, TREE_SPREAD / Math.max(1, plan.trees.length))
  plan.trees.forEach((_, i) => {
    drawTree(plan, i, clamp01((p - TREE_START - i * stagger - 0.05 * rand(seed, SALT_TREE + i * 8)) / TREE_POP), decor)
  })
  drawFountain(plan, fountainT(p), decor)
}

/** Where a park build's fountain stands ([lon, lat]); null for any other build or a park too small for one. */
export function fountainAt(b: Build): [number, number] | null {
  if (b.kind !== 'park') return null
  const { fountain: f, toLonLat } = parkPlanOf(b)
  if (!f) return null
  const [lon, lat] = toLonLat(f.x, f.y, 0)
  return [lon, lat]
}

/**
 * The droplets of every new park's fountain at `now`, riding its spray arcs for as long as the park stands (still
 * with reduced motion). Its own layer, so MapView can redraw just this one on a light clock once the parks are done.
 */
export function fountainDropsLayer(builds: Iterable<Build>, now: number): Layer {
  const drops: Puff[] = []
  for (const b of builds) {
    if (b.kind !== 'park') continue
    const p = progress(b, now)
    if (p > 0) drawDrops(parkPlanOf(b), fountainT(p), REDUCED_MOTION ? null : now, drops)
  }
  return dropsLayer('construction-park-drops', drops)
}

interface Dot extends Puff {
  line: Color
}

/**
 * A twinkling four-point star in the camera's picture plane (the camera looks north-west, so north-east runs across
 * the screen), turned by `rot`. Its near-vertical arm leans towards the camera so deck gives it width.
 */
function star(g: Geom, x: number, y: number, z: number, arm: number, rot: number, color: Color, alpha: number, out: Stroke[]) {
  for (const k of [0, 1]) {
    const th = rot + (k * Math.PI) / 2
    const across = Math.cos(th) * arm * Math.SQRT1_2
    const up = Math.sin(th) * arm * 1.6 // verticals read short in the iso view
    inked([g.toLonLat(x - across, y - across, z - up), g.toLonLat(x + across + LEAN_M, y + across - LEAN_M, z + up)], color, 2, alpha, out)
  }
}

/**
 * The closing burst over a finished build at height `z`: confetti in the theme colours (leafy ones for a park) pops up
 * and out at a seeded yaw, tumbles and drifts down, and a few stars twinkle and spin; all faded out by the end.
 */
function celebrate(b: Build, p: number, z: number, dots: Dot[], strokes: Stroke[]) {
  const t = burstT(b, p)
  if (t === null) return
  const g = geom(b)
  const { toLonLat, radius, seed } = g
  const palette = b.kind === 'park' ? LEAVES : CONFETTI
  const yaw = TAU * rand(seed, SALT_BURST)
  const reachM = Math.min(22, Math.max(6, radius * 0.7))
  const fade = 1 - t * t
  for (let i = 0; i < MAX_CONFETTI; i++) {
    const r = (j: number) => rand(seed, SALT_BURST + 8 + i * 8 + j)
    const az = yaw + (TAU * i) / MAX_CONFETTI + (r(0) - 0.5) * 0.6
    const d = reachM * (0.5 + 0.6 * r(1)) * easeOutCubic(t)
    const h = z + (6 + 8 * r(2)) * (2.2 * t - 1.9 * t * t)
    const flutter = 0.75 + 0.25 * Math.cos(t * (10 + 8 * r(3)) + TAU * r(4))
    const a = 255 * fade
    dots.push({
      position: toLonLat(Math.cos(az) * d, Math.sin(az) * d, h),
      radius: (2 + 1.8 * r(5)) * flutter * Math.min(1, t * 8),
      color: withAlpha(palette[(i + (seed % palette.length)) % palette.length], a),
      line: withAlpha(CABLE, a * 0.7),
    })
  }
  const arm0 = Math.min(8, Math.max(3, radius * 0.2))
  for (let i = 0; i < MAX_SPARKS; i++) {
    const r = (j: number) => rand(seed, SALT_SPARK + i * 8 + j)
    const s = clamp01((t - 0.08 - (0.45 * i) / MAX_SPARKS - 0.08 * r(0)) / 0.42)
    if (s <= 0 || s >= 1) continue
    const az = yaw + Math.PI / 4 + (TAU * i) / MAX_SPARKS + (r(1) - 0.5) * 0.8
    const d = radius * (0.4 + 0.5 * r(2))
    const arm = arm0 * (0.8 + 0.5 * r(3)) * Math.sin(Math.PI * s)
    const rot = TAU * r(4) + (r(5) - 0.5) * 3 * s
    const alpha = Math.sin(Math.PI * s)
    star(g, Math.cos(az) * d, Math.sin(az) * d, z + 3 + 8 * r(6), arm, rot, withAlpha(i % 2 ? PAPER : MUSTARD, 255 * alpha), alpha, strokes)
  }
}

/**
 * Cranes, scaffolding, dust, park planting and closing bursts for every build under way (parks keep their trees and
 * fountain once done); empty layers when nothing is. Fountain droplets are fountainDropsLayer's.
 */
export function constructionLayer(builds: Iterable<Build>, now: number): Layer[] {
  const strokes: Stroke[] = []
  const cranes: Crane[] = []
  const puffs: Puff[] = []
  const decor: Decor = { solids: [], flats: [], spray: [] }
  const dots: Dot[] = []
  const grass: { polygon: LonLatZ[]; color: Color }[] = []
  for (const b of builds) {
    const p = progress(b, now)
    if (b.kind === 'park') {
      if (p > 0) park(b, p, grass, decor)
      celebrate(b, p, TRUNK_M + CROWN_H_M, dots, strokes)
      continue
    }
    if (p <= 0 || p >= 1) continue
    if (b.kind === 'new') {
      const roof = b.heightM * Math.min(1, riseShare(b, now))
      // the scaffold runs a storey ahead of the rising floors, then is struck with the crane
      const top = Math.min(b.heightM, roof + STOREY_M)
      scaffold(b, p < RISE_START ? STOREY_M : top, p < STRIKE_START ? 1 : 1 - (p - STRIKE_START) / (1 - STRIKE_START), strokes)
      cranes.push(...cranesFor(b))
      landing(b, p, puffs)
      celebrate(b, p, b.heightM, dots, strokes)
    } else if (b.kind === 'convert') {
      paintWipe(b, p, strokes)
      celebrate(b, p, b.heightM, dots, strokes)
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
    ...decorLayers('construction-park', decor),
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
    new ScatterplotLayer<Dot>({
      id: 'construction-confetti',
      data: dots,
      getPosition: (d) => d.position,
      getRadius: (d) => d.radius,
      radiusUnits: 'pixels',
      getFillColor: (d) => d.color,
      stroked: true,
      getLineColor: (d) => d.line,
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      billboard: true,
      pickable: false,
      parameters: { depthWriteEnabled: false },
    }),
  ]
}
