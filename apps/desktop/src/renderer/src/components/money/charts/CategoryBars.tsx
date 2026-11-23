import { useState } from 'react'
import { formatPence } from '@ordo/money-core'

const SHOWN = 8

/**
 * Spending per category as horizontal bars, largest first, each a button that filters the
 * transactions to that category. With `usual`, a tick on each bar marks the usual month.
 */
export function CategoryBars({
  categories,
  usual,
  selected,
  onSelect,
}: {
  categories: { category: string; amount: number }[]
  /** Usual spending per category, when the period is a single month. */
  usual?: ReadonlyMap<string, number>
  selected?: string | null
  onSelect?: (category: string | null) => void
}) {
  const [all, setAll] = useState(false)
  if (!categories.length) return <p className="px-4 py-3 text-ink-2">No spending in this period.</p>
  const total = categories.reduce((n, c) => n + c.amount, 0)
  // The chosen category stays in view even when it's past the first eight.
  const shown = all ? categories : categories.filter((c, i) => i < SHOWN || c.category === selected)
  const scale = Math.max(...shown.map((c) => Math.max(c.amount, usual?.get(c.category) ?? 0)))
  const pct = (v: number) => (scale ? (v / scale) * 100 : 0)
  return (
    <div className="px-2 py-2">
      <ul aria-label="Spending by category" className="flex flex-col">
        {shown.map((c) => {
          const typical = usual?.get(c.category)
          const on = selected === c.category
          const share = total ? Math.round((c.amount / total) * 100) : 0
          return (
            <li key={c.category}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onSelect?.(on ? null : c.category)}
                title={
                  `${formatPence(c.amount)}, ${share}% of spending` +
                  (typical !== undefined ? `. Usual month ${formatPence(typical)}` : '') +
                  (on ? '. Click to show every category' : '. Click to show only these transactions')
                }
                className={`grid w-full grid-cols-[110px_1fr_88px] items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  on ? 'bg-selected' : 'hover:bg-hover'
                }`}
              >
                <span className={`truncate ${on ? 'font-medium text-ink' : 'text-ink-2'}`}>{c.category}</span>
                <span className="relative h-2" aria-hidden="true">
                  <span className="absolute inset-y-0 left-0 w-full rounded-full bg-selected" />
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-accent"
                    style={{ width: `${Math.max(1.5, pct(c.amount))}%` }}
                  />
                  {typical !== undefined && typical > 0 && (
                    <span
                      className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-ink-2 ring-2 ring-content"
                      style={{ left: `${pct(typical)}%` }}
                    />
                  )}
                </span>
                <span className="text-right tabular-nums">{formatPence(c.amount)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex min-h-7 items-center justify-between gap-3 px-2 pt-1 text-[12px] text-ink-3">
        {usual ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-3 w-0.5 rounded-full bg-ink-2" />
            Your usual month
          </span>
        ) : (
          <span />
        )}
        {categories.length > SHOWN && (
          <button
            type="button"
            className="rounded px-1 text-accent outline-none hover:underline focus-visible:ring-1 focus-visible:ring-accent"
            onClick={() => setAll((a) => !a)}
          >
            {all ? 'Show fewer' : `Show all ${categories.length}`}
          </button>
        )}
      </div>
    </div>
  )
}
