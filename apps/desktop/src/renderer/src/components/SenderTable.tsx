import { useState, type ReactNode } from 'react'
import { ExternalLink, ShieldCheck, Sparkles, Trash2, Zap } from 'lucide-react'
import type { Category, CategorisedSender } from '@ordo/mail-core'
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
  /** Shown above the makeup bar, e.g. a sample-data notice. */
  banner?: ReactNode
  /** Right side of the summary line, e.g. a "Scan again" button. */
  actions?: ReactNode
  /** Open the review sheet for the selected senders. Without it (sample data) clearing is off. */
  onReview?: (chosen: CategorisedSender[]) => void
}

/** Inbox makeup, category filters and a selectable sender list. People can never be selected. */
export function SenderTable({ senders, banner, actions, onReview }: Props) {
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
              <th className="w-32 font-medium">Unsubscribe</th>
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
                    <div className="truncate pl-4 text-[12px] text-ink-2">
                      {person ? "Someone you've written to. Never included in bulk actions." : s.address}
                    </div>
                  </td>
                  <td className="pr-4 text-right tabular-nums">{s.count.toLocaleString()}</td>
                  <td className="pr-4 text-right tabular-nums text-ink-2">
                    {Math.round((s.unread / s.count) * 100)}%
                  </td>
                  <td className="text-ink-2">
                    <UnsubLabel kind={s.unsubscribe.kind} />
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
