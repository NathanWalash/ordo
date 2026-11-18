import { useEffect, useState } from 'react'
import { SquareKanban } from 'lucide-react'
import { addDays, occurrenceStart, toISODate, type Column } from '@ordo/boards-core'
import type { BoardSummary, CalendarEvent } from '@ordo/shared'
import { Button } from '../Button'
import { Select } from '../money/ui'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'

/**
 * Make a card from a calendar event: its title, due on the event's day (the day before, if you
 * like) and linked to the event, so the card shows it.
 */
export function CreateCardSheet({
  event,
  calendarName,
  onClose,
  onCreated,
}: {
  event: CalendarEvent
  calendarName?: string
  onClose: () => void
  onCreated: (cardId: string, boardName: string) => void
}) {
  const api = window.ordo.boards
  const day = toISODate(event.start)
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [boardId, setBoardId] = useState('')
  const [columns, setColumns] = useState<Column[]>([])
  const [columnId, setColumnId] = useState('')
  const [title, setTitle] = useState(event.title)
  const [due, setDue] = useState(day)
  const [busy, setBusy] = useState(false)
  // A board made for this card on an earlier try, so trying again doesn't make another.
  const [madeBoard, setMadeBoard] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void api.list().then((list) => {
      if (!live) return
      setBoards(list)
      setBoardId((id) => id || list[0]?.id || '')
    })
    return () => {
      live = false
    }
  }, [api])

  useEffect(() => {
    if (!boardId) return
    let live = true
    void api.board(boardId).then((v) => {
      if (!live || !v) return
      setColumns(v.columns)
      setColumnId(v.columns.find((c) => !c.done)?.id ?? v.columns[0]?.id ?? '')
    })
    return () => {
      live = false
    }
  }, [api, boardId])

  const create = async () => {
    setBusy(true)
    let board = boardId || madeBoard
    if (!board) {
      // No boards yet: make a simple one to put it on.
      const made = await api.createBoard({ name: 'To do', template: 'simple' })
      if (!made.ok) {
        setBusy(false)
        return setError(made.message)
      }
      board = made.value.id
      setMadeBoard(board)
    }
    const r = await api.addCard({
      boardId: board,
      columnId: columnId || undefined,
      title,
      due: due || null,
      link: {
        target: {
          kind: 'event',
          calendarId: event.calendarId,
          uid: event.uid,
          start: occurrenceStart(event),
        },
        title: event.title,
        detail: calendarName ?? null,
        date: day,
      },
    })
    setBusy(false)
    if (r.ok) onCreated(r.value.id, (await api.list()).find((b) => b.id === board)?.name ?? 'Boards')
    else setError(r.message)
  }

  return (
    <Sheet
      title="Create card"
      subtitle={`From “${event.title}”`}
      icon={<SquareKanban size={22} />}
      width={440}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void create()}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !title.trim() || boards === null}>
            Create card
          </Button>
        </>
      }
    >
      <TextField
        label="Title"
        value={title}
        maxLength={300}
        onChange={(e) => setTitle(e.target.value)}
        error={error ?? undefined}
      />
      {boards && boards.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          <Select label="Board" value={boardId} onChange={(e) => setBoardId(e.target.value)}>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Select label="Column" value={columnId} onChange={(e) => setColumnId(e.target.value)}>
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        boards && (
          <p className="text-[12px] text-ink-2">You have no boards yet. Ordo will make one called To do.</p>
        )
      )}
      <div className="flex flex-col gap-1.5">
        <TextField label="Due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <span className="flex gap-3 text-[11px]">
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={() => setDue(day)}
          >
            On the day
          </button>
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={() => setDue(addDays(day, -1))}
          >
            The day before
          </button>
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={() => setDue('')}
          >
            No date
          </button>
        </span>
      </div>
      <p className="text-[12px] text-ink-2">The card links to this event.</p>
    </Sheet>
  )
}
