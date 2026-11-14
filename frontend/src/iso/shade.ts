// Three-tone face colours for one hue, as on aryanashta.me: top = the base colour, left face 0.08 darker in OKLCH
// lightness, right face 0.16 darker, chroma and hue unchanged (measured from the site's blue and grey blocks).

export interface Faces {
  top: string
  left: string
  right: string
}

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function hexToOklab(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => toLin(parseInt(h.slice(i, i + 2), 16) / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToHex(L: number, a: number, b: number): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  return (
    '#' +
    rgb
      .map((c) => Math.round(Math.min(1, Math.max(0, toSrgb(c))) * 255))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

/** Shift OKLCH lightness by `dL`, keeping chroma and hue. */
export function lighten(hex: string, dL: number): string {
  const [L, a, b] = hexToOklab(hex)
  return oklabToHex(Math.min(1, Math.max(0, L + dL)), a, b)
}

const cache = new Map<string, Faces>()

export function shade(base: string): Faces {
  const hit = cache.get(base)
  if (hit) return hit
  const f = { top: base, left: lighten(base, -0.08), right: lighten(base, -0.16) }
  cache.set(base, f)
  return f
}

/** Site palette. Greys are the site's "plain block" tones; accents are its poster colours. */
export const ISO = {
  ink: '#1C2230',
  paper: '#EDEFEA',
  rule: '#D3D7D0',
  slate: '#5F6778',
  block: '#d9e1ea',
  blockLight: '#e6ebef',
  green: '#2E7D5B',
  blue: '#2F5BD3',
  mustard: '#E3B448',
  gap: '#B93A2E',
  transit: '#13808A',
  accentTint: '#a9bfe7',
} as const
