import type { ReactNode } from 'react'
import { Banknote, CalendarDays, Mail, Receipt, SquareKanban, X } from 'lucide-react'
import type { ISODate, LinkKind } from '@ordo/boards-core'
import { dayLabel } from './model'

const ICONS: Record<LinkKind, { icon: ReactNode; tint: string; name: string }> = {
  event: { icon: <CalendarDays size={13} />, tint: 'var(--label-red)', name: 'Event' },
  email: { icon: <Mail size={13} />, tint: 'var(--label-blue)', name: 'Email' },
  bill: { icon: <Receipt size={13} />, tint: 'var(--label-green)', name: 'Bill' },
  transaction: { icon: <Banknote size={13} />, tint: 'var(--label-teal)', name: 'Payment' },
  card: { icon: <SquareKanban size={13} />, tint: 'var(--label-purple)', name: 'Card' },
}

export function LinkIcon({ kind }: { kind: LinkKind }) {
  const k = ICONS[kind]
  return (
    <span
      role="img"
      aria-label={k.name}
      className="flex size-6 shrink-0 items-center justify-center rounded-md"
      style={{ color: k.tint, background: `color-mix(in srgb, ${k.tint} 14%, transparent)` }}
    >
      {k.icon}
    </span>
  )
}

/** One linked item: what it is, its title and when, and whether Ordo can still find it. */
export function LinkRow({
  kind,
  title,
  detail,
  date,
  today,
  found = true,
  onOpen,
  onRemove,
  actions,
}: {
  kind: LinkKind
  title: string
  detail: string | null
  date: ISODate | null
  today: ISODate
  found?: boolean
  onOpen?: () => void
  onRemove?: () => void
  /** Replaces the remove button, e.g. accept and reject for a suggestion. */
  actions?: ReactNode
}) {
  const body = (
    <>
      <LinkIcon kind={kind} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${found ? '' : 'text-ink-2'}`}>{title}</span>
        <span className="block truncate text-[11px] text-ink-2">
          {[found ? null : 'Not found on this computer', detail, date && dayLabel(date, today)]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </>
  )
  return (
    <li className={`group flex items-center gap-1 rounded-md hover:bg-hover ${actions ? 'pr-2' : ''}`}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5">{body}</div>
      )}
      {actions ??
        (onRemove && (
          <button
            type="button"
            aria-label={`Remove link to ${title}`}
            title="Remove link"
            onClick={onRemove}
            className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/5 hover:text-ink focus-visible:opacity-100 dark:hover:bg-white/10"
          >
            <X size={13} />
          </button>
        ))}
    </li>
  )
}
