/** One-of choice as a segmented control; the paper highlight slides to the chosen option. Arrow keys move the choice. */
export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label: string
}) {
  const n = options.length
  const i = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="relative flex rounded-[12px] bg-ink/[0.07] p-1"
      onKeyDown={(e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
        if (!d) return
        e.preventDefault()
        const next = options[(i + d + n) % n]
        onChange(next.value)
        ;(e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus()
      }}
    >
      <div
        aria-hidden
        className="seg-hl absolute top-1 bottom-1 rounded-[9px] bg-paper shadow-[0_1px_2px_rgb(28_34_48/.2),0_4px_12px_rgb(28_34_48/.1)]"
        style={{ left: `calc(4px + (100% - 8px) * ${i} / ${n})`, width: `calc((100% - 8px) / ${n})` }}
      />
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex-1 rounded-[9px] px-3 py-1.5 text-[14px] font-semibold whitespace-nowrap transition-colors duration-200 ${on ? 'text-ink' : 'text-slate hover:text-ink'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
