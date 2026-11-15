// Pencil hints: a fixed overlay of hand-drawn arrows and short notes that walk a first-time user through placing a
// tile (data-hint-anchor targets set by other components). Shown until the first change.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { REDUCED_MOTION } from '../construction'
import { suggestionsApplied, usePlan } from '../state/PlanContext'

const INTRO_KEY = 'transitor.hints.intro'
/** Fade-out duration; matches the .tz-hint-inst transition. */
const FADE_MS = 420
const TAU = Math.PI * 2

type Pt = { x: number; y: number }
interface Box {
  x: number
  y: number
  w: number
  h: number
}
/** One measurement pass: viewport size and the visible boxes per anchor query. */
interface Frame {
  vw: number
  vh: number
  boxes: Record<string, Box[]>
}

type Hint = { kind: 'tray' } | { kind: 'map' } | { kind: 'apply' }
interface Want {
  key: string
  hint: Hint
}
interface Inst extends Want {
  /** `<key>#<sync generation>`: unique per appearance. */
  uid: string
  /** Hash of a per-mount salt, the plan and uid (pure, stable across renders): tilt, curvature and wobble derive from it. */
  seed: number
  /** Fading out; removed after FADE_MS. */
  leaving: boolean
}

const readIntroDone = () => {
  try {
    return localStorage.getItem(INTRO_KEY) === 'done'
  } catch {
    return false
  }
}

// ---------- measuring ----------

/** Ancestors that clip their content (overflow other than visible); cached per element. */
const clipCache = new WeakMap<Element, Element[]>()
function clippers(el: Element): Element[] {
  let c = clipCache.get(el)
  if (c) return c
  c = []
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p)
    if (s.overflowX !== 'visible' || s.overflowY !== 'visible') c.push(p)
  }
  clipCache.set(el, c)
  return c
}

/** The element's box when it is rendered and mostly on screen (not scrolled away inside a panel); else null. */
function visibleBox(el: Element, vw: number, vh: number): Box | null {
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return null
  if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) return null
  let l = Math.max(r.left, 0)
  let t = Math.max(r.top, 0)
  let rt = Math.min(r.right, vw)
  let b = Math.min(r.bottom, vh)
  for (const p of clippers(el)) {
    const q = p.getBoundingClientRect()
    l = Math.max(l, q.left)
    t = Math.max(t, q.top)
    rt = Math.min(rt, q.right)
    b = Math.min(b, q.bottom)
  }
  if (rt - l < Math.min(r.width * 0.6, 120) || b - t < Math.min(r.height * 0.6, 120)) return null
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
}

function measure(queries: string[]): Frame {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const boxes: Record<string, Box[]> = {}
  for (const q of queries) {
    const out: Box[] = []
    const sel = q.startsWith('h:') ? `[data-history-id="${q.slice(2)}"]` : `[data-hint-anchor="${q}"]`
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const b = visibleBox(el, vw, vh)
      if (b) out.push(b)
      if (out.length) break
    }
    if (out.length) boxes[q] = out
  }
  return { vw, vh, boxes }
}

function queriesFor(h: Hint): string[] {
  switch (h.kind) {
    case 'tray':
      return ['tray', 'map']
    case 'map':
      return ['tray', 'map']
    case 'apply':
      return ['apply', 'map']
  }
}

// ---------- randomness (seeded, so a hint keeps its look across renders) ----------

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const between = (r: () => number, a: number, b: number) => a + (b - a) * r()
const sign = (r: () => number) => (r() < 0.5 ? -1 : 1)
/** Random tilt of ±3–5°. */
const tilt = (r: () => number) => sign(r) * between(r, 3, 5)

// ---------- geometry ----------

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), Math.max(a, b))
const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const f = (v: number) => v.toFixed(1)

/** Point where the ray from the box centre toward `p` leaves the box inflated by `gap` (p itself if inside). */
function edgeToward(b: Box, p: Pt, gap: number): Pt {
  const c = centre(b)
  const dx = p.x - c.x
  const dy = p.y - c.y
  const hw = b.w / 2 + gap
  const hh = b.h / 2 + gap
  const t = Math.min(1, dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

/** Smooth path through the points (Catmull-Rom as cubic Béziers). */
function smooth(pts: Pt[]): string {
  let d = `M${f(pts[0].x)},${f(pts[0].y)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    d +=
      `C${f(p1.x + (p2.x - p0.x) / 6)},${f(p1.y + (p2.y - p0.y) / 6)} ` +
      `${f(p2.x - (p3.x - p1.x) / 6)},${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)},${f(p2.y)}`
  }
  return d
}

function bez(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y }
}

/** Curvy, slightly wobbly arrow: shaft and a little hand-drawn head. */
function arrowPaths(from: Pt, to: Pt, r: () => number): { shaft: string; head: string } | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const L = Math.hypot(dx, dy)
  if (L < 28) return null
  const nx = -dy / L
  const ny = dx / L
  const bend = sign(r) * L * between(r, 0.14, 0.28)
  const k1 = between(r, 0.2, 0.34)
  const b1 = between(r, 0.85, 1.15)
  const k2 = between(r, 0.62, 0.8)
  const b2 = between(r, 0.4, 0.75)
  const c1 = { x: from.x + dx * k1 + nx * bend * b1, y: from.y + dy * k1 + ny * bend * b1 }
  const c2 = { x: from.x + dx * k2 + nx * bend * b2, y: from.y + dy * k2 + ny * bend * b2 }
  const amp = between(r, 0.5, 1.1)
  const freq = between(r, 1.5, 3)
  const ph = r() * TAU
  const n = clamp(Math.round(L / 22), 6, 16)
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const p = bez(from, c1, c2, to, t)
    const w = amp * Math.sin(t * freq * TAU + ph) * Math.sin(Math.PI * t)
    pts.push({ x: p.x + nx * w, y: p.y + ny * w })
  }
  const back = bez(from, c1, c2, to, 0.9)
  const ang = Math.atan2(to.y - back.y, to.x - back.x)
  const a1 = ang + Math.PI - between(r, 0.4, 0.55)
  const a2 = ang + Math.PI + between(r, 0.36, 0.5)
  const l1 = between(r, 7, 10)
  const l2 = between(r, 6, 9)
  const head =
    `M${f(to.x + Math.cos(a1) * l1)},${f(to.y + Math.sin(a1) * l1)}` +
    `Q${f(to.x + Math.cos(a1) * l1 * 0.45 + nx * 0.6)},${f(to.y + Math.sin(a1) * l1 * 0.45 + ny * 0.6)} ${f(to.x)},${f(to.y)}` +
    `L${f(to.x + Math.cos(a2) * l2)},${f(to.y + Math.sin(a2) * l2)}`
  return { shaft: smooth(pts), head }
}

// ---------- notes ----------

const NOTE_PX = { big: 16, small: 14 } as const
/** Rough half-size of a note (no DOM measuring): enough to start arrows near its edge and keep it on screen. */
const noteHalf = (text: string, px: number) => ({ hw: (text.length * px * 0.5) / 2 + 10, hh: px * 0.7 + 4 })

function placeNote(p: Pt, text: string, px: number, fr: Frame): Pt {
  const { hw, hh } = noteHalf(text, px)
  return { x: clamp(p.x, hw + 8, fr.vw - hw - 8), y: clamp(p.y, hh + 8, fr.vh - hh - 8) }
}
const noteBox = (p: Pt, text: string, px: number): Box => {
  const { hw, hh } = noteHalf(text, px)
  return { x: p.x - hw, y: p.y - hh, w: hw * 2, h: hh * 2 }
}

// ---------- drawing ----------

const delayStyle = (ms: number) => ({ '--tz-d': `${Math.round(ms)}ms` }) as CSSProperties

interface Drawn {
  svg: ReactNode[]
  html: ReactNode[]
}

function Note({ at, text, px, rot, delay }: { at: Pt; text: string; px: number; rot: number; delay: number }) {
  return (
    <div
      className="tz-hint-note"
      style={{ transform: `translate(${f(at.x)}px, ${f(at.y)}px) translate(-50%, -50%) rotate(${rot.toFixed(2)}deg)`, fontSize: px }}
    >
      <span className="tz-hint-note-in" style={delayStyle(delay)}>
        {text}
      </span>
    </div>
  )
}

function drawArrow(out: Drawn, key: string, from: Pt, to: Pt, r: () => number, delay: number) {
  const rot = tilt(r)
  const w = between(r, 1.25, 1.6)
  const a = arrowPaths(from, to, r)
  if (!a) return
  out.svg.push(
    <g key={key} transform={`rotate(${rot.toFixed(2)} ${f(to.x)} ${f(to.y)})`}>
      <path className="tz-hint-stroke" d={a.shaft} pathLength={1} strokeWidth={w} style={delayStyle(delay)} />
      <path className="tz-hint-stroke tz-hint-quick" d={a.head} pathLength={1} strokeWidth={w} style={delayStyle(delay + 440)} />
    </g>,
  )
}

function drawNote(out: Drawn, key: string, at: Pt, text: string, px: number, r: () => number, delay: number) {
  out.html.push(<Note key={key} at={at} text={text} px={px} rot={tilt(r)} delay={delay} />)
}

const TRAY_TEXT = 'pick a tile…'
const MAP_TEXT = '…then click a highlighted spot'
const APPLY_TEXT = "or start from the agents' plan"

/** Where the intro note sits: a little above-left of the tray (toward the map), else lower-left of the map centre. */
function introNoteAt(fr: Frame, text: string): Pt | null {
  const tray = fr.boxes.tray?.[0]
  const map = fr.boxes.map?.[0]
  const px = NOTE_PX.big
  if (tray) {
    const tc = centre(tray)
    const to = map ? centre(map) : { x: fr.vw / 2, y: fr.vh / 2 }
    const dx = to.x - tc.x
    const dy = to.y - tc.y
    const L = Math.hypot(dx, dy) || 1
    const reach = Math.min(tray.h / 2 + 96, L * 0.8)
    // step toward the map centre, then sideways (to the left of the direction of travel)
    return placeNote({ x: tc.x + (dx / L) * reach + (dy / L) * 90, y: tc.y + (dy / L) * reach - (dx / L) * 90 }, text, px, fr)
  }
  if (map) return placeNote({ x: map.x + map.w * 0.32, y: map.y + map.h * 0.72 }, text, px, fr)
  return null
}

function draw(inst: Inst, fr: Frame): Drawn {
  const out: Drawn = { svg: [], html: [] }
  const R = (part: string) => rng(inst.seed ^ hashStr(part))
  const h = inst.hint
  switch (h.kind) {
    case 'tray': {
      const tray = fr.boxes.tray?.[0]
      const at = tray && introNoteAt(fr, TRAY_TEXT)
      if (!tray || !at) break
      drawNote(out, 'note', at, TRAY_TEXT, NOTE_PX.big, R('note'), 0)
      const from = edgeToward(noteBox(at, TRAY_TEXT, NOTE_PX.big), centre(tray), 4)
      drawArrow(out, 'arrow', from, edgeToward(tray, from, 7), R('arrow'), 160)
      break
    }
    case 'map': {
      const map = fr.boxes.map?.[0]
      const at = map && introNoteAt(fr, MAP_TEXT)
      if (!map || !at) break
      drawNote(out, 'note', at, MAP_TEXT, NOTE_PX.big, R('note'), 0)
      const mc = centre(map)
      const dx = at.x - mc.x
      const dy = at.y - mc.y
      const L = Math.hypot(dx, dy) || 1
      // stop a little short of the centre so the tip does not cover what the user should click
      const back = Math.min(56, L * 0.3)
      const to = { x: mc.x + (dx / L) * back, y: mc.y + (dy / L) * back }
      const from = edgeToward(noteBox(at, MAP_TEXT, NOTE_PX.big), to, 4)
      drawArrow(out, 'arrow', from, to, R('arrow'), 160)
      break
    }
    case 'apply': {
      const btn = fr.boxes.apply?.[0]
      if (!btn) break
      const bc = centre(btn)
      const map = fr.boxes.map?.[0]
      const to = map ? centre(map) : { x: fr.vw / 2, y: fr.vh / 2 }
      const dx = to.x - bc.x
      const dy = to.y - bc.y
      const L = Math.hypot(dx, dy) || 1
      const reach = Math.min(Math.max(btn.w, btn.h) / 2 + 70, L * 0.7)
      const px = NOTE_PX.small
      const at = placeNote(
        { x: bc.x + (dx / L) * reach - (dy / L) * 34, y: bc.y + (dy / L) * reach + (dx / L) * 34 },
        APPLY_TEXT,
        px,
        fr,
      )
      drawNote(out, 'note', at, APPLY_TEXT, px, R('note'), 260)
      const from = edgeToward(noteBox(at, APPLY_TEXT, px), bc, 4)
      drawArrow(out, 'arrow', from, edgeToward(btn, from, 6), R('arrow'), 380)
      break
    }
  }
  return out
}

const CSS = `
.tz-hint-root { position: fixed; inset: 0; z-index: 40; pointer-events: none; overflow: hidden; }
.tz-hint-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.tz-hint-inst { transition: opacity ${FADE_MS}ms ease-out; }
.tz-hint-inst[data-leaving] { opacity: 0; }
.tz-hint-stroke {
  fill: none; stroke: var(--color-ink); stroke-opacity: .7; stroke-linecap: round; stroke-linejoin: round;
  stroke-dasharray: 1 2; stroke-dashoffset: 1.01;
  animation: tz-hint-draw 520ms cubic-bezier(.45, .05, .3, 1) var(--tz-d, 0ms) forwards;
}
.tz-hint-quick { animation-duration: 170ms; animation-timing-function: ease-out; }
.tz-hint-note { position: absolute; left: 0; top: 0; white-space: nowrap; will-change: transform; }
.tz-hint-note-in {
  display: inline-block; padding: 4px 12px; line-height: 1.15; color: var(--color-ink); opacity: .72;
  font-family: "Bradley Hand", "Segoe Print", "Chalkboard SE", var(--font-sans); font-style: italic; font-weight: 500;
  letter-spacing: .01em; font-variant-numeric: tabular-nums;
  background: radial-gradient(closest-side, rgb(237 239 234 / .82), rgb(237 239 234 / .55) 60%, transparent);
  text-shadow: 0 0 2px var(--color-paper), 0 0 4px var(--color-paper), 0 0 8px var(--color-paper);
  animation: tz-hint-pop 480ms ease-out var(--tz-d, 0ms) both;
}
@keyframes tz-hint-draw { to { stroke-dashoffset: 0; } }
@keyframes tz-hint-pop {
  0% { opacity: 0; transform: scale(.82) rotate(-3deg); }
  55% { opacity: .72; transform: scale(1.05) rotate(1.6deg); }
  80% { transform: scale(.99) rotate(-.6deg); }
  100% { opacity: .72; transform: none; }
}
@keyframes tz-hint-fade { from { opacity: 0; } }
.tz-hint-rm .tz-hint-stroke { stroke-dasharray: none; stroke-dashoffset: 0; animation: tz-hint-fade 260ms ease-out var(--tz-d, 0ms) both; }
.tz-hint-rm .tz-hint-note-in { animation: tz-hint-fade 260ms ease-out var(--tz-d, 0ms) both; }
`

export default function Hints() {
  const { state } = usePlan()
  const { history, tool, basePlan } = state
  const applied = suggestionsApplied(state)

  const userEdited = history.some((h) => h.kind === 'tile' || h.kind === 'slider')
  const [introDone, setIntroDone] = useState(readIntroDone)
  // the intro ends with the user's first accepted tile/slider edit (saved edits count too); undoing it does not bring
  // the intro back
  if (!introDone && userEdited) setIntroDone(true)
  useEffect(() => {
    if (!introDone) return
    try {
      localStorage.setItem(INTRO_KEY, 'done')
    } catch {
      // storage unavailable: the intro just shows again next time
    }
  }, [introDone])

  const loaded = basePlan !== null
  const want = useMemo(() => {
    const w: Want[] = []
    if (!introDone && loaded) {
      w.push(tool ? { key: 'map', hint: { kind: 'map' } } : { key: 'tray', hint: { kind: 'tray' } })
      if (!applied) w.push({ key: 'apply', hint: { kind: 'apply' } })
    }
    return w
  }, [introDone, loaded, tool, applied])

  // shown hints: new keys enter with their own seed, dropped keys fade out, then go (synced while rendering)
  const [insts, setInsts] = useState<Inst[]>([])
  // per-mount salt (created once), so the same hint looks different from one visit to the next
  const [salt] = useState(() => Math.floor(Math.random() * 2 ** 31))
  const wantSig = want.map((w) => w.key).join('|')
  const [synced, setSynced] = useState({ sig: '', gen: 0 })
  if (wantSig !== synced.sig) {
    const gen = synced.gen + 1
    setSynced({ sig: wantSig, gen })
    const keys = new Set(want.map((w) => w.key))
    const next = insts.map((i) => (i.leaving || keys.has(i.key) ? i : { ...i, leaving: true }))
    for (const w of want) {
      if (next.some((i) => i.key === w.key && !i.leaving)) continue
      const uid = `${w.key}#${gen}`
      next.push({ ...w, uid, seed: hashStr(`${salt}|${state.planId}|${uid}`), leaving: false })
    }
    setInsts(next)
  }

  const leavingSig = insts
    .filter((i) => i.leaving)
    .map((i) => i.uid)
    .join('|')
  useEffect(() => {
    if (!leavingSig) return
    const gone = new Set(leavingSig.split('|'))
    const t = setTimeout(() => setInsts((p) => p.filter((i) => !gone.has(i.uid))), FADE_MS)
    return () => clearTimeout(t)
  }, [leavingSig])

  // anchor boxes: re-measured every frame while a hint is visible (panels animate, the page scrolls or resizes)
  const queries = useMemo(() => [...new Set(insts.flatMap((i) => queriesFor(i.hint)))], [insts])
  const querySig = queries.join('|')
  const [frame, setFrame] = useState<Frame | null>(null)
  useEffect(() => {
    if (!querySig) return
    const qs = querySig.split('|')
    let raf = 0
    let last = ''
    const tick = () => {
      const fr = measure(qs)
      const sig = JSON.stringify(fr)
      if (sig !== last) {
        last = sig
        setFrame(fr)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [querySig])

  if (!insts.length || !frame) return null
  const drawn = insts.map((i) => ({ i, d: draw(i, frame) }))
  return (
    <div className={`tz-hint-root${REDUCED_MOTION ? ' tz-hint-rm' : ''}`} aria-hidden>
      <style>{CSS}</style>
      <svg className="tz-hint-svg">
        {drawn.map(({ i, d }) => (
          <g key={i.uid} className="tz-hint-inst" data-leaving={i.leaving ? '' : undefined}>
            {d.svg}
          </g>
        ))}
      </svg>
      {drawn.map(({ i, d }) => (
        <div key={i.uid} className="tz-hint-inst" data-leaving={i.leaving ? '' : undefined}>
          {d.html}
        </div>
      ))}
    </div>
  )
}
