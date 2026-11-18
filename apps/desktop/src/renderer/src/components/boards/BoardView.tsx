import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ListFilter,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import {
  filterCards,
  isFiltering,
  type Card,
  type CardFilter,
  type Column,
  type DueFilter,
  type ISODate,
  type UndoToken,
} from '@ordo/boards-core'
import type { BoardView as BoardData } from '@ordo/shared'
import { Button } from '../Button'
import { CardTile } from './CardTile'
import { ColumnLane, NameInput } from './ColumnLane'
import { Menu, type MenuAnchor, type MenuItem } from './Menu'
import { byColumn, focusTarget, fullIndex, moveLocally, reorder, stepTarget, type Direction } from './model'
import { useDrag } from './useDrag'

export interface BoardActions {
  /** Fetch the board again from the main process. */
  reload: () => Promise<void>
  openCard: (id: string) => void
  offerUndo: (token: UndoToken, message: string) => void
  showError: (message: string) => void
  announce: (message: string) => void
  openSettings: () => void
  openArchive: () => void
  confirmDeleteColumn: (column: Column, cards: number) => void
  editLimit: (column: Column) => void
}

interface Props {
  view: BoardData
  setView: Dispatch<SetStateAction<BoardData | null>>
  today: ISODate
  actions: BoardActions
}

const ARROWS: Record<string, Direction> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
}

const DUE_OPTIONS: { value: DueFilter; label: string }[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due in the next week' },
  { value: 'dated', label: 'Has a date' },
  { value: 'none', label: 'No date' },
]

type CardTarget = { columnId: string; index: number }

/** The columns and cards of one board, with search, filters, drag and drop and keyboard moves. */
export function BoardView({ view, setView, today, actions }: Props) {
  const api = window.ordo.boards
  const { board, columns, labels, fields } = view
  const help = useId()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Omit<CardFilter, 'query'>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [addingColumn, setAddingColumn] = useState(false)
  const [menu, setMenu] = useState<{ label: string; anchor: MenuAnchor; items: MenuItem[] } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const lists = useRef(new Map<string, HTMLDivElement>())
  const focusAfter = useRef<{ kind: 'card' | 'column'; id: string } | null>(null)

  const labelMap = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels])
  const onCard = useMemo(() => fields.filter((f) => f.showOnCard), [fields])
  const doneColumns = useMemo(() => new Set(columns.filter((c) => c.done).map((c) => c.id)), [columns])
  const fullFilter: CardFilter = useMemo(() => ({ ...filter, query }), [filter, query])
  const filtering = isFiltering(fullFilter)
  const visible = useMemo(
    () => filterCards(view.cards, fullFilter, { labels, fields, today, doneColumns }),
    [view.cards, fullFilter, labels, fields, today, doneColumns],
  )
  const all = useMemo(() => byColumn(columns, view.cards), [columns, view.cards])
  const shown = useMemo(() => byColumn(columns, visible), [columns, visible])

  // Keep focus on a card or column moved with the keyboard: it may be drawn again in another
  // column, first straight away and then once the main process has confirmed the move.
  const refocus = useCallback(() => {
    const f = focusAfter.current
    if (!f) return
    const el = document.querySelector<HTMLElement>(
      f.kind === 'card'
        ? `[data-card-id="${CSS.escape(f.id)}"]`
        : `[data-column-id="${CSS.escape(f.id)}"] [role="group"]`,
    )
    if (el && document.activeElement !== el) el.focus()
  }, [])
  useEffect(refocus)
  const settle = useCallback(() => {
    requestAnimationFrame(() => {
      refocus()
      focusAfter.current = null
    })
  }, [refocus])

  // ⌘F searches the board.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const result = useCallback(
    async <T,>(p: Promise<{ ok: true; value: T } | { ok: false; message: string }>): Promise<T | null> => {
      const r = await p
      if (!r.ok) actions.showError(r.message)
      return r.ok ? r.value : null
    },
    [actions],
  )

  // Moving cards

  const otherIds = (columnId: string, cardId: string, source: Map<string, Card[]>) =>
    (source.get(columnId) ?? []).filter((c) => c.id !== cardId).map((c) => c.id)

  const moveCard = useCallback(
    async (card: Card, columnId: string, visibleIndex: number, how: 'drag' | 'keys') => {
      const index = fullIndex(
        otherIds(columnId, card.id, all),
        otherIds(columnId, card.id, shown),
        visibleIndex,
      )
      const column = columns.find((c) => c.id === columnId)!
      setView((v) => v && { ...v, cards: moveLocally(v.cards, card.id, columnId, index) })
      if (how === 'keys') focusAfter.current = { kind: 'card', id: card.id }
      const count = otherIds(columnId, card.id, all).length + 1
      actions.announce(
        `Moved “${card.title}” to ${column.name}, position ${index + 1} of ${count}.` +
          (column.wipLimit !== null && count > column.wipLimit
            ? ` ${column.name} is over its limit of ${column.wipLimit}.`
            : ''),
      )
      await result(api.moveCard({ id: card.id, columnId, index }))
      await actions.reload()
      settle()
    },
    [actions, all, api, columns, result, setView, settle, shown],
  )

  const step = (card: Card, dir: Direction) => {
    const lanes = columns.map((c) => ({ id: c.id, cards: (shown.get(c.id) ?? []).map((x) => x.id) }))
    const target = stepTarget(lanes, card.id, dir)
    if (target) void moveCard(card, target.columnId, target.index, 'keys')
    else
      actions.announce(
        `“${card.title}” can’t move ${dir === 'up' || dir === 'down' ? dir : `further ${dir}`}.`,
      )
  }

  const removeCard = async (card: Card) => {
    setView((v) => v && { ...v, cards: v.cards.filter((c) => c.id !== card.id) })
    const token = await result(api.deleteCard(card.id))
    if (token) actions.offerUndo(token, `Deleted “${card.title}”`)
    await actions.reload()
  }

  const archiveCard = async (card: Card) => {
    setView((v) => v && { ...v, cards: v.cards.filter((c) => c.id !== card.id) })
    await result(api.archiveCard({ id: card.id, archived: true }))
    actions.announce(`Archived “${card.title}”.`)
    await actions.reload()
  }

  const cardMenu = (card: Card, anchor: MenuAnchor) => {
    const col = columns.findIndex((c) => c.id === card.columnId)
    const pos = (shown.get(card.columnId) ?? []).findIndex((c) => c.id === card.id)
    const count = shown.get(card.columnId)?.length ?? 0
    setMenu({
      label: `Options for ${card.title}`,
      anchor,
      items: [
        { label: 'Open', onSelect: () => actions.openCard(card.id), hint: '↩' },
        { separator: true },
        {
          label: 'Move left',
          icon: <ArrowLeft size={13} />,
          hint: '⌥←',
          disabled: col <= 0,
          onSelect: () => step(card, 'left'),
        },
        {
          label: 'Move right',
          icon: <ArrowRight size={13} />,
          hint: '⌥→',
          disabled: col >= columns.length - 1,
          onSelect: () => step(card, 'right'),
        },
        {
          label: 'Move up',
          icon: <ArrowUp size={13} />,
          hint: '⌥↑',
          disabled: pos <= 0,
          onSelect: () => step(card, 'up'),
        },
        {
          label: 'Move down',
          icon: <ArrowDown size={13} />,
          hint: '⌥↓',
          disabled: pos >= count - 1,
          onSelect: () => step(card, 'down'),
        },
        { heading: 'Move to' },
        ...columns.map((c): MenuItem => ({
          label: c.name,
          checked: c.id === card.columnId,
          onSelect: () => {
            if (c.id !== card.columnId) void moveCard(card, c.id, Number.MAX_SAFE_INTEGER, 'keys')
          },
        })),
        { separator: true },
        { label: 'Archive', icon: <Archive size={13} />, onSelect: () => void archiveCard(card) },
        {
          label: 'Delete',
          icon: <Trash2 size={13} />,
          hint: '⌫',
          danger: true,
          onSelect: () => void removeCard(card),
        },
      ],
    })
  }

  const onCardKey = (card: Card) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = ARROWS[e.key]
    if (dir && e.altKey) {
      e.preventDefault()
      step(card, dir)
    } else if (dir && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault()
      const lanes = columns.map((c) => ({ id: c.id, cards: (shown.get(c.id) ?? []).map((x) => x.id) }))
      const next = focusTarget(lanes, card.id, dir)
      if (next) document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(next)}"]`)?.focus()
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      void removeCard(card)
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      cardMenu(card, e.currentTarget.getBoundingClientRect())
    }
  }

  // Drag and drop: cards

  const cardDrag = useDrag<Card, CardTarget>({
    findTarget: (x, y, card) => {
      const lanes = [...lists.current.entries()].filter(([id]) => columns.some((c) => c.id === id))
      if (!lanes.length) return null
      // The column under the pointer, or the nearest one.
      let best: { id: string; el: HTMLDivElement; d: number } | null = null
      for (const [id, el] of lanes) {
        const r = el.parentElement!.getBoundingClientRect()
        const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
        if (!best || d < best.d) best = { id, el, d }
      }
      if (!best) return null
      const cards = [...best.el.querySelectorAll<HTMLElement>('[data-card-id]')].filter(
        (el) => el.dataset['cardId'] !== card.id,
      )
      const index = cards.findIndex((el) => {
        const r = el.getBoundingClientRect()
        return y < r.top + r.height / 2
      })
      return { columnId: best.id, index: index === -1 ? cards.length : index }
    },
    onDrop: (card, t) => void moveCard(card, t.columnId, t.index, 'drag'),
    scrollers: () => [scroller.current, ...lists.current.values()],
  })

  // Drag and drop and keyboard: columns

  const moveColumn = async (column: Column, index: number, how: 'drag' | 'keys') => {
    setView((v) => v && { ...v, columns: reorder(v.columns, column.id, index) })
    if (how === 'keys') focusAfter.current = { kind: 'column', id: column.id }
    actions.announce(`Moved ${column.name} to position ${index + 1} of ${columns.length}.`)
    await result(api.moveColumn({ id: column.id, index }))
    await actions.reload()
    settle()
  }

  const columnDrag = useDrag<Column, number>({
    findTarget: (x, _y, column) => {
      const lanes = [...(scroller.current?.querySelectorAll<HTMLElement>('[data-column-id]') ?? [])].filter(
        (el) => el.dataset['columnId'] !== column.id && !el.dataset['lifted'],
      )
      const index = lanes.findIndex((el) => {
        const r = el.getBoundingClientRect()
        return x < r.left + r.width / 2
      })
      return index === -1 ? lanes.length : index
    },
    onDrop: (column, index) => {
      if (columns.findIndex((c) => c.id === column.id) !== index) void moveColumn(column, index, 'drag')
    },
    scrollers: () => [scroller.current],
  })

  const columnMenu = (column: Column, anchor: MenuAnchor) => {
    const i = columns.findIndex((c) => c.id === column.id)
    const count = all.get(column.id)?.length ?? 0
    setMenu({
      label: `${column.name} column options`,
      anchor,
      items: [
        { label: 'Add a card', icon: <Plus size={13} />, onSelect: () => setAdding(column.id) },
        { label: 'Rename', onSelect: () => setRenaming(column.id) },
        {
          label: column.wipLimit === null ? 'Set a card limit…' : 'Change card limit…',
          onSelect: () => actions.editLimit(column),
        },
        {
          label: 'Cards here are done',
          checked: column.done,
          onSelect: async () => {
            await result(api.updateColumn({ id: column.id, done: !column.done }))
            await actions.reload()
          },
        },
        { separator: true },
        {
          label: 'Move left',
          icon: <ArrowLeft size={13} />,
          hint: '⌥←',
          disabled: i <= 0,
          onSelect: () => void moveColumn(column, i - 1, 'keys'),
        },
        {
          label: 'Move right',
          icon: <ArrowRight size={13} />,
          hint: '⌥→',
          disabled: i >= columns.length - 1,
          onSelect: () => void moveColumn(column, i + 1, 'keys'),
        },
        { separator: true },
        {
          label: count ? 'Delete column and cards…' : 'Delete column',
          icon: <Trash2 size={13} />,
          danger: true,
          disabled: columns.length <= 1,
          onSelect: async () => {
            if (count) return actions.confirmDeleteColumn(column, count)
            const token = await result(api.deleteColumn(column.id))
            if (token) actions.offerUndo(token, `Deleted ${column.name}`)
            await actions.reload()
          },
        },
      ],
    })
  }

  const onColumnKey = (column: Column) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    const i = columns.findIndex((c) => c.id === column.id)
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const to = i + (e.key === 'ArrowLeft' ? -1 : 1)
      if (to >= 0 && to < columns.length) void moveColumn(column, to, 'keys')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      setRenaming(column.id)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      lists.current.get(column.id)?.querySelector<HTMLElement>('[data-card-id]')?.focus()
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault()
      columnMenu(column, e.currentTarget.getBoundingClientRect())
    }
  }

  const addCard = async (column: Column, title: string) => {
    const card = await result(api.addCard({ boardId: board.id, columnId: column.id, title }))
    if (card) {
      setView((v) => v && { ...v, cards: [...v.cards, card] })
      actions.announce(`Added “${card.title}” to ${column.name}.`)
    }
    await actions.reload()
  }

  // Columns as drawn: the dragged column leaves a gap where it would land.
  const draggedColumn = columnDrag.drag?.item
  const laneOrder: (Column | 'gap')[] = useMemo(() => {
    if (!draggedColumn) return columns
    const rest = columns.filter((c) => c.id !== draggedColumn.id)
    const at = columnDrag.drag?.target ?? columns.findIndex((c) => c.id === draggedColumn.id)
    return [...rest.slice(0, at), 'gap' as const, ...rest.slice(at)]
  }, [columns, draggedColumn, columnDrag.drag?.target])

  const dragCard = cardDrag.drag
  const total = view.cards.length

  const renderCards = (column: Column) => {
    const cards = (shown.get(column.id) ?? []).filter((c) => c.id !== dragCard?.item.id)
    const gapAt = dragCard?.target?.columnId === column.id ? dragCard.target.index : -1
    const nodes = cards.map((card) => (
      <div role="listitem" key={card.id}>
        <CardTile
          card={card}
          labels={labelMap}
          fields={onCard}
          today={today}
          done={column.done}
          describedBy={help}
          onClick={() => !cardDrag.suppressClick.current && actions.openCard(card.id)}
          onPointerDown={(e) => cardDrag.begin(e, card)}
          onKeyDown={onCardKey(card)}
          onContextMenu={(e: MouseEvent) => {
            e.preventDefault()
            cardMenu(card, { x: e.clientX, y: e.clientY })
          }}
        />
      </div>
    ))
    if (gapAt >= 0)
      nodes.splice(
        gapAt,
        0,
        <div
          key="gap"
          aria-hidden="true"
          className="shrink-0 rounded-[9px] border border-dashed border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]"
          style={{ height: dragCard!.height }}
        />,
      )
    return nodes
  }

  const labelFilterCount = filter.labelIds?.length ?? 0
  const filterCount = labelFilterCount + (filter.due ? 1 : 0) + (filter.field ? 1 : 0)

  const filterMenu = (anchor: DOMRect) => {
    const toggleLabel = (id: string) =>
      setFilter((f) => {
        const ids = new Set(f.labelIds ?? [])
        if (ids.has(id)) ids.delete(id)
        else ids.add(id)
        return { ...f, labelIds: [...ids] }
      })
    const choosable = fields.filter(
      (f) => f.type === 'select' || f.type === 'person' || f.type === 'checkbox',
    )
    const people = (fieldId: string) =>
      [
        ...new Set(
          view.cards.map((c) => c.fields[fieldId]).filter((v): v is string => typeof v === 'string'),
        ),
      ].sort()
    const fieldItems = choosable.flatMap((f): MenuItem[] => {
      const values: { label: string; value: string | boolean }[] =
        f.type === 'select'
          ? f.options.map((o) => ({ label: o.name, value: o.id }))
          : f.type === 'checkbox'
            ? [{ label: 'Ticked', value: true }]
            : people(f.id).map((p) => ({ label: p, value: p }))
      if (!values.length) return []
      return [
        { heading: f.name },
        ...values.map((v): MenuItem => ({
          label: v.label,
          checked: filter.field?.fieldId === f.id && filter.field.value === v.value,
          onSelect: () =>
            setFilter((x) =>
              x.field?.fieldId === f.id && x.field.value === v.value
                ? { ...x, field: undefined }
                : { ...x, field: { fieldId: f.id, value: v.value } },
            ),
        })),
      ]
    })
    setMenu({
      label: 'Filter cards',
      anchor,
      items: [
        ...(labels.length
          ? [
              { heading: 'Labels' } as MenuItem,
              ...labels.map((l): MenuItem => ({
                label: l.name,
                checked: filter.labelIds?.includes(l.id) ?? false,
                onSelect: () => toggleLabel(l.id),
              })),
            ]
          : []),
        { heading: 'Dates' },
        ...DUE_OPTIONS.map((o): MenuItem => ({
          label: o.label,
          checked: filter.due === o.value,
          onSelect: () => setFilter((f) => ({ ...f, due: f.due === o.value ? undefined : o.value })),
        })),
        ...fieldItems,
        ...(filterCount
          ? [{ separator: true } as MenuItem, { label: 'Clear filters', onSelect: () => setFilter({}) }]
          : []),
      ],
    })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-sep px-4">
        <h2 className="min-w-0 truncate text-[20px] font-semibold tracking-tight">{board.name}</h2>
        <span className="shrink-0 pt-1 text-[12px] text-ink-3 tabular-nums">
          {filtering ? `${visible.length} of ${total}` : total} {total === 1 ? 'card' : 'cards'}
        </span>
        <span className="flex-1" />
        <label className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-ink-3" aria-hidden="true" />
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.currentTarget.blur())}
            placeholder="Search"
            aria-label="Search cards"
            className="h-7 w-44 rounded-md border border-sep bg-field pr-2 pl-7 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </label>
        <ToolbarButton
          label={filterCount ? `Filter, ${filterCount} on` : 'Filter'}
          active={filterCount > 0}
          onClick={(e) => filterMenu(e.currentTarget.getBoundingClientRect())}
        >
          <ListFilter size={15} />
          {filterCount > 0 && <span className="text-[11px] font-semibold tabular-nums">{filterCount}</span>}
        </ToolbarButton>
        <ToolbarButton label="Archived cards" onClick={actions.openArchive}>
          <Archive size={15} />
        </ToolbarButton>
        <ToolbarButton label="Labels and fields" onClick={actions.openSettings}>
          <Settings2 size={15} />
        </ToolbarButton>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(columns[0]?.id ?? null)}>
          New card
        </Button>
      </div>

      {filtering && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-sep px-4 py-1.5 text-[12px] text-ink-2"
          role="status"
        >
          Showing {visible.length} of {total} {total === 1 ? 'card' : 'cards'}
          {query && <>matching “{query}”</>}.
          <button
            type="button"
            onClick={() => {
              setQuery('')
              setFilter({})
            }}
            className="inline-flex items-center gap-1 rounded px-1 font-medium text-accent hover:bg-hover"
          >
            <X size={12} /> Clear
          </button>
        </div>
      )}

      <p id={help} className="sr-only">
        Return opens the card. Arrow keys move between cards. Option and an arrow key moves the card. Delete
        removes it.
      </p>

      <div ref={scroller} className="flex min-h-0 flex-1 items-start gap-3 overflow-x-auto px-4 pt-4 pb-4">
        {laneOrder.map((column) =>
          column === 'gap' ? (
            <div
              key="gap"
              aria-hidden="true"
              className="w-[272px] shrink-0 self-stretch rounded-xl border border-dashed border-[color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
              style={{ maxHeight: columnDrag.drag?.height }}
            />
          ) : (
            <ColumnLane
              key={column.id}
              column={column}
              count={all.get(column.id)?.length ?? 0}
              shown={filtering ? (shown.get(column.id)?.length ?? 0) : undefined}
              adding={adding === column.id}
              onAddingChange={(on) => setAdding(on ? column.id : null)}
              onAdd={(title) => void addCard(column, title)}
              renaming={renaming === column.id}
              onRenamingChange={(on) => setRenaming(on ? column.id : null)}
              onRename={async (name) => {
                await result(api.updateColumn({ id: column.id, name }))
                await actions.reload()
              }}
              onMenu={(anchor) => columnMenu(column, anchor)}
              onHeaderPointerDown={(e) => columnDrag.begin(e, column)}
              onHeaderKeyDown={onColumnKey(column)}
              listRef={(el) => {
                if (el) lists.current.set(column.id, el)
                else lists.current.delete(column.id)
              }}
            >
              {renderCards(column)}
            </ColumnLane>
          ),
        )}
        {!draggedColumn &&
          (addingColumn ? (
            <div className="flex h-10 w-[272px] shrink-0 items-center rounded-xl bg-lane px-2">
              <NameInput
                initial=""
                label="New column name"
                onDone={async (name) => {
                  setAddingColumn(false)
                  if (!name) return
                  await result(api.addColumn({ boardId: board.id, name }))
                  await actions.reload()
                  actions.announce(`Added the ${name} column.`)
                }}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingColumn(true)}
              className="flex h-10 w-[272px] shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-sep px-3 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
            >
              <Plus size={14} /> Add column
            </button>
          ))}
        <div className="w-1 shrink-0" />
      </div>

      {dragCard &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50"
            style={{
              left: dragCard.x - dragCard.offsetX,
              top: dragCard.y - dragCard.offsetY,
              width: dragCard.width,
            }}
          >
            <CardTile
              card={dragCard.item}
              labels={labelMap}
              fields={onCard}
              today={today}
              done={doneColumns.has(dragCard.target?.columnId ?? dragCard.item.columnId)}
              lifted
            />
          </div>,
          document.body,
        )}
      {columnDrag.drag &&
        createPortal(
          <div
            data-lifted="true"
            className="pointer-events-none fixed z-50 overflow-hidden"
            style={{
              left: columnDrag.drag.x - columnDrag.drag.offsetX,
              top: columnDrag.drag.y - columnDrag.drag.offsetY,
              width: columnDrag.drag.width,
              maxHeight: Math.min(columnDrag.drag.height, 420),
            }}
          >
            <ColumnLane
              column={columnDrag.drag.item}
              count={all.get(columnDrag.drag.item.id)?.length ?? 0}
              lifted
              adding={false}
              onAddingChange={() => {}}
              onAdd={() => {}}
              renaming={false}
              onRenamingChange={() => {}}
              onRename={() => {}}
              onMenu={() => {}}
            >
              {(shown.get(columnDrag.drag.item.id) ?? []).slice(0, 4).map((card) => (
                <CardTile
                  key={card.id}
                  card={card}
                  labels={labelMap}
                  fields={onCard}
                  today={today}
                  done={columnDrag.drag!.item.done}
                  lifted
                />
              ))}
            </ColumnLane>
          </div>,
          document.body,
        )}
      {menu && (
        <Menu label={menu.label} anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

function ToolbarButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`no-drag flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 hover:bg-hover ${
        active
          ? 'bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent'
          : 'text-ink-2 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
