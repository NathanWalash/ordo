import { useState, type ReactNode } from 'react'
import type { MailAccount } from '@ordo/shared'
import { AccountChip } from './accounts/AccountChip'
import {
  CircleCheck,
  ExternalLink,
  Mail,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { stillEmailing, type Category, type CategorisedSender } from '@ordo/mail-core'
import { Button } from './Button'

export const CATEGORY_LABELS: { id: Category; label: string }[] = [
  { id: 'promotions', label: 'Promotions' },
  { id: 'newsletters', label: 'Newsletters' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'receipts', label: 'Receipts' },
  { id: 'people', label: 'People' },
  { id: 'uncategorised', label: 'Other' },
]
export const categoryColor = (c: Category) => `var(--${c})`

/** A sender, plus who sorted it when AI sorting is on. */
export type ListedSender = CategorisedSender & { sortedBy?: 'rules' | 'ai'; confidence?: number }

interface Props {
  senders: ListedSender[]
  /** Several accounts: each sender's accounts by id, to show which inboxes its mail is in. */
  accountOf?: (id: string) => MailAccount | undefined
  /** Shown above the makeup bar, e.g. a sample-data notice. */
  banner?: ReactNode
  /** Right side of the summary line, e.g. a "Scan again" button. */
  actions?: ReactNode
  /** Open the review sheet for the selected senders. Without it (sample data) clearing is off. */
  onReview?: (chosen: CategorisedSender[]) => void
  /**
   * Open the review sheet to unsubscribe from one sender. Without it (sample data) the column only
   * says how each sender unsubscribes.
   */
  onUnsubscribe?: (sender: CategorisedSender) => void
}

/** Inbox makeup, category filters and a selectable sender list. People can never be selected. */
export function SenderTable({ senders, accountOf, banner, actions, onReview, onUnsubscribe }: Props) {
  const [filter, setFilter] = useState<Category | 'all'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const total = senders.reduce((n, s) => n + s.count, 0)
  const byCategory = CATEGORY_LABELS.map((c) => ({
    ...c,
    count: senders.filter((s) => s.category === c.id).reduce((n, s) => n + s.count, 0),
  })).filter((c) => c.count > 0)
  const notAutomated = byCategory
    .filter((c) => c.id === 'people' || c.id === 'uncategorised')
    .reduce((n, c) => n + c.count, 0)
  const visible = senders.filter((s) => filter === 'all' || s.category === filter)
  // People can't be selected, but never pass one on even if the state says so.
  const chosen = senders.filter((s) => selected.has(s.address) && s.category !== 'people')
  const chosenCount = chosen.reduce((n, s) => n + s.count, 0)

  const toggle = (address: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })

  return (
    <div className="flex flex-1 flex-col">
      <div className="px-6 pt-5">
        {banner}
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[20px] font-semibold tracking-tight">
            {total.toLocaleString()} emails from {senders.length.toLocaleString()} senders
          </h2>
          <div className="flex items-center gap-3">
            {total > 0 && (
              <span className="text-ink-2">
                {Math.round(((total - notAutomated) / total) * 100)}% automated
              </span>
            )}
            {actions}
          </div>
        </div>
        <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
          {byCategory.map((c) => (
            <div key={c.id} style={{ flex: c.count, background: categoryColor(c.id) }} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </Chip>
          {byCategory.map((c) => (
            <Chip key={c.id} active={filter === c.id} onClick={() => setFilter(c.id)}>
              <span className="size-2 rounded-full" style={{ background: categoryColor(c.id) }} />
              {c.label} <span className="text-ink-3">{c.count.toLocaleString()}</span>
            </Chip>
          ))}
        </div>
      </div>

      <div className="mt-4 flex-1 border-t border-sep">
        <table className="w-full table-fixed border-collapse">
          {/* Collapsed table borders don't stick, so the header's hairline is a shadow on its cells. */}
          <thead className="glass-bar sticky top-0 z-[1] text-left text-[11px] text-ink-3 [&_th]:shadow-[inset_0_-1px_0_var(--sep)]">
            <tr>
              <th className="w-10" />
              <th className="py-1.5 font-medium">Sender</th>
              <th className="w-20 pr-4 text-right font-medium">Emails</th>
              <th className="w-20 pr-4 text-right font-medium">Unread</th>
              <th className="w-36 font-medium">Unsubscribe</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s, i) => {
              const person = s.category === 'people'
              const isSel = selected.has(s.address)
              return (
                <tr
                  key={s.address}
                  onClick={() => !person && toggle(s.address)}
                  className={`${isSel ? 'bg-accent/15' : i % 2 ? 'bg-hover/50' : ''} ${person ? 'opacity-60' : 'hover:bg-hover'}`}
                >
                  <td className="pl-4">
                    <input
                      type="checkbox"
                      aria-label={`Select ${s.name ?? s.address}`}
                      checked={isSel}
                      disabled={person}
                      onChange={() => toggle(s.address)}
                      onClick={(e) => e.stopPropagation()}
                      className="accent-[var(--accent)]"
                    />
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: categoryColor(s.category) }}
                      />
                      <span className="truncate font-medium">{s.name ?? s.address}</span>
                      {s.sortedBy === 'ai' && (
                        <span
                          className="flex shrink-0 items-center text-ink-3"
                          title={`Sorted by AI${s.confidence !== undefined ? ` (${Math.round(s.confidence * 100)}% sure)` : ''}`}
                        >
                          <Sparkles size={11} aria-label="Sorted by AI" />
                        </span>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center gap-2 pl-4 text-[12px] text-ink-2">
                      <span className="truncate">
                        {person ? "Someone you've written to. Never included in bulk actions." : s.address}
                      </span>
                      {accountOf &&
                        s.accounts?.map((id) => {
                          const a = accountOf(id)
                          return a ? <AccountChip key={id} account={a} className="shrink-0" /> : null
                        })}
                    </div>
                  </td>
                  <td className="pr-4 text-right tabular-nums">{s.count.toLocaleString()}</td>
                  <td className="pr-4 text-right tabular-nums text-ink-2">
                    {Math.round((s.unread / s.count) * 100)}%
                  </td>
                  <td className="pr-3 text-ink-2">
                    <UnsubscribeCell sender={s} onUnsubscribe={person ? undefined : onUnsubscribe} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <footer className="glass-bar sticky bottom-0 z-[1] flex items-center justify-between gap-3 border-t border-sep px-5 py-2.5">
        <span className="flex items-center gap-1.5 text-ink-2">
          <ShieldCheck size={14} />
          {chosen.length
            ? `${chosen.length} ${chosen.length === 1 ? 'sender' : 'senders'}, ${chosenCount.toLocaleString()} ${chosenCount === 1 ? 'email' : 'emails'}. They'll go to Trash, and you can undo the move from History.`
            : 'Select senders to clear. Emails go to Trash, not deleted.'}
        </span>
        <Button
          variant="primary"
          icon={<Trash2 size={14} />}
          disabled={!chosen.length || !onReview}
          title={onReview ? undefined : 'Connect iCloud to clear your own mail'}
          onClick={() => onReview?.(chosen)}
        >
          Review and clear
        </Button>
      </footer>
    </div>
  )
}

function Chip(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={`flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] ${
        props.active ? 'border-transparent bg-selected text-ink' : 'border-sep text-ink-2 hover:bg-hover'
      }`}
    >
      {props.children}
    </button>
  )
}

const METHOD = {
  'one-click': { icon: Zap, about: 'One-click: Ordo unsubscribes for you' },
  link: { icon: ExternalLink, about: 'Web page: opens the sender’s unsubscribe page' },
  mailto: { icon: Mail, about: 'Email: Ordo sends an unsubscribe email from the address it came to' },
} as const

/**
 * The Unsubscribe column: an Unsubscribe button for a sender Ordo can unsubscribe from, "Unsubscribed"
 * once clean-up history says it has, or how the sender unsubscribes when there's no button (people,
 * sample data, or no way to unsubscribe).
 */
function UnsubscribeCell({
  sender: s,
  onUnsubscribe,
}: {
  sender: CategorisedSender
  onUnsubscribe?: (sender: CategorisedSender) => void
}) {
  const name = s.name ?? s.address
  const done = s.category === 'people' ? undefined : s.unsubscribed
  const canUnsubscribe = Boolean(onUnsubscribe) && s.unsubscribe.kind !== 'none' && s.category !== 'people'
  const when = done?.at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const open = () => onUnsubscribe?.(s)

  // Unsubscribed, but mail still came more than two days later: say so, and offer the button again.
  if (done && stillEmailing(s))
    return (
      <div className="flex flex-col items-start gap-0.5">
        {canUnsubscribe ? (
          <UnsubscribeButton sender={s} onClick={open} />
        ) : (
          <UnsubLabel kind={s.unsubscribe.kind} />
        )}
        <span
          className="flex items-center gap-1 text-[11px] font-medium text-warn"
          title={`Ordo unsubscribed on ${when}, but ${name} has emailed since.`}
        >
          <TriangleAlert size={11} className="shrink-0" aria-hidden />
          Still emailing
        </span>
      </div>
    )

  if (done) {
    const opened = done.status === 'opened'
    return (
      <div className="flex flex-col items-start gap-0.5">
        <span
          data-unsubscribe-for={s.address}
          tabIndex={-1}
          title={
            opened
              ? `Ordo opened the unsubscribe page on ${when}. Finish there if you haven’t.`
              : `Unsubscribed on ${when}`
          }
          className="flex items-center gap-1 text-[12px] text-ink outline-none"
        >
          <CircleCheck size={13} className="shrink-0 text-success" aria-hidden />
          {opened ? 'Page opened' : 'Unsubscribed'}
        </span>
        {canUnsubscribe && (
          <button
            type="button"
            aria-label={`Unsubscribe from ${name} again`}
            onClick={(e) => {
              // Never selects the row.
              e.stopPropagation()
              open()
            }}
            className="rounded-sm text-[11px] font-medium text-accent hover:underline"
          >
            Try again
          </button>
        )}
      </div>
    )
  }
  if (!canUnsubscribe) return <UnsubLabel kind={s.unsubscribe.kind} />
  return <UnsubscribeButton sender={s} onClick={open} />
}

function UnsubscribeButton({ sender: s, onClick }: { sender: CategorisedSender; onClick: () => void }) {
  if (s.unsubscribe.kind === 'none') return null
  const method = METHOD[s.unsubscribe.kind]
  const Icon = method.icon
  return (
    <button
      type="button"
      data-unsubscribe-for={s.address}
      aria-label={`Unsubscribe from ${s.name ?? s.address}`}
      aria-description={method.about}
      title={method.about}
      onClick={(e) => {
        // The button sits in a selectable row: unsubscribing never selects it.
        e.stopPropagation()
        onClick()
      }}
      className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-sep bg-field px-2 text-[12px] font-medium text-ink shadow-[0_1px_1px_rgb(0_0_0/0.06)] hover:bg-hover"
    >
      <Icon size={12} className="shrink-0 text-ink-2" aria-hidden />
      <span className="truncate">Unsubscribe</span>
    </button>
  )
}

function UnsubLabel({ kind }: { kind: CategorisedSender['unsubscribe']['kind'] }) {
  if (kind === 'one-click')
    return (
      <span className="flex items-center gap-1">
        <Zap size={12} /> One-click
      </span>
    )
  if (kind === 'link')
    return (
      <span className="flex items-center gap-1">
        <ExternalLink size={12} /> Link
      </span>
    )
  if (kind === 'mailto') return <span>Email only</span>
  return <span className="text-ink-3">None</span>
}
