import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export interface SliderMark {
  value: number
  label: string
}

/**
 * Notched-track slider. While dragging, the thumb follows the pointer and `onChange` fires each time the value
 * crosses a step; on release the thumb springs onto the step (CSS `.sl-*` in index.css). `marks` label stops under
 * the track and are clickable; with a step of 1 over a few values this is a stop slider.
 */
export default function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  valueText,
  marks,
  color = 'var(--color-transit)',
  disabled = false,
  className = '',
}: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  label: string
  valueText?: string
  marks?: SliderMark[]
  color?: string
  disabled?: boolean
  className?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const span = max - min
  // toFixed drops float noise (0.25 + 15 × 0.05 must equal 1 exactly)
  const snap = (f: number) => Math.min(max, Math.max(min, Number((min + Math.round((f * span) / step) * step).toFixed(6))))
  const fracAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }
  const frac = drag ?? (value - min) / span
  const pct = `${frac * 100}%`

  const set = (v: number) => {
    if (v !== value) onChange(v)
  }
  const onPointerDown = (e: PointerEvent) => {
    if (disabled || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const f = fracAt(e.clientX)
    setDrag(f)
    set(snap(f))
  }
  const onPointerMove = (e: PointerEvent) => {
    if (drag === null) return
    const f = fracAt(e.clientX)
    setDrag(f)
    set(snap(f))
  }
  const onPointerUp = () => setDrag(null)
  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return
    const k = e.key
    if (k === 'Home') set(min)
    else if (k === 'End') set(max)
    else if (k === 'ArrowRight' || k === 'ArrowUp') set(snap((value + step - min) / span))
    else if (k === 'ArrowLeft' || k === 'ArrowDown') set(snap((value - step - min) / span))
    else return
    e.preventDefault()
  }

  return (
    <div className={`px-2.5 ${disabled ? 'opacity-50' : ''} ${className}`}>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={valueText}
        aria-disabled={disabled}
        data-dragging={drag !== null}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={`sl relative h-6 touch-none select-none ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink/[0.12]" />
        <div className="sl-fill absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full" style={{ width: pct, background: color }} />
        {marks?.map((m) => (
          <div
            key={m.value}
            className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200"
            style={{ left: `${((m.value - min) / span) * 100}%`, background: m.value <= value ? color : 'rgb(28 34 48 / .22)' }}
          />
        ))}
        <div
          className="sl-move absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-white shadow-[0_1px_3px_rgb(28_34_48/.3)]"
          style={{ left: pct, borderColor: color }}
        />
      </div>
      {marks && (
        <div className="relative mt-1.5 h-5 text-[13px] tabular-nums">
          {marks.map((m, i) => (
            <button
              key={m.value}
              type="button"
              tabIndex={-1}
              disabled={disabled}
              onClick={() => set(m.value)}
              className={`absolute whitespace-nowrap transition-colors duration-200 ${
                i === 0 ? '-translate-x-2.5' : i === marks.length - 1 ? 'translate-x-[calc(-100%+10px)]' : '-translate-x-1/2'
              } ${m.value === value ? 'font-semibold text-ink' : 'text-slate hover:text-ink'}`}
              style={{ left: `${((m.value - min) / span) * 100}%` }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
