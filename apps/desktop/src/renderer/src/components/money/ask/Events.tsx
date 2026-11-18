import { useState } from 'react'
import { ChevronRight, PartyPopper, Plus } from 'lucide-react'
import { formatPence, isISODate } from '@ordo/money-core'
import type { EventCost, MemoryResult, SaveFactInput } from '@ordo/shared'
import { Button } from '../../Button'
import { Sheet } from '../../Sheet'
import { TextField } from '../../TextField'
import { Notice, Panel, formatDate } from '../ui'

/** Events and trips: what went out, what came back and what each cost you, across every account. */
export function EventsPanel({
  events,
  onSave,
  onForget,
}: {
  events: EventCost[]
  onSave: (input: SaveFactInput) => Promise<MemoryResult>
  onForget: (id: string) => Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <Panel
      title="Events and trips"
      actions={
        <Button className="h-6 px-2 text-[12px]" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
          Add event
        </Button>
      }
    >
      {events.length ? (
        <ul aria-label="Events and trips">
          {events.map((e) => {
            const expanded = open === e.id
            return (
              <li key={e.id} className="border-b border-sep last:border-b-0">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : e.id)}
                  className="no-drag grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 px-4 py-2 text-left hover:bg-hover"
                >
                  <ChevronRight
                    size={13}
                    className={`text-ink-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{e.name}</span>
                    <span className="block text-[12px] text-ink-2">
                      {e.from && e.to ? `${formatDate(e.from, true)} – ${formatDate(e.to, true)} · ` : ''}
                      {formatPence(e.paidOut)} out
                      {e.paidBack > 0 && ` · ${formatPence(e.paidBack)} back`}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold tabular-nums">{formatPence(e.net)}</span>
                    <span className="block text-[11px] text-ink-3">net</span>
                  </span>
                </button>
                {expanded && <EventDetail event={e} onForget={() => void onForget(e.id)} />}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="px-4 py-3 text-ink-2">
          Add an event or trip, like a holiday or a party, to see what it really cost you once paybacks are
          in.
        </p>
      )}
      {adding && <EventSheet onClose={() => setAdding(false)} onSave={onSave} />}
    </Panel>
  )
}

function EventDetail({ event: e, onForget }: { event: EventCost; onForget: () => void }) {
  return (
    <div className="flex flex-col gap-3 px-4 pt-1 pb-3 pl-9">
      <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2">
        <Breakdown title="By type" rows={e.byCategory.map((c) => [c.category, c.amount])} />
        <Breakdown title="By account" rows={e.byAccount.map((a) => [a.account, a.amount])} />
      </div>
      {e.paybacks.length > 0 && (
        <Breakdown
          title="Paid back"
          rows={e.paybacks.map((p) => [`${p.person ?? p.name}, ${formatDate(p.date, true)}`, p.amount])}
        />
      )}
      <details className="text-[12px]">
        <summary className="cursor-default text-ink-2">
          {e.outgoings.length} payment{e.outgoings.length === 1 ? '' : 's'}
          {e.excluded > 0 && `, ${e.excluded} left out`}
        </summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          {e.outgoings.map((o) => (
            <li key={o.id} className="flex justify-between gap-2">
              <span className="truncate">
                {formatDate(o.date, true)} · {o.name} · <span className="text-ink-3">{o.account}</span>
              </span>
              <span className="tabular-nums">{formatPence(o.amount)}</span>
            </li>
          ))}
        </ul>
      </details>
      <div>
        <Button className="h-6 px-2.5 text-[12px]" onClick={onForget} aria-label={`Forget ${e.name}`}>
          Forget event
        </Button>
      </div>
    </div>
  )
}

function Breakdown({ title, rows }: { title: string; rows: [string, number][] }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold text-ink-3">{title}</h4>
      <ul className="flex flex-col gap-0.5 text-[12px]">
        {rows.map(([label, amount]) => (
          <li key={label} className="flex justify-between gap-2">
            <span className="truncate text-ink-2">{label}</span>
            <span className="tabular-nums">{formatPence(amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EventSheet({
  onClose,
  onSave,
}: {
  onClose: () => void
  onSave: (input: SaveFactInput) => Promise<MemoryResult>
}) {
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [leaveOut, setLeaveOut] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!name.trim()) return setError('Give the event a name.')
    if (!isISODate(from) || !isISODate(to)) return setError('Choose when it started and ended.')
    if (from > to) return setError('The end is before the start.')
    const excludeMerchants = leaveOut
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20)
    setBusy(true)
    const r = await onSave({ fact: { kind: 'event', name: name.trim(), from, to, excludeMerchants } })
    setBusy(false)
    if (!r.ok) return setError(r.message)
    onClose()
  }

  return (
    <Sheet
      title="Add an event or trip"
      subtitle="Ordo adds up what you spent in those dates across every account. Rent, bills and payments to people aren’t counted."
      icon={<PartyPopper size={22} />}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Add event
          </Button>
        </>
      }
    >
      <TextField
        label="Name"
        placeholder="Italy"
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <TextField
        label="Leave out"
        hint="Merchants not to count, separated by commas. For example, Ryanair to leave out flights."
        value={leaveOut}
        onChange={(e) => setLeaveOut(e.target.value)}
      />
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  )
}
