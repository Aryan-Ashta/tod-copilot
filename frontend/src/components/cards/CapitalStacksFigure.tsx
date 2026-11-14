// Capital stacks as iso columns: debt, tax credit equity, incentive and investor equity stacked from the ground, the
// funding still required as a dashed ghost block on top. Heights are the stack amounts on one shared $ scale. Columns are
// clickable (selects the site); slices are labelled directly on the first column, no legend.
import { memo } from 'react'
import { IsoBox, IsoGhost, IsoLabel, IsoStack, ISO, isoViewBox, type StackLayer } from '../../iso'
import { fmtUsd } from '../../format'
import type { CapitalStack } from '../../types'

export const SLICES: { key: 'debt_usd' | 'tax_credit_equity_usd' | 'incentive_usd' | 'investor_equity_usd'; label: string; color: string }[] = [
  { key: 'debt_usd', label: 'Debt', color: ISO.blue },
  { key: 'tax_credit_equity_usd', label: 'Tax credit', color: ISO.green },
  { key: 'incentive_usd', label: 'Incentive', color: ISO.mustard },
  { key: 'investor_equity_usd', label: 'Investor', color: '#9aa7b4' },
]

const W = 10 // column footprint
const STEP = 17 // spacing along x
const MAX_H = 90 // height of the tallest total

export const CapitalStacksFigure = memo(function CapitalStacksFigure({ stacks, names, selected, onSelect }: {
  stacks: CapitalStack[]
  names: Map<string, string>
  selected: string | null
  onSelect: (siteId: string) => void
}) {
  const height = (s: CapitalStack) => Math.max(s.total_cost_usd, s.total_cost_usd - s.funding_required_usd) // funded + required
  const max = Math.max(...stacks.map(height), 1)
  const k = MAX_H / max
  const cols = stacks.map((s, i) => ({ x: i * STEP, y: 0, w: W, d: W, h: height(s) * k }))
  // room for the direct slice labels left of column 1 and the numbers in front of every column
  const vb = isoViewBox([...cols, { x: -STEP * 2.2, y: W, w: 1, d: 1, h: cols[0]?.h ?? 0 }, { x: 0, y: W + 8, w: cols.length * STEP, d: 1, h: 0 }], 6)
  const [, , vbW, vbH] = vb.split(' ').map(Number)
  const fs = Math.max(4, Math.max(vbW, vbH) * 0.03)
  const first = stacks[0]
  return (
    <svg viewBox={vb} className="mx-auto block h-auto max-h-[380px] w-full" role="group" aria-label="Capital stacks per site">
      {stacks.map((s, i) => {
        const layers: StackLayer[] = SLICES.map((p) => ({ h: s[p.key] * k, color: p.color, title: `${p.label} ${fmtUsd(s[p.key])}` }))
        const funded = SLICES.reduce((a, p) => a + s[p.key] * k, 0)
        const name = names.get(s.site_id) ?? s.site_id
        const on = selected === s.site_id
        return (
          <g
            key={s.site_id}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={`${i + 1}. ${name}: cost ${fmtUsd(s.total_cost_usd)}, ${s.pencils ? 'pencils' : `funding required ${fmtUsd(s.funding_required_usd)}`}`}
            onClick={() => onSelect(s.site_id)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(s.site_id)}
            className="cursor-pointer"
          >
            <title>{name}</title>
            {on && <IsoBox x={i * STEP - 2} y={-2} w={W + 4} d={W + 4} h={0.6} color={ISO.ink} stroke={false} shadow={false} />}
            <IsoStack x={i * STEP} y={0} w={W} d={W} layers={layers} sw={0.5} />
            {s.funding_required_usd > 0 && (
              <IsoGhost x={i * STEP} y={0} z={funded} w={W} d={W} h={s.funding_required_usd * k} sw={0.6} color={ISO.gap} />
            )}
            <IsoLabel at={[i * STEP + W, W + 7, 0]} size={fs} anchor="middle" weight={on ? 700 : 400}>
              {i + 1}
            </IsoLabel>
          </g>
        )
      })}
      {/* direct labels for the slices of the first column, to its left */}
      {first &&
        (() => {
          let z = 0
          const out = SLICES.map((p) => {
            const h = first[p.key] * k
            const mid = z + h / 2
            z += h
            return h > fs * 0.9 ? (
              <IsoLabel key={p.key} at={[0, W + 1, mid]} size={fs} anchor="end">
                {p.label}
              </IsoLabel>
            ) : null
          })
          if (first.funding_required_usd > 0)
            out.push(
              <IsoLabel key="required" at={[0, W + 1, z + (first.funding_required_usd * k) / 2]} size={fs} anchor="end" fill={ISO.gap}>
                Required
              </IsoLabel>,
            )
          return out
        })()}
    </svg>
  )
})
