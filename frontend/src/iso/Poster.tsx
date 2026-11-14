// Flat poster card from aryanashta.me: one solid colour, "No. 0n" and the year in the top corners, an iso
// illustration in the middle, a big Archivo 800 title lower left, two label/value metric pairs along the bottom.
// viewBox 1000 x 1414 (1:√2), text positions copied from the site's markup.
import { memo, type ReactNode } from 'react'
import { ISO } from './shade'

export interface PosterMetric {
  label: string
  value: string
}

export const Poster = memo(function Poster({
  color,
  number,
  year,
  title,
  metrics,
  sceneViewBox,
  children,
  ink = false,
  label,
}: {
  color: string
  number: string
  year: string
  /** One line per array entry (the site breaks titles by hand). */
  title: string[]
  metrics: PosterMetric[]
  sceneViewBox: string
  children: ReactNode
  /** Ink text instead of paper text (the mustard poster on the site uses ink). */
  ink?: boolean
  label: string
}) {
  // White (not paper) on green/blue and no faded labels: paper on the site's green is 4.3:1 and its 72% labels ~3:1,
  // below the 4.5:1 this app keeps. Ink on mustard is 8.2:1.
  const fg = ink ? ISO.ink : '#FFFFFF'
  const titleTop = 1082 // first title line; further lines every 82 (the site's posters)
  return (
    <svg viewBox="0 0 1000 1414" role="img" aria-label={label} className="block h-auto w-full overflow-hidden rounded-2xl">
      <rect width="1000" height="1414" fill={color} />
      <g fill={fg} fontFamily="inherit" fontSize={30} style={{ fontVariantNumeric: 'tabular-nums' }}>
        <text x={72} y={108} fontWeight={600}>
          {number}
        </text>
        <text x={928} y={108} textAnchor="end">
          {year}
        </text>
      </g>
      <svg x={60} y={200} width={880} height={760} viewBox={sceneViewBox} preserveAspectRatio="xMidYMid meet">
        {children}
      </svg>
      <g fill={fg} fontFamily="inherit">
        {title.map((t, i) => (
          <text key={i} x={72} y={titleTop + i * 82} fontSize={82} fontWeight={800} letterSpacing={-0.82}
            style={{ fontVariationSettings: "'wdth' 125" }}>
            {t}
          </text>
        ))}
      </g>
      <g fontFamily="inherit" fontSize={27} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {metrics.slice(0, 2).map((m, i) => (
          <g key={m.label}>
            <text x={72 + i * 380} y={1336} fill={fg}>
              {m.label}
            </text>
            <text x={72 + i * 380 + Math.max(124, 15 * m.label.length + 24)} y={1336} fill={fg} fontWeight={700}>
              {m.value}
            </text>
          </g>
        ))}
      </g>
    </svg>
  )
})
