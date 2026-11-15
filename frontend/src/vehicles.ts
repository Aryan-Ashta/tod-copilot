// Little buses and trains running along transit lines (the Transit network agent's focus). Decoration only: speeds,
// sizes and spacing are visual constants; the only plan input is each line's headway, which sets how many vehicles
// a line gets (frequent lines run more). Lines are clipped to the locale's frame (feed lines run tens of km out of
// it); a run that ends at the frame edge carries traffic both ways that shrinks in and out there, a run that ends at a
// real terminal ping-pongs with a dwell (buses U-turn, trains cross over), and a closed run loops.
//
// Everything that does not move is precomputed: runs as typed arrays in a local metre frame with cumulative lengths,
// vehicle outlines as templates. Each frame only rewrites the vehicles' ring coordinates in place and re-tessellates
// them. Vehicles grow as the map zooms out (toy proportions: wider sooner than longer) so they stay readable over the
// drawn lines.
import { SolidPolygonLayer } from '@deck.gl/layers'
import type { Color, Layer, UpdateParameters } from '@deck.gl/core'
import type { BBox } from './geo'
import { MATTE } from './mapLayers'
import type { Geometry, LonLat } from './types'

export interface VehicleLine {
  key: string
  mode: 'rail' | 'bus'
  geometry: Geometry
  color: Color
  headwayMin: number | null
  /** Proposed and not on the map yet: drawn see-through. */
  ghost: boolean
}

export interface Fleet {
  /** Vehicle layers at clock `ms` (performance.now()). */
  at: (ms: number) => Layer[]
}

// ---------------------------------------------------------------- visual constants (not planning figures)

const M_PER_DEG_LAT = 111_320 // unit conversion
const M_PER_PX_Z0 = 78_271.52 // metres per pixel at zoom 0 on the equator, 512 px world (unit conversion)
const SPEED_M_S = { bus: 26, rail: 38 }
/** Gap between a line's vehicles per minute of headway. */
const SPACING_M_PER_HEADWAY_MIN = 220
const DEFAULT_HEADWAY_MIN = 30
const MAX_PER_LINE = 6
const MAX_VEHICLES = 150
/** The frame grows by this much each way before clipping, so traffic leaves the view rather than ending at its edge. */
const FRAME_PAD_M = 250
/** Runs shorter than this get no vehicles. */
const MIN_RUN_M = 160
/** Ping-pong runs: distance to reach cruise speed, dwell at each end. */
const ACCEL_M = 45
const DWELL_S = { bus: 2.6, rail: 3.2 }
/** Through runs: vehicles grow from / shrink to nothing over this distance at the run's ends. */
const FADE_M = 45
/** Runs whose ends lie this close together loop. */
const LOOP_GAP_M = 40
/** Vehicles are never drawn smaller than this many times life size. */
const MIN_SCALE = 1.8
/** Below this zoom vehicles stop growing. */
const MIN_ZOOM = 14

interface Part {
  /** (forward, left) outline in life-size metres, closed, counter-clockwise. */
  tpl: Float64Array
  z: number
  h: number
  /** Body colour mixed this much toward white. */
  tint: number
}

interface Shape {
  carLen: number
  wid: number
  /** Distance between consecutive cars' centres. */
  pitch: number
  /** Centre offset to the right of travel, so the two directions keep apart. */
  lat: number
  /** Smallest on-screen car length and width, pixels. */
  minPxLen: number
  minPxWid: number
  parts: Part[]
}

const CORNER_SEGS = 3

function roundedRect(len: number, wid: number, r: number): Float64Array {
  const hx = len / 2 - r
  const hy = wid / 2 - r
  const corners: [number, number, number][] = [
    [hx, -hy, -Math.PI / 2],
    [hx, hy, 0],
    [-hx, hy, Math.PI / 2],
    [-hx, -hy, Math.PI],
  ]
  const out = new Float64Array((corners.length * (CORNER_SEGS + 1) + 1) * 2)
  let k = 0
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= CORNER_SEGS; i++) {
      const a = a0 + (i / CORNER_SEGS) * (Math.PI / 2)
      out[k++] = cx + r * Math.cos(a)
      out[k++] = cy + r * Math.sin(a)
    }
  }
  out[k++] = out[0]
  out[k++] = out[1]
  return out
}

/** Body in the line colour, a pale window band standing just proud of it, a lighter roof. */
function shape(len: number, wid: number, height: number, r: number, gap: number, minPxLen: number, minPxWid: number): Shape {
  return {
    carLen: len,
    wid,
    pitch: len + gap,
    lat: wid * 0.72,
    minPxLen,
    minPxWid,
    parts: [
      { tpl: roundedRect(len, wid, r), z: 0.35, h: height - 0.35, tint: 0 },
      { tpl: roundedRect(len + 0.12, wid + 0.12, r + 0.06), z: height - 1.55, h: 0.85, tint: 0.78 },
      { tpl: roundedRect(len - 1.4, wid - 0.8, Math.max(0.2, r - 0.4)), z: height, h: 0.2, tint: 0.4 },
    ],
  }
}

const BUS = shape(12, 2.6, 3.2, 0.9, 0, 13, 4)
const CAR = shape(20, 2.9, 3.6, 1.1, 1.4, 11, 4.5)

// ---------------------------------------------------------------- runs

type RunMode = 'through' | 'pingpong' | 'loop'

interface Run {
  /** x, y pairs in the local metre frame. */
  xy: Float64Array
  cum: Float64Array
  len: number
  mode: RunMode
}

interface Frame {
  lon0: number
  lat0: number
  kx: number
}

/** Liang–Barsky: the part [t0, t1] of segment a→b inside the box, or null. */
function clip(ax: number, ay: number, bx: number, by: number, box: BBox): [number, number] | null {
  const dx = bx - ax
  const dy = by - ay
  let t0 = 0
  let t1 = 1
  const edges: [number, number][] = [
    [-dx, ax - box[0]],
    [dx, box[2] - ax],
    [-dy, ay - box[1]],
    [dy, box[3] - ay],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null
    } else {
      const t = q / p
      if (p < 0) t0 = Math.max(t0, t)
      else t1 = Math.min(t1, t)
    }
  }
  return t0 < t1 ? [t0, t1] : null
}

function toRun(pts: number[], clippedStart: boolean, clippedEnd: boolean): Run | null {
  const xy = Float64Array.from(pts)
  const n = xy.length / 2
  const cum = new Float64Array(n)
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xy[2 * i] - xy[2 * i - 2], xy[2 * i + 1] - xy[2 * i - 1])
  const len = cum[n - 1]
  if (len < MIN_RUN_M) return null
  const closed = Math.hypot(xy[0] - xy[2 * n - 2], xy[1] - xy[2 * n - 1]) < LOOP_GAP_M
  const mode: RunMode = !clippedStart && !clippedEnd && closed ? 'loop' : clippedStart && clippedEnd ? 'through' : 'pingpong'
  return { xy, cum, len, mode }
}

/** Line parts of a (Multi)LineString. */
const lineParts = (g: Geometry): LonLat[][] =>
  g.type === 'LineString' ? [g.coordinates as LonLat[]] : g.type === 'MultiLineString' ? (g.coordinates as LonLat[][]) : []

/** A line's parts inside the (padded) box, in local metres. */
function runsOf(g: Geometry, f: Frame, box: BBox | null): Run[] {
  const runs: Run[] = []
  for (const line of lineParts(g)) {
    let pts: number[] | null = null
    let clippedStart = false
    const flush = (clippedEnd: boolean) => {
      const r = pts && toRun(pts, clippedStart, clippedEnd)
      if (r) runs.push(r)
      pts = null
    }
    for (let i = 1; i < line.length; i++) {
      const ax = (line[i - 1][0] - f.lon0) * f.kx
      const ay = (line[i - 1][1] - f.lat0) * M_PER_DEG_LAT
      const bx = (line[i][0] - f.lon0) * f.kx
      const by = (line[i][1] - f.lat0) * M_PER_DEG_LAT
      const t = box ? clip(ax, ay, bx, by, box) : ([0, 1] as [number, number])
      if (!t) {
        if (pts) flush(true)
        continue
      }
      const [t0, t1] = t
      if (!pts || t0 > 0) {
        if (pts) flush(true)
        pts = [ax + (bx - ax) * t0, ay + (by - ay) * t0]
        clippedStart = t0 > 0 || i > 1
      }
      pts.push(ax + (bx - ax) * t1, ay + (by - ay) * t1)
      if (t1 < 1) flush(true)
    }
    if (pts) flush(false)
  }
  return runs
}

// ---------------------------------------------------------------- vehicles

interface Ring {
  ring: Float64Array
  h: number
  color: Color
}

interface Vehicle {
  run: Run
  shape: Shape
  cars: number
  speed: number
  dwell: number
  /** Ping-pong runs: the centre's distance from either end when it stops there. */
  margin: number
  /** Seconds added to the clock. */
  phase: number
  /** Through runs: +1 runs with the geometry, −1 against it. */
  dir: 1 | -1
  /** cars × parts rings, written each frame. */
  rings: Ring[]
}

/** Per-frame drawing scale of a shape: along its length, and across (width and height). */
interface Scale {
  len: number
  wid: number
}

const mix = (c: Color, t: number): Color => [
  Math.round(c[0] + (255 - c[0]) * t),
  Math.round(c[1] + (255 - c[1]) * t),
  Math.round(c[2] + (255 - c[2]) * t),
]

// scratch for pointAt
let PX = 0
let PY = 0
let TX = 1
let TY = 0

/** Point `s` metres along the run (clamped) into PX/PY, with the segment direction into TX/TY. */
function pointAt(r: Run, s: number) {
  const { cum, xy } = r
  if (s <= 0) s = 0
  else if (s >= r.len) s = r.len
  let lo = 1
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] < s) lo = mid + 1
    else hi = mid
  }
  const seg = cum[lo] - cum[lo - 1]
  const f = seg > 0 ? (s - cum[lo - 1]) / seg : 0
  const ax = xy[2 * lo - 2]
  const ay = xy[2 * lo - 1]
  const dx = xy[2 * lo] - ax
  const dy = xy[2 * lo + 1] - ay
  PX = ax + dx * f
  PY = ay + dy * f
  if (seg > 0) {
    TX = dx / seg
    TY = dy / seg
  }
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x))
const mod = (a: number, n: number) => ((a % n) + n) % n

/** Distance covered `t` seconds into a ping-pong leg of length `d`: ease out of the stop, cruise, ease into the next. */
function legDistance(t: number, d: number, v: number): number {
  const a = Math.min(ACCEL_M, d / 2)
  const ta = (2 * a) / v
  const tc = (d - 2 * a) / v
  if (t < ta) return a * (t / ta) ** 2
  if (t < ta + tc) return a + v * (t - ta)
  const r = Math.max(0, 2 * ta + tc - t)
  return d - a * (r / ta) ** 2
}

/** Seconds a ping-pong leg of length `d` takes at cruise speed `v` (the two easings each cost half their distance). */
const legTime = (d: number, v: number) => d / v + (2 * Math.min(ACCEL_M, d / 2)) / v

/** Life-size length of a vehicle of `cars` cars. */
const vehicleLen = (sh: Shape, cars: number) => (cars - 1) * sh.pitch + sh.carLen

/** Through runs: how far past each end a vehicle's centre travels, so it has shrunk away before it wraps. */
const throughMargin = (sh: Shape, cars: number) => (vehicleLen(sh, cars) * MIN_SCALE) / 2 + FADE_M

function place(v: Vehicle, ms: number, sc: Scale, f: Frame) {
  const { run, shape: sh, cars, speed } = v
  const len = run.len
  const loop = run.mode === 'loop'
  const t = ms / 1000 + v.phase
  // the vehicle's centre in travel coordinates, its direction along the geometry, U-turn angle and side of the line
  let dir: 1 | -1 = v.dir
  let centre: number
  let turn = 0
  let side = 1
  if (loop) {
    centre = (t * speed) % len
    dir = 1
  } else if (run.mode === 'through') {
    const e = throughMargin(sh, cars)
    centre = ((t * speed) % (len + 2 * e)) - e
  } else {
    const d = len - 2 * v.margin
    const leg = legTime(d, speed)
    let u = t % (2 * (leg + v.dwell))
    dir = 1
    if (u >= leg + v.dwell) {
      u -= leg + v.dwell
      dir = -1
    }
    if (u < leg) centre = v.margin + legDistance(u, d, speed)
    else {
      // at the far end: buses swing round, trains cross over to the other track
      centre = len - v.margin
      const e = smooth((u - leg) / v.dwell / 0.6 - 0.33)
      if (cars === 1) turn = Math.PI * e
      else side = 1 - 2 * e
    }
  }
  const pitch = sh.pitch * sc.len
  const half = (sh.carLen * sc.len) / 2
  const lat = sh.lat * sc.wid * side
  const cs = Math.cos(turn)
  const sn = Math.sin(turn)
  let k = 0
  for (let c = 0; c < cars; c++) {
    const mid = centre + ((cars - 1) / 2 - c) * pitch
    const grow = run.mode === 'through' ? smooth(Math.min(mid, len - mid) / FADE_M) : 1
    const sF = loop ? mod(mid + half, len) : Math.min(len, Math.max(0, mid + half))
    const sR = loop ? mod(mid - half, len) : Math.min(len, Math.max(0, mid - half))
    // travel coordinates → along the geometry
    pointAt(run, dir > 0 ? sF : len - sF)
    const fx = PX
    const fy = PY
    pointAt(run, dir > 0 ? sR : len - sR)
    let ux = fx - PX
    let uy = fy - PY
    const ul = Math.hypot(ux, uy)
    if (ul > 1e-6) {
      ux /= ul
      uy /= ul
    } else {
      ux = TX * dir
      uy = TY * dir
    }
    if (turn) {
      const rx = ux * cs - uy * sn
      uy = ux * sn + uy * cs
      ux = rx
    }
    // keep right
    const cx = (fx + PX) / 2 + uy * lat
    const cy = (fy + PY) / 2 - ux * lat
    const sl = sc.len * grow
    const sw = sc.wid * grow
    for (const p of sh.parts) {
      const r = v.rings[k++]
      const { tpl } = p
      const out = r.ring
      const z = p.z * sw
      for (let i = 0, j = 0; i < tpl.length; i += 2, j += 3) {
        const a = tpl[i] * sl
        const b = tpl[i + 1] * sw
        out[j] = f.lon0 + (cx + a * ux - b * uy) / f.kx
        out[j + 1] = f.lat0 + (cy + a * uy + b * ux) / M_PER_DEG_LAT
        out[j + 2] = z
      }
      r.h = p.h * sw
    }
  }
}

/** Small deterministic hash → [0, 1), so a line's vehicles keep their places across rebuilds. */
function unit(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

// ---------------------------------------------------------------- layer

/** What a fleet's layers share: places every vehicle for a clock and zoom, and the zoom each layer last built at. */
interface Placer {
  place: (ms: number, zoom: number) => void
  zooms: Map<string, number>
}

/**
 * Vehicle polygons placed for the map's current zoom. Every update places the vehicles (for the clock in `time`) and
 * re-tessellates the rings in place; a draw at a zoom the rings were not built for asks for that update, so the
 * vehicles resize as the map zooms even when nothing animates (reduced motion).
 */
class VehicleLayer extends SolidPolygonLayer<Ring, { placer: Placer; time: number }> {
  static layerName = 'VehicleLayer'

  updateState(params: UpdateParameters<this>) {
    const zoom = this.context.viewport.zoom
    this.props.placer.place(this.props.time, zoom)
    this.props.placer.zooms.set(this.id, zoom)
    const flags = params.changeFlags
    const triggers: Record<string, true> = { ...(flags.updateTriggersChanged || {}), getPolygon: true }
    super.updateState({ ...params, changeFlags: { ...flags, updateTriggersChanged: triggers } })
  }

  draw(opts: Parameters<SolidPolygonLayer['draw']>[0]) {
    if (this.props.placer.zooms.get(this.id) !== this.context.viewport.zoom) this.setNeedsUpdate()
    super.draw(opts)
  }
}

/** Vehicles for the lines, or null when none of them runs inside the frame. */
export function transitFleet(id: string, lines: VehicleLine[], frame: BBox | null): Fleet | null {
  const start = lines.flatMap((l) => lineParts(l.geometry))[0]?.[0]
  if (!start) return null
  const [lon0, lat0] = frame ? [(frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2] : start
  const f: Frame = { lon0, lat0, kx: M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180) }
  const box: BBox | null = frame && [
    (frame[0] - lon0) * f.kx - FRAME_PAD_M,
    (frame[1] - lat0) * M_PER_DEG_LAT - FRAME_PAD_M,
    (frame[2] - lon0) * f.kx + FRAME_PAD_M,
    (frame[3] - lat0) * M_PER_DEG_LAT + FRAME_PAD_M,
  ]

  // rail first, then proposed service, then the most frequent lines
  const headway = (l: VehicleLine) => l.headwayMin ?? DEFAULT_HEADWAY_MIN
  const rank = (l: VehicleLine) => (l.mode === 'rail' ? 0 : l.ghost ? 1 : 2)
  const order = lines
    .map((l) => ({ l, runs: runsOf(l.geometry, f, box).sort((a, b) => b.len - a.len) }))
    .filter((x) => x.runs.length)
    .sort((a, b) => rank(a.l) - rank(b.l) || headway(a.l) - headway(b.l))

  const solid: Ring[] = []
  const ghost: Ring[] = []
  const vehicles: Vehicle[] = []
  let budget = MAX_VEHICLES
  for (const { l, runs } of order) {
    if (budget <= 0) break
    const spacing = SPACING_M_PER_HEADWAY_MIN * Math.max(1, headway(l))
    const rail = l.mode === 'rail'
    const sh = rail ? CAR : BUS
    const speed = rail ? SPEED_M_S.rail : SPEED_M_S.bus
    const dwell = rail ? DWELL_S.rail : DWELL_S.bus
    const colors = sh.parts.map((p) => mix(l.color, p.tint))
    const lineBudget = Math.min(MAX_PER_LINE, budget)
    const seed = unit(l.key)
    let used = 0
    runs.forEach((run, ri) => {
      const cars = rail ? (run.len > 3 * vehicleLen(CAR, 3) ? 3 : 2) : 1
      const margin = (vehicleLen(sh, cars) * MIN_SCALE) / 2
      if (run.mode === 'pingpong' && run.len - 2 * margin < ACCEL_M) return
      const room = lineBudget - used
      if (room <= 0) return
      const want = Math.ceil((run.mode === 'loop' ? run.len : 2 * run.len) / spacing)
      // every line shows at least one vehicle, on its longest run
      const n = Math.min(room, Math.max(ri === 0 ? 1 : 0, want))
      for (let i = 0; i < n; i++) {
        let phase: number
        let dir: 1 | -1 = 1
        if (run.mode === 'through') {
          // alternate directions; each direction's vehicles evenly spaced
          dir = (i + Math.floor(seed * 2)) % 2 === 0 ? 1 : -1
          const per = Math.ceil((n - (i % 2)) / 2)
          phase = ((Math.floor(i / 2) / per + seed) * (run.len + 2 * throughMargin(sh, cars))) / speed
        } else if (run.mode === 'loop') {
          phase = ((i / n + seed) * run.len) / speed
        } else {
          phase = (i / n + seed) * 2 * (legTime(run.len - 2 * margin, speed) + dwell)
        }
        const rings: Ring[] = []
        for (let c = 0; c < cars; c++) {
          sh.parts.forEach((p, pi) => rings.push({ ring: new Float64Array((p.tpl.length / 2) * 3), h: 0, color: colors[pi] }))
        }
        ;(l.ghost ? ghost : solid).push(...rings)
        vehicles.push({ run, shape: sh, cars, speed, dwell, margin, phase, dir, rings })
      }
      used += n
    })
    budget -= used
  }
  if (!vehicles.length) return null

  const busScale: Scale = { len: 1, wid: 1 }
  const carScale: Scale = { len: 1, wid: 1 }
  const fit = (sc: Scale, sh: Shape, mpp: number) => {
    sc.len = Math.max(MIN_SCALE, (sh.minPxLen * mpp) / sh.carLen)
    sc.wid = Math.max(MIN_SCALE, (sh.minPxWid * mpp) / sh.wid)
  }
  const cosLat = Math.cos((lat0 * Math.PI) / 180)
  let placedAt = NaN
  let placedZoom = NaN
  const placer: Placer = {
    zooms: new Map(),
    place(ms, zoom) {
      if (ms === placedAt && zoom === placedZoom) return
      placedAt = ms
      placedZoom = zoom
      const mpp = (M_PER_PX_Z0 * cosLat) / 2 ** Math.max(MIN_ZOOM, zoom)
      fit(busScale, BUS, mpp)
      fit(carScale, CAR, mpp)
      for (const v of vehicles) place(v, ms, v.shape === BUS ? busScale : carScale, f)
    },
  }

  const layer = (suffix: string, data: Ring[], ms: number, see: boolean) =>
    new VehicleLayer({
      id: `${id}_${suffix}`,
      data,
      placer,
      time: ms,
      extruded: true,
      pickable: false,
      material: MATTE,
      _normalize: false,
      _windingOrder: 'CCW',
      getPolygon: (r) => r.ring,
      getElevation: (r) => r.h,
      getFillColor: (r) => r.color,
      opacity: see ? 0.5 : 1,
      // see-through vehicles must not hide one another's far sides
      ...(see ? { parameters: { depthWriteEnabled: false } } : {}),
    })

  return {
    at(ms) {
      const out: Layer[] = []
      if (solid.length) out.push(layer('solid', solid, ms, false))
      if (ghost.length) out.push(layer('ghost', ghost, ms, true))
      return out
    },
  }
}
