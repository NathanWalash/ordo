import { useRef, useState, type KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, Ellipsis, Pencil, Plus, SquareKanban, Trash2 } from 'lucide-react'
import type { BoardSummary } from '@ordo/shared'
import { NameInput } from './ColumnLane'
import { Menu, type MenuAnchor } from './Menu'

interface Props {
  boards: BoardSummary[]
  selected: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (board: BoardSummary, name: string) => void
  onMove: (board: BoardSummary, index: number) => void
  onDelete: (board: BoardSummary) => void
}

/** The boards, like the Calendar's list of calendars. Option-↑/↓ reorders; the menu renames and deletes. */
export function BoardList({ boards, selected, onSelect, onNew, onRename, onMove, onDelete }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ board: BoardSummary; anchor: MenuAnchor } | null>(null)
  const list = useRef<HTMLUListElement>(null)

  const focusBoard = (id: string) =>
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-board-id="${CSS.escape(id)}"]`)?.focus(),
    )

  const onKey = (b: BoardSummary, i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const to = i + (e.key === 'ArrowUp' ? -1 : 1)
      if (to >= 0 && to < boards.length) {
        onMove(b, to)
        focusBoard(b.id)
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const next = boards[i + (e.key === 'ArrowUp' ? -1 : 1)]
      if (next) focusBoard(next.id)
    } else if (e.key === 'F2' || (e.key === 'Enter' && e.altKey)) {
      e.preventDefault()
      setRenaming(b.id)
    }
  }

  return (
    <aside className="flex w-[196px] shrink-0 flex-col border-r border-sep" aria-label="Boards">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <h2 className="px-1 pb-1 text-[11px] font-semibold text-ink-3">Boards</h2>
        <ul ref={list} className="flex flex-col gap-px">
          {boards.map((b, i) => (
            <li key={b.id} className="group relative">
              {renaming === b.id ? (
                <div className="flex h-7 items-center px-1">
                  <NameInput
                    initial={b.name}
                    label="Board name"
                    className="font-normal"
                    onDone={(name) => {
                      setRenaming(null)
                      if (name && name !== b.name) onRename(b, name)
                      focusBoard(b.id)
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  data-board-id={b.id}
                  onClick={() => onSelect(b.id)}
                  onKeyDown={onKey(b, i)}
                  onDoubleClick={() => setRenaming(b.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ board: b, anchor: { x: e.clientX, y: e.clientY } })
                  }}
                  aria-current={b.id === selected ? 'page' : undefined}
                  className={`flex h-7 w-full items-center gap-2 rounded-md pr-7 pl-1.5 text-left text-[13px] ${
                    b.id === selected ? 'bg-selected' : 'hover:bg-hover'
                  }`}
                >
                  <SquareKanban
                    size={14}
                    className={`shrink-0 ${b.id === selected ? 'text-accent' : 'text-ink-2'}`}
                  />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  {b.overdue > 0 ? (
                    <span
                      className="shrink-0 text-[11px] font-medium text-danger tabular-nums group-hover:invisible"
                      title={`${b.overdue} overdue`}
                    >
                      {b.overdue}
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-ink-3 tabular-nums group-hover:invisible">
                      {b.cards}
                    </span>
                  )}
                </button>
              )}
              {renaming !== b.id && (
                <button
                  type="button"
                  aria-label={`${b.name} options`}
                  title="Options"
                  onClick={(e) => setMenu({ board: b, anchor: e.currentTarget.getBoundingClientRect() })}
                  className="absolute top-0.5 right-0.5 flex size-6 items-center justify-center rounded text-ink-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/5 hover:text-ink focus-visible:opacity-100 dark:hover:bg-white/10"
                >
                  <Ellipsis size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onNew}
          className="no-drag mt-1 flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Plus size={14} className="shrink-0" />
          New board…
        </button>
      </div>
      <div className="border-t border-sep px-4 py-2.5 text-[11px] leading-snug text-ink-3">
        Stored on this computer
      </div>
      {menu && (
        <Menu
          label={`${menu.board.name} options`}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={(() => {
            const i = boards.findIndex((b) => b.id === menu.board.id)
            return [
              { label: 'Rename', icon: <Pencil size={13} />, onSelect: () => setRenaming(menu.board.id) },
              {
                label: 'Move up',
                icon: <ArrowUp size={13} />,
                hint: '⌥↑',
                disabled: i <= 0,
                onSelect: () => onMove(menu.board, i - 1),
              },
              {
                label: 'Move down',
                icon: <ArrowDown size={13} />,
                hint: '⌥↓',
                disabled: i >= boards.length - 1,
                onSelect: () => onMove(menu.board, i + 1),
              },
              { separator: true },
              {
                label: 'Delete board…',
                icon: <Trash2 size={13} />,
                danger: true,
                onSelect: () => onDelete(menu.board),
              },
            ]
          })()}
        />
      )}
    </aside>
  )
}
