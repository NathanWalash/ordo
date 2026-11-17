interface Props<T extends string> {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

/** macOS-style segmented control: a row of mutually exclusive buttons. */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: Props<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="no-drag inline-flex rounded-md bg-selected p-0.5">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`h-6 min-w-16 rounded-[5px] px-3 text-[12px] font-medium ${
              on ? 'bg-field text-ink shadow-[0_1px_2px_rgb(0_0_0/0.15)]' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
