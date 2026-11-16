import { useMemo, useState, type ReactNode } from 'react'
import { Zap, ExternalLink, Trash2, ShieldCheck } from 'lucide-react'
import { groupBySender, type Category, type SenderSummary } from '@ordo/mail-core'
import { SAMPLE_CATEGORY, sampleHeaders } from './sampleData'

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'promotions', label: 'Promotions' },
  { id: 'newsletters', label: 'Newsletters' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'receipts', label: 'Receipts' },
  { id: 'people', label: 'People' },
]
const color = (c: Category) => `var(--${c})`

export function UnclutterPage() {
  const senders = useMemo(() => groupBySender(sampleHeaders()), [])
  const categoryOf = (s: SenderSummary): Category => SAMPLE_CATEGORY.get(s.address) ?? 'uncategorised'
  const [filter, setFilter] = useState<Category | 'all'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const total = senders.reduce((n, s) => n + s.count, 0)
  const byCategory = CATEGORIES.map((c) => ({
    ...c,
    count: senders.filter((s) => categoryOf(s) === c.id).reduce((n, s) => n + s.count, 0),
  }))
  const automated = total - (byCategory.find((c) => c.id === 'people')?.count ?? 0)
  const visible = senders.filter((s) => filter === 'all' || categoryOf(s) === filter)
  const chosen = senders.filter((s) => selected.has(s.address))
  const chosenCount = chosen.reduce((n, s) => n + s.count, 0)

  const toggle = (address: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(address)) next.delete(address)
      else next.add(address)
      return next
    })

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-5">
        <div className="mb-3 rounded-md bg-hover px-3 py-2 text-ink-2">
          Sample data. Connect your iCloud account to scan your own inbox.
        </div>
        <div className="flex items-baseline justify-between">
          <h2 className="text-[20px] font-semibold tracking-tight">
            {total.toLocaleString()} emails from {senders.length} senders
          </h2>
          <span className="text-ink-2">{Math.round((automated / total) * 100)}% automated</span>
        </div>
        <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
          {byCategory.map((c) => (
            <div key={c.id} style={{ flex: c.count, background: color(c.id) }} />
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by category">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </Chip>
          {byCategory.map((c) => (
            <Chip key={c.id} active={filter === c.id} onClick={() => setFilter(c.id)}>
              <span className="size-2 rounded-full" style={{ background: color(c.id) }} />
              {c.label} <span className="text-ink-3">{c.count.toLocaleString()}</span>
            </Chip>
          ))}
        </div>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto border-t border-sep">
        <table className="w-full table-fixed border-collapse">
          <thead className="sticky top-0 bg-content text-left text-[11px] text-ink-3">
            <tr className="border-b border-sep">
              <th className="w-10" />
              <th className="py-1.5 font-medium">Sender</th>
              <th className="w-20 pr-4 text-right font-medium">Emails</th>
              <th className="w-20 pr-4 text-right font-medium">Unread</th>
              <th className="w-32 font-medium">Unsubscribe</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s, i) => {
              const cat = categoryOf(s)
              const person = cat === 'people'
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
                      <span className="size-2 shrink-0 rounded-full" style={{ background: color(cat) }} />
                      <span className="truncate font-medium">{s.name ?? s.address}</span>
                    </div>
                    <div className="truncate pl-4 text-[12px] text-ink-2">
                      {person ? 'A person. Never included in bulk actions.' : s.address}
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

      <footer className="flex items-center justify-between gap-3 border-t border-sep px-5 py-2.5">
        <span className="flex items-center gap-1.5 text-ink-2">
          <ShieldCheck size={14} />
          {chosen.length
            ? `${chosen.length} senders, ${chosenCount.toLocaleString()} emails. They go to Trash, recoverable for 30 days.`
            : 'Select senders to clear. Emails go to Trash, not deleted.'}
        </span>
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 font-medium text-white enabled:hover:brightness-110"
          onClick={() => alert('Review step comes with the iCloud connection.')}
        >
          <Trash2 size={14} /> Review and clear
        </button>
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

function UnsubLabel({ kind }: { kind: SenderSummary['unsubscribe']['kind'] }) {
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
