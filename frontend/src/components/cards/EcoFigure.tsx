// The sustainability & health targets of the agents' plan as one paper/iso infographic. Every value printed is a target
// from the plan (backend/models/targets.py), its factors on hover; pictograms are those values counted out in steps
// the caption names. Transport CO2 shows as cars only when the plan's own factors convert the tonnes back to the
// households it counts (the exact inverse of targets.transport_co2); otherwise as stacked CO2 cubes.
import { memo, useId, type CSSProperties, type ReactNode, type SVGProps } from 'react'
import { IsoBox, IsoFloors, IsoTile, ISO, project, type BoxGeom, type Pt } from '../../iso'
import { REDUCED_MOTION } from '../../construction'
import { fmtNum } from '../../format'
import { useApp } from '../../state/AppContext'
import FactorHover from '../FactorHover'
import { TARGET_LABELS } from '../TargetBars'
import type { TargetKey, TargetScore } from '../../types'

const SW = 0.45
const SOLAR_DARK = '#1b3068'
const SOLAR_LIGHT = '#365aa6'
const SOLAR_GLINT = '#d8eaff'
const ROAD = '#c9cec6'
const CAR_COLORS = [ISO.blue, ISO.accentTint, '#9aa7b4', ISO.mustard]
const MAX_CARS = 24
const CAR_COLS = 8
const MAX_CUBES = 40
const CUBES_HIGH = 8
const PEOPLE = 20 // each person 5% of new homes
const HOUSES = 10 // each house 10% of new homes
/** ms between the tiles' draw-ins and the base delay of the first. */
const TILE_STAGGER = 140
const TILE_BASE = 200

// ---------------------------------------------------------------- svg helpers

const pts = (ps: Pt[]) => ps.map(([a, b]) => `${+a.toFixed(2)},${+b.toFixed(2)}`).join(' ')
const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`

function boxPts({ x, y, z = 0, w, d, h }: BoxGeom): Pt[] {
  const out: Pt[] = []
  for (const [a, b] of [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]) out.push(project(a, b, z), project(a, b, z + h))
  return out
}

/** viewBox around screen points. */
function fit(ps: Pt[], pad: number): string {
  const xs = ps.map((p) => p[0])
  const ys = ps.map((p) => p[1])
  const [x0, y0] = [Math.min(...xs) - pad, Math.min(...ys) - pad]
  return `${+x0.toFixed(2)} ${+y0.toFixed(2)} ${+(Math.max(...xs) - x0 + pad).toFixed(2)} ${+(Math.max(...ys) - y0 + pad).toFixed(2)}`
}

/** Fades (and lifts by `rise` user units) its children in at `at` ms; static with reduced motion. */
function Appear({ at, rise = 0, children }: { at: number; rise?: number; children: ReactNode }) {
  if (REDUCED_MOTION) return <g>{children}</g>
  return (
    <g opacity={0}>
      <animate attributeName="opacity" from="0" to="1" begin={secs(at)} dur="0.4s" fill="freeze" />
      {rise ? (
        <g transform={`translate(0 ${rise})`}>
          <animateTransform attributeName="transform" type="translate" from={`0 ${rise}`} to="0 0" begin={secs(at)} dur="0.5s"
            fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.2 1" />
          {children}
        </g>
      ) : (
        children
      )}
    </g>
  )
}

/** A stroke that draws itself in from its start at `at` ms. */
function DrawPath({ d, at, dur = 900, ...rest }: { d: string; at: number; dur?: number } & SVGProps<SVGPathElement>) {
  if (REDUCED_MOTION) return <path d={d} {...rest} />
  return (
    <path d={d} pathLength={1} strokeDasharray="1" strokeDashoffset={1} {...rest}>
      <animate attributeName="stroke-dashoffset" from="1" to="0" begin={secs(at)} dur={secs(dur)} fill="freeze" />
    </path>
  )
}

/** A leaf from base `a` to tip `b`, bulging `k` of its length to each side. */
function leafPath([ax, ay]: Pt, [bx, by]: Pt, k: number): string {
  const [mx, my] = [(ax + bx) / 2, (ay + by) / 2]
  const [nx, ny] = [-(by - ay) * k, (bx - ax) * k]
  return `M${ax} ${ay}Q${mx + nx} ${my + ny} ${bx} ${by}Q${mx - nx} ${my - ny} ${ax} ${ay}Z`
}

/** Smallest 1, 2 or 5 × 10^k at least `x`. */
function niceStep(x: number): number {
  if (!(x > 0)) return 1
  const e = 10 ** Math.floor(Math.log10(x))
  return [1, 2, 5, 10].map((m) => m * e).find((v) => v >= x) ?? 10 * e
}

// ---------------------------------------------------------------- pictures

const Cars = memo(function Cars({ n, base }: { n: number; base: number }) {
  const cols = Math.min(n, CAR_COLS)
  const rows = Math.ceil(n / CAR_COLS)
  const cars = Array.from({ length: n }, (_, i) => ({ i, x: (i % CAR_COLS) * 10, y: Math.floor(i / CAR_COLS) * 7.5 }))
    .sort((a, b) => a.x + a.y - (b.x + b.y))
  const road = { x: -2, y: -1.5, w: cols * 10 + 1.5, d: rows * 7.5, h: 0.6 }
  const vb = fit([...boxPts(road), ...cars.flatMap((c) => boxPts({ x: c.x, y: c.y, w: 7.5, d: 3.6, h: 3.8 }))], 3)
  return (
    <svg viewBox={vb} className="mx-auto block h-auto max-h-36 w-full" aria-hidden>
      <Appear at={base}>
        <IsoTile {...road} color={ROAD} stroke sw={SW} />
      </Appear>
      {cars.map((c) => (
        <Appear key={c.i} at={base + 120 + c.i * 35} rise={3}>
          <IsoBox x={c.x} y={c.y} z={0.6} w={7.5} d={3.6} h={1.8} color={CAR_COLORS[c.i % CAR_COLORS.length]} sw={SW} />
          <IsoBox x={c.x + 2} y={c.y + 0.4} z={2.4} w={3.6} d={2.8} h={1.4} color={ISO.blockLight} sw={SW} />
        </Appear>
      ))}
    </svg>
  )
})

const Cubes = memo(function Cubes({ n, base }: { n: number; base: number }) {
  const cols = Math.max(1, Math.ceil(n / CUBES_HIGH))
  const S = 4
  const cubes = Array.from({ length: n }, (_, i) => ({ i, c: Math.floor(i / CUBES_HIGH), lv: i % CUBES_HIGH }))
  const vb = fit([...boxPts({ x: -1, y: -1, w: cols * (S + 0.8) + 1, d: S + 2, h: Math.min(n, CUBES_HIGH) * S })], 3)
  return (
    <svg viewBox={vb} className="mx-auto block h-auto max-h-36 w-full" aria-hidden>
      <IsoTile x={-1} y={-1} w={cols * (S + 0.8) + 1} d={S + 2} h={0.4} color={ROAD} stroke sw={SW} />
      {cubes.map((q) => (
        <Appear key={q.i} at={base + 100 + (q.lv * cols + q.c) * 30} rise={2}>
          <IsoBox x={q.c * (S + 0.8)} y={0} z={0.4 + q.lv * S} w={S} d={S} h={S} color={ISO.green} sw={SW * 0.8} />
        </Appear>
      ))}
    </svg>
  )
})

const LeafBuilding = memo(function LeafBuilding({ base }: { base: number }) {
  const b = { x: 0, y: 0, w: 14, d: 14, h: 6 * 4.2 }
  const bp = boxPts(b)
  const xs = bp.map((p) => p[0])
  const ys = bp.map((p) => p[1])
  const a: Pt = [Math.min(...xs) - 5, Math.max(...ys) + 1]
  const tip: Pt = [Math.max(...xs) + 10, Math.min(...ys) - 8]
  const front = project(14, 14, 0) // the building's near bottom corner
  const sa: Pt = [front[0] + 3, front[1] + 1]
  const st: Pt = [front[0] + 15, front[1] - 9]
  const vine = `M${a[0]} ${a[1]}Q${front[0] - 2} ${front[1] + 7} ${sa[0]} ${sa[1]}`
  const vb = fit([...bp, a, tip, st, [a[0], a[1] + 3], [tip[0] + 3, tip[1] - 3]], 3)
  return (
    <svg viewBox={vb} className="mx-auto block h-auto max-h-40 w-full" aria-hidden>
      <Appear at={base} rise={4}>
        <path d={leafPath(a, tip, 0.34)} fill={ISO.green} stroke={ISO.ink} strokeWidth={SW} strokeLinejoin="round" />
        <DrawPath d={`M${a[0]} ${a[1]}L${tip[0]} ${tip[1]}`} at={base + 150} stroke="#bcd8c9" strokeWidth={0.8} fill="none" />
      </Appear>
      <Appear at={base + 250} rise={4}>
        <IsoFloors x={b.x} y={b.y} w={b.w} d={b.d} floorH={4.2} colors={Array<string>(6).fill(ISO.blockLight)} sw={SW} />
      </Appear>
      <DrawPath d={vine} at={base + 600} stroke={ISO.green} strokeWidth={1.4} strokeLinecap="round" fill="none" />
      <Appear at={base + 1100} rise={2}>
        <path d={leafPath(sa, st, 0.32)} fill={ISO.green} stroke={ISO.ink} strokeWidth={SW} strokeLinejoin="round" />
        <path d={`M${sa[0]} ${sa[1]}L${st[0]} ${st[1]}`} stroke="#bcd8c9" strokeWidth={0.6} />
      </Appear>
    </svg>
  )
})

const SolarArray = memo(function SolarArray({ base }: { base: number }) {
  const cols = 4
  const rows = 3
  const [W, D, Z] = [7, 5, 3.4]
  const roof = { x: -2, y: -2, w: cols * 8 + 3, d: rows * 6.5 + 2.5, h: 3 }
  const panels = Array.from({ length: cols * rows }, (_, i) => ({ c: i % cols, r: Math.floor(i / cols) }))
    .map((p) => ({ ...p, x: p.c * 8, y: p.r * 6.5 }))
    .sort((a, b) => a.x + a.y - (b.x + b.y))
  const rp = boxPts(roof)
  const sun: Pt = [Math.max(...rp.map((p) => p[0])) - 6, Math.min(...rp.map((p) => p[1])) - 16]
  const vb = fit([...rp, [sun[0] - 11, sun[1] - 11], [sun[0] + 11, sun[1] + 11]], 3)
  // a panel tilts up toward its far edge (y), so it faces the viewer; upper strip light, lower dark
  const strip = (x: number, y: number, y0: number, y1: number) => {
    const z = (v: number) => Z + 0.4 + 2.2 * (1 - (v - y) / D)
    return pts([project(x, y0, z(y0)), project(x + W, y0, z(y0)), project(x + W, y1, z(y1)), project(x, y1, z(y1))])
  }
  const glint = (from: string, at: number) =>
    REDUCED_MOTION ? null : (
      <animate attributeName="fill" values={`${from};${SOLAR_GLINT};${from};${from}`} keyTimes="0;0.06;0.14;1" dur="4s"
        begin={secs(at)} repeatCount="indefinite" />
    )
  return (
    <svg viewBox={vb} className="mx-auto block h-auto max-h-40 w-full" aria-hidden>
      <Appear at={base}>
        <IsoBox {...roof} color={ISO.block} sw={SW} />
      </Appear>
      {panels.map((p, i) => {
        const sweep = base + 1400 + (p.c + p.r) * 140
        return (
          <Appear key={`${p.c}-${p.r}`} at={base + 150 + i * 45} rise={2}>
            <polygon points={strip(p.x, p.y, p.y, p.y + D / 2)} fill={SOLAR_LIGHT} stroke={ISO.ink} strokeWidth={SW * 0.6} strokeLinejoin="round">
              {glint(SOLAR_LIGHT, sweep)}
            </polygon>
            <polygon points={strip(p.x, p.y, p.y + D / 2, p.y + D)} fill={SOLAR_DARK} stroke={ISO.ink} strokeWidth={SW * 0.6} strokeLinejoin="round">
              {glint(SOLAR_DARK, sweep + 60)}
            </polygon>
          </Appear>
        )
      })}
      <Appear at={base + 700}>
        <g>
          {!REDUCED_MOTION && (
            <animateTransform attributeName="transform" type="rotate" from={`0 ${sun[0]} ${sun[1]}`} to={`360 ${sun[0]} ${sun[1]}`}
              dur="40s" repeatCount="indefinite" />
          )}
          {Array.from({ length: 8 }, (_, i) => {
            const t = (i * Math.PI) / 4
            return (
              <line key={i} x1={sun[0] + Math.cos(t) * 7} y1={sun[1] + Math.sin(t) * 7} x2={sun[0] + Math.cos(t) * 10.5}
                y2={sun[1] + Math.sin(t) * 10.5} stroke={ISO.mustard} strokeWidth={1.3} strokeLinecap="round" />
            )
          })}
        </g>
        <circle cx={sun[0]} cy={sun[1]} r={5} fill={ISO.mustard} stroke={ISO.ink} strokeWidth={SW} />
      </Appear>
    </svg>
  )
})

const Person = ({ x, y, fill }: { x: number; y: number; fill: string }) => (
  <g>
    <circle cx={x} cy={y - 5.4} r={2.3} fill={fill} />
    <path d={`M${x - 3} ${y + 3.6}v-3.4a3 3 0 0 1 6 0v3.4z`} fill={fill} />
  </g>
)

const WalkGauge = memo(function WalkGauge({ value, target, base }: { value: number; target: number | null; base: number }) {
  const [cx, cy, r] = [100, 100, 80]
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * PEOPLE)
  const deg = (Math.min(100, Math.max(0, value)) / 100) * 180
  const tA = target !== null ? Math.PI - (Math.min(100, Math.max(0, target)) / 100) * Math.PI : null
  return (
    <svg viewBox="0 0 200 112" className="mx-auto block h-auto max-h-36 w-full" aria-hidden>
      <DrawPath d={`M${cx - r + 14} ${cy}A${r - 14} ${r - 14} 0 0 1 ${cx + r - 14} ${cy}`} at={base} stroke={ISO.rule} strokeWidth={2}
        fill="none" strokeLinecap="round" />
      {Array.from({ length: PEOPLE }, (_, i) => {
        const a = Math.PI - ((i + 0.5) / PEOPLE) * Math.PI
        return (
          <Appear key={i} at={base + 150 + i * 40} rise={3}>
            <Person x={cx + r * Math.cos(a)} y={cy - r * Math.sin(a)} fill={i < filled ? ISO.green : ISO.rule} />
          </Appear>
        )
      })}
      {tA !== null && (
        <g>
          <line x1={cx + (r - 20) * Math.cos(tA)} y1={cy - (r - 20) * Math.sin(tA)} x2={cx + (r + 12) * Math.cos(tA)}
            y2={cy - (r + 12) * Math.sin(tA)} stroke={ISO.ink} strokeWidth={1.6} />
          <text x={cx + (r - 26) * Math.cos(tA)} y={cy - (r - 26) * Math.sin(tA)} fontSize={7} textAnchor="middle" fill={ISO.ink}>
            target
          </text>
        </g>
      )}
      <g transform={`rotate(${REDUCED_MOTION ? deg : 0} ${cx} ${cy})`}>
        {!REDUCED_MOTION && (
          <animateTransform attributeName="transform" type="rotate" from={`0 ${cx} ${cy}`} to={`${deg} ${cx} ${cy}`}
            begin={secs(base + 300)} dur="1.4s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.2 0.8 0.3 1" />
        )}
        <line x1={cx} y1={cy} x2={cx - (r - 52)} y2={cy} stroke={ISO.ink} strokeWidth={2.2} strokeLinecap="round" />
      </g>
      <circle cx={cx} cy={cy} r={3.5} fill={ISO.ink} />
      <text x={cx} y={cy - 42} fontSize={15} fontWeight={700} textAnchor="middle" fill={ISO.ink} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {fmtNum(value, 1)}%
      </text>
    </svg>
  )
})

const House = ({ x, y, fill }: { x: number; y: number; fill: string }) => (
  <path d={`M${x - 6} ${y}v-8l6-5.5 6 5.5v8z`} fill={fill} stroke={ISO.ink} strokeWidth={0.8} strokeLinejoin="round" />
)

const FloodWave = memo(function FloodWave({ value, base }: { value: number; base: number }) {
  const clip = useId()
  const wet = Math.round((Math.min(100, Math.max(0, value)) / 100) * HOUSES)
  const water = 50
  const wave = 'q5 -3.2 10 0t10 0'.repeat(14) // 20 units a period, 280 long: the loop slides it by one period
  return (
    <svg viewBox="0 0 200 70" className="mx-auto block h-auto max-h-28 w-full" aria-hidden>
      <defs>
        <clipPath id={clip}>
          <rect x={0} y={0} width={200} height={70} />
        </clipPath>
      </defs>
      {Array.from({ length: HOUSES }, (_, i) => {
        const x = 14 + i * 19
        const flooded = i < wet
        return (
          <Appear key={i} at={base + i * 60} rise={4}>
            {!flooded && <rect x={x - 8} y={41} width={16} height={8} rx={1} fill={ISO.block} stroke={ISO.ink} strokeWidth={0.6} />}
            <House x={x} y={flooded ? 58 : 41} fill={flooded ? ISO.gap : ISO.blockLight} />
          </Appear>
        )
      })}
      <g clipPath={`url(#${clip})`}>
        <g>
          {!REDUCED_MOTION && (
            <animateTransform attributeName="transform" type="translate" from="0 0" to="-20 0" dur="3.2s" repeatCount="indefinite" />
          )}
          <Appear at={base + 500}>
            <path d={`M-10 ${water}${wave}V72H-10Z`} fill={ISO.accentTint} opacity={0.55} />
          </Appear>
          <DrawPath d={`M-10 ${water}${wave}`} at={base + 300} dur={1300} stroke={ISO.blue} strokeWidth={1.6} fill="none"
            strokeLinecap="round" />
        </g>
      </g>
    </svg>
  )
})

// ---------------------------------------------------------------- tiles

function Tile({ i, wide = false, t, label, note, children }: {
  i: number
  wide?: boolean
  t: TargetScore | undefined
  label: string
  note?: ReactNode
  children: ReactNode
}) {
  return (
    <figure className={`enter flex flex-col justify-between rounded-xl border border-rule p-3 ${wide ? 'col-span-2' : ''}`}
      style={{ '--d': i } as CSSProperties}>
      {children}
      <figcaption className="mt-2 text-[13px] leading-snug">
        <FactorHover keys={t?.factor_keys ?? []}>
          <span className="text-slate">{label}</span>
        </FactorHover>
        <div className="font-semibold tabular-nums">{t ? `${fmtNum(t.value, 1)} ${t.unit}` : 'missing'}</div>
        {note && <div className="text-xs text-slate">{note}</div>}
      </figcaption>
    </figure>
  )
}

export const EcoFigure = memo(function EcoFigure({ targets, localeId, solarMissing }: {
  targets: TargetScore[]
  localeId: string | undefined
  /** The plan has no solar resource for its place (precomputed.solar_kwh_per_kw_year null): no rooftop_solar target. */
  solarMissing: boolean
}) {
  const { factorNumber } = useApp()
  const by = new Map<TargetKey, TargetScore>(targets.map((t) => [t.key, t]))
  const co2 = by.get('transport_co2')
  const embodied = by.get('embodied_co2_saved')
  const solar = by.get('rooftop_solar')
  const walk = by.get('walk_access')
  const flood = by.get('flood_exposure')
  const at = (i: number) => TILE_BASE + i * TILE_STAGGER

  // transport_co2 = households near frequent transit x miles not driven x g CO2/mile / 1e6 (targets.py): the plan's
  // factors give one household's tonnes; the count is drawn only when it reproduces the target exactly (to rounding)
  const vmt = factorNumber('vmt_reduction_per_household_near_transit', localeId)
  const gPerMile = factorNumber('co2_g_per_vehicle_mile', localeId)
  const perHousehold = vmt !== null && gPerMile !== null ? (vmt * gPerMile) / 1e6 : null
  const households = co2 && perHousehold ? Math.round(co2.value / perHousehold) : null
  const asCars = co2 && perHousehold && households ? Math.abs(households * perHousehold - co2.value) <= 0.006 : false
  const perCar = households ? Math.max(1, Math.ceil(households / MAX_CARS)) : 1
  const step = niceStep((co2?.value ?? 0) / MAX_CUBES)
  const minutes = factorNumber('walk_minutes_target', localeId)

  return (
    <div className="grid grid-cols-2 gap-3">
      {co2 && (
        <Tile i={0} wide t={co2} label={TARGET_LABELS.transport_co2}
          note={
            asCars ? (
              <FactorHover keys={['vmt_reduction_per_household_near_transit', 'co2_g_per_vehicle_mile']}>
                <span>
                  {fmtNum(households)} households near frequent transit, each driving {fmtNum(vmt)} fewer miles a year
                  {perCar > 1 ? ` · one car = ${fmtNum(perCar)} households` : ' · one car per household'}
                </span>
              </FactorHover>
            ) : co2.value > 0 ? (
              `one cube = ${fmtNum(step)} t CO₂ a year`
            ) : (
              'no new homes near frequent transit'
            )
          }>
          {asCars && households ? (
            <Cars n={Math.ceil(households / perCar)} base={at(0)} />
          ) : (
            <Cubes n={Math.round(co2.value / step)} base={at(0)} />
          )}
        </Tile>
      )}
      {embodied && (
        <Tile i={1} t={embodied} label={TARGET_LABELS.embodied_co2_saved}
          note={embodied.value > 0 ? 'converting buildings instead of building new' : 'no conversions in the plan'}>
          <LeafBuilding base={at(1)} />
        </Tile>
      )}
      {(solar || solarMissing) && (
        <Tile i={2} t={solar} label={TARGET_LABELS.rooftop_solar} note={solar ? "on the plan's roofs" : 'solar resource missing for this place'}>
          {solar ? <SolarArray base={at(2)} /> : <p className="py-6 text-center text-sm text-slate italic">no solar resource</p>}
        </Tile>
      )}
      {walk && (
        <Tile i={3} t={walk} label={TARGET_LABELS.walk_access}
          note={`park, clinic and grocery${minutes !== null ? ` within a ${fmtNum(minutes)}-minute walk` : ' within the walk target'} · one person = ${100 / PEOPLE}% of new homes${walk.target !== null ? ` · target ${fmtNum(walk.target, 1)}%` : ''}`}>
          <WalkGauge value={walk.value} target={walk.target} base={at(3)} />
        </Tile>
      )}
      {flood && (
        <Tile i={4} t={flood} label={TARGET_LABELS.flood_exposure}
          note={`in a flood zone · one house = ${100 / HOUSES}% of new homes${flood.target !== null ? ` · ${flood.value > flood.target ? 'misses' : 'meets'} target ${fmtNum(flood.target, 1)}%` : ''}`}>
          <FloodWave value={flood.value} base={at(4)} />
        </Tile>
      )}
    </div>
  )
})
