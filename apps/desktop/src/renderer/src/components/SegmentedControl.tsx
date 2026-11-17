import { useRef, type KeyboardEvent, type ReactNode } from 'react'

interface Option<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

interface Props<T extends string> {
  label: string
  options: readonly Option<T>[]
  value: T
  onChange: (value: T) => void
}

const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/** macOS-style segmented control. A radio group: arrow keys move the choice, Tab leaves it. */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: Props<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const step = STEPS[e.key]
    if (!step) return
    e.preventDefault()
    const next = (i + step + options.length) % options.length
    onChange(options[next]!.value)
    refs.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={label} className="no-drag inline-flex rounded-lg bg-selected p-0.5">
      {options.map((o, i) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`flex h-6 min-w-[76px] items-center justify-center gap-1.5 rounded-md px-3 text-[12px] font-medium ${
              on
                ? 'bg-field text-ink shadow-[0_1px_2px_rgb(0_0_0/0.15)] dark:bg-white/20'
                : 'text-ink-2 hover:text-ink'
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
