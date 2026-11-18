import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, SquareKanban } from 'lucide-react'
import { toISODate, type Card, type Column, type UndoToken } from '@ordo/boards-core'
import type { BoardSummary, BoardView as BoardData } from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { BoardList } from '../components/boards/BoardList'
import { BoardSettingsSheet } from '../components/boards/BoardSettingsSheet'
import { BoardView, type BoardActions } from '../components/boards/BoardView'
import { CardDetail } from '../components/boards/CardDetail'
import { NewBoardSheet } from '../components/boards/NewBoardSheet'
import { ArchivedSheet, ConfirmSheet, LimitSheet } from '../components/boards/Sheets'
import { useToast } from '../components/boards/UndoToast'
import type { Route } from '../routes'

const SELECTED_KEY = 'ordo.boards.selected'

function savedBoard(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY)
  } catch {
    return null
  }
}

/** `#/boards?card=<id>` opens a card, e.g. from the Calendar. */
function cardFromHash(): string | null {
  const q = window.location.hash.split('?')[1]
  return q ? new URLSearchParams(q).get('card') : null
}

type Sheet =
  | { kind: 'new' }
  | { kind: 'settings' }
  | { kind: 'archive' }
  | { kind: 'limit'; column: Column }
  | { kind: 'delete-column'; column: Column; cards: number }
  | { kind: 'delete-board'; board: BoardSummary }

/** Boards: local kanban boards, with the list of boards on the left and the open board on the right. */
export function BoardsPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const api = window.ordo.boards
  const [boards, setBoards] = useState<BoardSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(savedBoard)
  const [view, setView] = useState<BoardData | null>(null)
  const [openCard, setOpenCard] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [message, setMessage] = useState('')
  const [today, setToday] = useState(() => toISODate())
  const selectedRef = useRef(selected)

  const select = useCallback((id: string | null) => {
    selectedRef.current = id
    setSelected(id)
    try {
      if (id) localStorage.setItem(SELECTED_KEY, id)
    } catch {
      // Not remembering the board is fine.
    }
  }, [])

  // Bumped by every change shown before the main process confirms it. A reload that started
  // before the latest such change is out of date, so it's dropped; that change reloads anyway.
  const epoch = useRef(0)
  const setViewNow: typeof setView = useCallback((update) => {
    epoch.current++
    setView(update)
  }, [])

  const reload = useCallback(async () => {
    const started = epoch.current
    const list = await api.list()
    const id = list.some((b) => b.id === selectedRef.current) ? selectedRef.current : (list[0]?.id ?? null)
    const next = id ? await api.board(id) : null
    if (epoch.current !== started) return
    setBoards(list)
    if (id !== selectedRef.current) select(id)
    setView(next)
  }, [api, select])

  const toast = useToast(reload)
  const announce = useCallback((m: string) => setMessage(m), [])

  useEffect(() => {
    let live = true
    void (async () => {
      // Opened on a card (from the Calendar): show its board.
      const card = cardFromHash()
      const detail = card ? await api.card(card) : null
      if (!live) return
      if (detail) {
        select(detail.card.boardId)
        setOpenCard(detail.card.id)
      }
      await reload()
    })()
    return () => {
      live = false
    }
  }, [api, reload, select])

  // A card link while Boards is already open.
  useEffect(() => {
    const onHash = () => {
      const card = cardFromHash()
      if (!card) return
      void api.card(card).then((d) => {
        if (!d) return
        select(d.card.boardId)
        setOpenCard(d.card.id)
        void reload()
      })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [api, reload, select])

  // Keep "today" right past midnight.
  useEffect(() => {
    const t = setInterval(() => setToday(toISODate()), 60_000)
    return () => clearInterval(t)
  }, [])

  const showBoard = async (id: string) => {
    select(id)
    setView(await api.board(id))
  }

  const offerUndo = useCallback((token: UndoToken, m: string) => toast.show(m, token), [toast])
  const showError = useCallback((m: string) => toast.show(m, undefined, true), [toast])

  const closeCard = useCallback(() => {
    setOpenCard(null)
    if (window.location.hash.includes('?')) history.replaceState(null, '', '#/boards')
  }, [])

  const openCardById = useCallback(
    async (id: string) => {
      const d = await api.card(id)
      if (!d) return
      if (d.card.boardId !== selectedRef.current) {
        select(d.card.boardId)
        setView(await api.board(d.card.boardId))
      }
      setOpenCard(id)
    },
    [api, select],
  )

  const actions: BoardActions = useMemo(
    () => ({
      reload,
      openCard: (id) => void openCardById(id),
      offerUndo,
      showError,
      announce,
      openSettings: () => setSheet({ kind: 'settings' }),
      openArchive: () => setSheet({ kind: 'archive' }),
      confirmDeleteColumn: (column, cards) => setSheet({ kind: 'delete-column', column, cards }),
      editLimit: (column) => setSheet({ kind: 'limit', column }),
    }),
    [announce, offerUndo, openCardById, reload, showError],
  )

  if (boards === null) return null

  return (
    <div className="flex h-full min-h-0">
      {boards.length > 0 && (
        <BoardList
          boards={boards}
          selected={selected}
          onSelect={(id) => void showBoard(id)}
          onNew={() => setSheet({ kind: 'new' })}
          onRename={async (b, name) => {
            const r = await api.renameBoard({ id: b.id, name })
            if (!r.ok) showError(r.message)
            await reload()
          }}
          onMove={async (b, index) => {
            setBoards((list) => {
              if (!list) return list
              const rest = list.filter((x) => x.id !== b.id)
              return [...rest.slice(0, index), b, ...rest.slice(index)]
            })
            announce(`Moved ${b.name} to position ${index + 1} of ${boards.length}.`)
            const r = await api.moveBoard({ id: b.id, index })
            if (!r.ok) showError(r.message)
            await reload()
          }}
          onDelete={(board) => setSheet({ kind: 'delete-board', board })}
        />
      )}

      {view ? (
        <BoardView key={view.board.id} view={view} setView={setViewNow} today={today} actions={actions} />
      ) : (
        <div className="flex-1">
          <EmptyState
            icon={<SquareKanban size={40} strokeWidth={1.5} />}
            title="No boards yet"
            body="Boards keep to-dos, plans and projects in columns you can drag cards between. They stay on this computer."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setSheet({ kind: 'new' })}>
                New board
              </Button>
            }
          />
        </div>
      )}

      <div aria-live="polite" className="sr-only">
        {message}
      </div>

      {view && openCard && (
        <CardDetail
          cardId={openCard}
          view={view}
          today={today}
          onClose={closeCard}
          onChanged={reload}
          offerUndo={offerUndo}
          onOpenCard={(id) => void openCardById(id)}
          onOpenSettings={() => onNavigate('settings')}
          announce={announce}
        />
      )}

      {sheet?.kind === 'new' && (
        <NewBoardSheet
          onClose={() => setSheet(null)}
          onCreated={async (b) => {
            setSheet(null)
            select(b.id)
            await reload()
            announce(`Made the ${b.name} board.`)
          }}
        />
      )}
      {sheet?.kind === 'settings' && view && (
        <BoardSettingsSheet
          view={view}
          onClose={() => setSheet(null)}
          onChanged={reload}
          offerUndo={offerUndo}
        />
      )}
      {sheet?.kind === 'archive' && view && (
        <ArchivedSheet
          view={view}
          today={today}
          onClose={() => setSheet(null)}
          onChanged={reload}
          onOpenCard={(id) => {
            setSheet(null)
            void openCardById(id)
          }}
          onDeleted={(c: Card, token) => offerUndo(token, `Deleted “${c.title}”`)}
        />
      )}
      {sheet?.kind === 'limit' && (
        <LimitSheet
          column={sheet.column}
          onClose={() => setSheet(null)}
          onSave={async (wipLimit) => {
            const r = await api.updateColumn({ id: sheet.column.id, wipLimit })
            await reload()
            return r.ok ? null : r.message
          }}
        />
      )}
      {sheet?.kind === 'delete-column' && (
        <ConfirmSheet
          title={`Delete ${sheet.column.name}?`}
          body={`Its ${sheet.cards === 1 ? 'card goes' : `${sheet.cards} cards go`} with it. You can undo this straight afterwards.`}
          action="Delete column"
          onClose={() => setSheet(null)}
          onConfirm={async () => {
            const r = await api.deleteColumn(sheet.column.id)
            if (r.ok) offerUndo(r.value, `Deleted ${sheet.column.name}`)
            else showError(r.message)
            await reload()
          }}
        />
      )}
      {sheet?.kind === 'delete-board' && (
        <ConfirmSheet
          title={`Delete ${sheet.board.name}?`}
          body={`The board and its ${sheet.board.cards === 1 ? 'card' : `${sheet.board.cards} cards`} are deleted from this computer. You can undo this straight afterwards.`}
          action="Delete board"
          onClose={() => setSheet(null)}
          onConfirm={async () => {
            const r = await api.deleteBoard(sheet.board.id)
            if (r.ok) offerUndo(r.value, `Deleted ${sheet.board.name}`)
            else showError(r.message)
            await reload()
          }}
        />
      )}
      {toast.node}
    </div>
  )
}
