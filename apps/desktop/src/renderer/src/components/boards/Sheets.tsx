import { useEffect, useState } from 'react'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import type { Card, Column, ISODate } from '@ordo/boards-core'
import type { BoardView } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'
import { datesLabel } from './model'

/** A board's archived cards, to restore or delete. */
export function ArchivedSheet({
  view,
  today,
  onClose,
  onChanged,
  onOpenCard,
  onDeleted,
}: {
  view: BoardView
  today: ISODate
  onClose: () => void
  onChanged: () => Promise<void>
  onOpenCard: (id: string) => void
  onDeleted: (card: Card, token: Parameters<Window['ordo']['boards']['restore']>[0]) => void
}) {
  const api = window.ordo.boards
  const [cards, setCards] = useState<Card[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let live = true
    void api.archived(view.board.id).then((c) => live && setCards(c))
    return () => {
      live = false
    }
  }, [api, view.board.id, version])
  const columns = new Map(view.columns.map((c) => [c.id, c.name]))
  const after = async () => {
    setVersion((v) => v + 1)
    await onChanged()
  }

  return (
    <Sheet
      title="Archived cards"
      subtitle={view.board.name}
      icon={<Archive size={22} />}
      width={520}
      onClose={onClose}
      onSubmit={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Button type="submit" variant="primary">
            Done
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
      {cards === null ? (
        <p className="py-6 text-center text-[13px] text-ink-2" role="status">
          Loading…
        </p>
      ) : cards.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-2">
          Nothing archived. Archive cards you’re finished with to keep the board tidy without deleting them.
        </p>
      ) : (
        <ul
          className="flex max-h-[360px] flex-col divide-y divide-sep overflow-y-auto rounded-lg border border-sep"
          aria-label="Archived cards"
        >
          {cards?.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-2">
              <button type="button" onClick={() => onOpenCard(c.id)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-[13px] font-medium">{c.title}</span>
                <span className="block truncate text-[11px] text-ink-2">
                  {[columns.get(c.columnId), datesLabel(c, today)].filter(Boolean).join(' · ')}
                </span>
              </button>
              <Button
                icon={<ArchiveRestore size={13} />}
                onClick={async () => {
                  const r = await api.archiveCard({ id: c.id, archived: false })
                  setError(r.ok ? null : r.message)
                  await after()
                }}
              >
                Restore
              </Button>
              <button
                type="button"
                aria-label={`Delete ${c.title}`}
                title="Delete"
                onClick={async () => {
                  const r = await api.deleteCard(c.id)
                  if (r.ok) onDeleted(c, r.value)
                  setError(r.ok ? null : r.message)
                  await after()
                }}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

/** Set or clear a column's card limit. */
export function LimitSheet({
  column,
  onClose,
  onSave,
}: {
  column: Column
  onClose: () => void
  onSave: (limit: number | null) => Promise<string | null>
}) {
  const [value, setValue] = useState(column.wipLimit === null ? '' : String(column.wipLimit))
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const n = value.trim() ? Number(value) : null
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999))
      return setError('Enter a whole number of cards.')
    const message = await onSave(n || null)
    if (message) setError(message)
    else onClose()
  }
  return (
    <Sheet
      title={`Card limit for ${column.name}`}
      subtitle="The column turns red when it has more cards than this. Nothing is blocked."
      width={420}
      onClose={onClose}
      onSubmit={() => void save()}
      footer={
        <>
          {column.wipLimit !== null && (
            <Button onClick={() => void onSave(null).then(onClose)}>Remove limit</Button>
          )}
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </>
      }
    >
      <TextField
        label="Card limit"
        type="number"
        min={0}
        max={999}
        value={value}
        placeholder="No limit"
        onChange={(e) => setValue(e.target.value)}
        error={error ?? undefined}
      />
    </Sheet>
  )
}

/** "Delete X?" with a red button. Deletes can be undone straight afterwards. */
export function ConfirmSheet({
  title,
  body,
  action,
  onClose,
  onConfirm,
}: {
  title: string
  body: string
  action: string
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Sheet
      title={title}
      width={420}
      onClose={onClose}
      onSubmit={() => {
        onClose()
        onConfirm()
      }}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" className="!bg-danger">
            {action}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-snug text-ink-2">{body}</p>
    </Sheet>
  )
}
