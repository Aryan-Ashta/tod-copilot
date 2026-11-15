import { useEffect, useRef, useState } from 'react'
import { REDUCED_MOTION } from '../construction'

/**
 * `value`, tweened from whatever was shown before (ease-out, `duration` ms). A change mid-tween starts from the
 * number on screen, so quick edits never jump. Reduced motion shows the value at once.
 */
export function useTweened(value: number, duration = 600): number {
  const [shown, setShown] = useState(value)
  const shownRef = useRef(value)
  useEffect(() => {
    if (REDUCED_MOTION) return
    const from = shownRef.current
    if (from === value) return
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / duration)
      // ease-out cubic
      const v = p >= 1 ? value : from + (value - from) * (1 - (1 - p) ** 3)
      shownRef.current = v
      setShown(v)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, duration])
  return REDUCED_MOTION ? value : shown
}

/** A number that counts to its new value (tabular figures, so the width does not jitter while it runs). */
export default function AnimatedNumber({
  value,
  format,
  duration = 600,
  className = '',
}: {
  value: number | null | undefined
  format: (v: number) => string
  duration?: number
  className?: string
}) {
  const has = value !== null && value !== undefined && !Number.isNaN(value)
  const shown = useTweened(has ? value : 0, duration)
  return (
    <span className={`tabular-nums ${className}`}>
      <span aria-hidden>{has ? format(shown) : '—'}</span>
      <span className="sr-only">{has ? format(value) : 'no data'}</span>
    </span>
  )
}
