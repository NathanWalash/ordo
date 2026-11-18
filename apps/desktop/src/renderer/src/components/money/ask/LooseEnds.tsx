import { useState } from 'react'
import { HandCoins, Plus } from 'lucide-react'
import { formatPence, poundsToPence, toISODate } from '@ordo/money-core'
import type { MemoryResult, MemoryView, SaveFactInput } from '@ordo/shared'
import { Button } from '../../Button'
import { Sheet } from '../../Sheet'
import { TextField } from '../../TextField'
import { Notice, Panel, formatDate } from '../ui'

/** Money you hold for others that hasn't gone on, who owes you, and who you pay back and forth. */
export function LooseEndsPanel({
  view,
  onSave,
}: {
  view: MemoryView
  onSave: (input: SaveFactInput) => Promise<MemoryResult>
}) {
  const [adding, setAdding] = useState(false)
  const owed = view.owed.filter((o) => o.outstanding > 0)
  const empty = !view.held.length && !owed.length && !view.billsOwed.length
  return (
    <Panel
      title="Loose ends"
      actions={
        <Button className="h-6 px-2 text-[12px]" icon={<Plus size={12} />} onClick={() => setAdding(true)}>
          Someone owes me
        </Button>
      }
    >
      <ul aria-label="Loose ends" className="flex flex-col">
        {view.held.map((h) => (
          <li key={h.factId} className="border-b border-sep px-4 py-2 last:border-b-0">
            <div className="flex items-baseline justify-between gap-2">
              <span>
                Holding for <span className="font-medium">{h.forPerson}</span>
              </span>
              <span className="font-medium tabular-nums">{formatPence(h.holding)}</span>
            </div>
            <div className="text-[12px] text-ink-2">
              {h.what ? `${h.what.charAt(0).toUpperCase()}${h.what.slice(1)} from ` : 'From '}
              {h.from}
              {h.lastIn && `, last in ${formatDate(h.lastIn, true)}`}
              {h.holding > 0 ? ' · not passed on yet' : ' · all passed on'}
            </div>
          </li>
        ))}
        {owed.map((o) => (
          <li key={o.factId} className="border-b border-sep px-4 py-2 last:border-b-0">
            <div className="flex items-baseline justify-between gap-2">
              <span>
                <span className="font-medium">{o.person}</span> owes you
              </span>
              <span className="font-medium text-success tabular-nums">{formatPence(o.outstanding)}</span>
            </div>
            <div className="text-[12px] text-ink-2">
              {o.note ? `${o.note} · ` : ''}since {formatDate(o.date, true)}
              {o.received > 0 && ` · ${formatPence(o.received)} paid back`}
            </div>
          </li>
        ))}
        {view.billsOwed.map((o) => (
          <li key={`bills-${o.person}`} className="border-b border-sep px-4 py-2 last:border-b-0">
            <div className="flex items-baseline justify-between gap-2">
              <span>
                <span className="font-medium">{o.person}</span> owes you
              </span>
              <span className="font-medium text-success tabular-nums">{formatPence(o.amount)}</span>
            </div>
            <div className="text-[12px] text-ink-2">Shared bills</div>
          </li>
        ))}
        {empty && (
          <li className="flex items-center gap-2 px-4 py-3 text-ink-2">
            <HandCoins size={14} className="shrink-0" /> Nothing outstanding. Money you hold for others and
            money you’re owed show up here.
          </li>
        )}
      </ul>
      {view.people.length > 0 && (
        <div className="border-t border-sep px-4 py-2">
          <h4 className="mb-1 text-[11px] font-semibold text-ink-3">Back and forth</h4>
          <ul aria-label="Back and forth" className="flex flex-col gap-0.5">
            {view.people.slice(0, 5).map((p) => (
              <li key={p.key} className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 text-ink-2 tabular-nums">
                  sent {formatPence(p.sent)} · got {formatPence(p.received)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {adding && <OwedSheet onClose={() => setAdding(false)} onSave={onSave} />}
    </Panel>
  )
}

function OwedSheet({
  onClose,
  onSave,
}: {
  onClose: () => void
  onSave: (input: SaveFactInput) => Promise<MemoryResult>
}) {
  const [person, setPerson] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const pence = poundsToPence(amount)
    if (!person.trim()) return setError('Who owes you?')
    if (pence === null || pence <= 0) return setError('Enter how much, like 30 or 12.50.')
    setBusy(true)
    const r = await onSave({
      fact: { kind: 'owed', person: person.trim(), amount: pence, date: toISODate(), note: note.trim() },
    })
    setBusy(false)
    if (!r.ok) return setError(r.message)
    onClose()
  }

  return (
    <Sheet
      title="Someone owes me"
      subtitle="Ordo keeps it in Loose ends until a payback from them comes in."
      icon={<HandCoins size={22} />}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
        </>
      }
    >
      <TextField label="Who" value={person} maxLength={60} onChange={(e) => setPerson(e.target.value)} />
      <TextField
        label="How much (£)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <TextField
        label="What for"
        hint="Optional, like Halloween or concert tickets."
        value={note}
        maxLength={80}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  )
}
