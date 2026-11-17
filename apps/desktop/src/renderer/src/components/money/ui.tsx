import { useId, type ReactNode, type SelectHTMLAttributes } from 'react'
import type { BillSource, Cadence } from '@ordo/money-core'

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' })

const local = (iso: string) => new Date(`${iso}T00:00:00`)

/** `3 Nov 2026`, or `3 Nov` when `short`. */
export const formatDate = (iso: string, short = false) => (short ? shortFmt : dateFmt).format(local(iso))
/** `November 2026` for `2026-11`. */
export const formatMonth = (ym: string) => monthFmt.format(local(`${ym}-01`))

export const CADENCE_LABEL: Record<Cadence, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
}
export const PER: Record<Cadence, string> = { weekly: 'a week', monthly: 'a month', yearly: 'a year' }

/** Days from today to `iso`, for "in 3 days" style labels. */
export function daysFromToday(iso: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((local(iso).getTime() - today.getTime()) / 86_400_000)
}

export function dueLabel(iso: string): string {
  const d = daysFromToday(iso)
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  if (d > 1 && d < 7) return `In ${d} days`
  return formatDate(iso, d >= 0 && d < 300)
}

const SOURCE: Record<BillSource, { label: string; color: string; title: string }> = {
  bank: { label: 'Bank', color: 'var(--accent)', title: 'Found in your bank statements' },
  email: { label: 'Email', color: 'var(--newsletters)', title: 'Found in your email' },
  both: { label: 'Both', color: 'var(--success)', title: 'Found in your bank statements and email' },
  manual: { label: 'Manual', color: 'var(--receipts)', title: 'Added by you' },
}

export function SourceBadge({ source }: { source: BillSource }) {
  const s = SOURCE[source]
  return (
    <span
      title={s.title}
      className="inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[11px] font-medium"
      style={{ color: s.color, background: `color-mix(in srgb, ${s.color} 14%, transparent)` }}
    >
      {s.label}
    </span>
  )
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label: string
  /** Visually hide the label (it's still read out). */
  hideLabel?: boolean
  children: ReactNode
}

/** Native pop-up button, styled to sit with the other controls. */
export function Select({ label, hideLabel, className = '', children, ...rest }: SelectProps) {
  const id = useId()
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-[13px] font-semibold'}>
        {label}
      </label>
      <select
        id={id}
        className="no-drag h-7 rounded-md border border-sep bg-field px-2 text-[13px] text-ink shadow-[0_1px_1px_rgb(0_0_0/0.06)] outline-none focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60"
        {...rest}
      >
        {children}
      </select>
    </div>
  )
}

/** Segmented control (NSSegmentedControl look). */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className="inline-flex rounded-md bg-selected p-0.5">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          onClick={() => props.onChange(o.value)}
          className={`h-6 rounded-[5px] px-3 text-[12px] font-medium ${
            props.value === o.value ? 'bg-field text-ink shadow-[0_1px_2px_rgb(0_0_0/0.15)]' : 'text-ink-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Rounded group box for a section of a page. */
export function Panel(props: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-xl border border-sep ${props.className ?? ''}`}>
      {(props.title || props.actions) && (
        <header className="flex min-h-10 items-center justify-between gap-2 border-b border-sep px-4 py-2">
          <h3 className="text-[13px] font-semibold">{props.title}</h3>
          {props.actions}
        </header>
      )}
      {props.children}
    </section>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error'; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-md bg-hover px-3 py-2 ${tone === 'error' ? 'text-danger' : 'text-ink-2'}`}
    >
      {children}
    </div>
  )
}
