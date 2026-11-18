import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { CircleCheck, Ellipsis, Plus } from 'lucide-react'
import type { Column } from '@ordo/boards-core'
import { tint, toneStyle } from './model'

interface Props {
  column: Column
  /** Cards in the column, whether or not a filter hides them. */
  count: number
  /** Cards shown, when a filter hides some. */
  shown?: number
  children: ReactNode
  lifted?: boolean
  /** Show the quick-add field at the bottom. */
  adding: boolean
  onAddingChange: (adding: boolean) => void
  onAdd: (title: string) => void
  onRename: (name: string) => void
  onMenu: (anchor: DOMRect) => void
  onHeaderPointerDown?: (e: PointerEvent<HTMLElement>) => void
  onHeaderKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
  listRef?: Ref<HTMLDivElement>
  /** Start renaming (from the menu). */
  renaming: boolean
  onRenamingChange: (renaming: boolean) => void
}

/** One column: its header (name, count, limit, menu), its cards, and quick add at the bottom. */
export function ColumnLane({
  column,
  count,
  shown,
  children,
  lifted,
  adding,
  onAddingChange,
  onAdd,
  onRename,
  onMenu,
  onHeaderPointerDown,
  onHeaderKeyDown,
  listRef,
  renaming,
  onRenamingChange,
}: Props) {
  const over = column.wipLimit !== null && count > column.wipLimit
  const atLimit = column.wipLimit !== null && count === column.wipLimit
  const countLabel =
    column.wipLimit !== null
      ? `${count} of ${column.wipLimit}${over ? ', over the limit' : ''}`
      : `${count} ${count === 1 ? 'card' : 'cards'}`
  const menuButton = useRef<HTMLButtonElement>(null)

  return (
    <section
      data-column-id={column.id}
      aria-label={`${column.name}, ${countLabel}`}
      className={`flex max-h-full w-[272px] shrink-0 flex-col rounded-xl bg-lane ${
        lifted ? 'rotate-[1deg] bg-sheet shadow-[var(--lift-shadow)]' : ''
      }`}
    >
      <div
        tabIndex={lifted ? -1 : 0}
        role="group"
        aria-roledescription="column"
        aria-label={`${column.name} column. Option and the left or right arrow moves it.`}
        onPointerDown={onHeaderPointerDown}
        onKeyDown={onHeaderKeyDown}
        onDoubleClick={() => onRenamingChange(true)}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(new DOMRect(e.clientX, e.clientY, 0, 0))
        }}
        className="group/col flex h-10 shrink-0 cursor-grab items-center gap-1.5 rounded-t-xl pr-1.5 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset active:cursor-grabbing"
      >
        {column.done && (
          <CircleCheck
            size={13}
            className="shrink-0"
            style={{ color: tint('var(--success)') }}
            aria-label="Done column"
          />
        )}
        {renaming ? (
          <NameInput
            initial={column.name}
            label="Column name"
            onDone={(name) => {
              onRenamingChange(false)
              if (name && name !== column.name) onRename(name)
            }}
          />
        ) : (
          <h3 className="min-w-0 truncate text-[13px] font-semibold">{column.name}</h3>
        )}
        {shown !== undefined && shown !== count ? (
          // Filtered: how many show, neutral; the limit stays on its own chip.
          <span className="shrink-0 px-1 text-[12px] text-ink-2 tabular-nums">
            {shown} of {count}
          </span>
        ) : (
          column.wipLimit === null && (
            <span className="shrink-0 px-1 text-[12px] text-ink-2 tabular-nums">{count}</span>
          )
        )}
        {column.wipLimit !== null && (
          <span
            className={`shrink-0 rounded-[5px] px-1 text-[12px] tabular-nums ${over ? 'font-medium' : atLimit ? 'text-ink' : 'text-ink-2'}`}
            style={over ? toneStyle('var(--danger)') : undefined}
            title={`Limit: ${column.wipLimit} ${column.wipLimit === 1 ? 'card' : 'cards'}${over ? '. Over the limit.' : ''}`}
          >
            {count}/{column.wipLimit}
          </span>
        )}
        <span className="flex-1" />
        <IconButton
          label={`Add a card to ${column.name}`}
          onClick={() => onAddingChange(true)}
          className="opacity-0 group-focus-within/col:opacity-100 group-hover/col:opacity-100"
        >
          <Plus size={14} />
        </IconButton>
        <IconButton
          ref={menuButton}
          label={`${column.name} column options`}
          onClick={() => onMenu(menuButton.current!.getBoundingClientRect())}
        >
          <Ellipsis size={14} />
        </IconButton>
      </div>
      <div
        ref={listRef}
        role="list"
        aria-label={column.name}
        data-column-list={column.id}
        className="flex min-h-2 flex-col gap-2 overflow-y-auto px-2 pt-0.5 pb-2"
      >
        {children}
        {adding && <QuickAdd columnName={column.name} onAdd={onAdd} onClose={() => onAddingChange(false)} />}
      </div>
      {!adding && !lifted && (
        <button
          type="button"
          onClick={() => onAddingChange(true)}
          className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          <Plus size={14} />
          Add a card
        </button>
      )}
    </section>
  )
}

function IconButton({
  label,
  onClick,
  children,
  className = '',
  ref,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={`flex size-6 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink focus-visible:opacity-100 ${className}`}
    >
      {children}
    </button>
  )
}

/** A one-line name editor: Return saves, Escape cancels, leaving saves. */
export function NameInput({
  initial,
  label,
  onDone,
  className = '',
}: {
  initial: string
  label: string
  onDone: (name: string | null) => void
  className?: string
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      ref={ref}
      aria-label={label}
      value={value}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(value.trim() || null)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(value.trim() || null)}
      className={`h-6 min-w-0 flex-1 rounded-md border border-accent bg-field px-1.5 text-[13px] font-semibold text-ink outline-none ring-1 ring-accent select-text ${className}`}
    />
  )
}

/** Type a title and press Return to add a card; it stays open for the next one. */
function QuickAdd({
  columnName,
  onAdd,
  onClose,
}: {
  columnName: string
  onAdd: (title: string) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [title])
  const submit = () => {
    const t = title.replace(/\s+/g, ' ').trim()
    if (t) onAdd(t)
    setTitle('')
  }
  return (
    <div
      role="listitem"
      className="rounded-[9px] border border-accent bg-card shadow-[var(--tile-shadow)] ring-1 ring-accent"
    >
      <textarea
        ref={ref}
        rows={1}
        value={title}
        maxLength={300}
        aria-label={`New card in ${columnName}`}
        placeholder="Card title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
          if (e.key === 'Escape') onClose()
        }}
        onBlur={() => {
          if (!title.trim()) onClose()
        }}
        className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-snug font-medium text-ink outline-none select-text placeholder:font-normal placeholder:text-ink-3 focus-visible:outline-none"
      />
      <div className="flex items-center justify-between px-3 pb-2 text-[11px] text-ink-2">
        <span>Return to add · Esc to close</span>
      </div>
    </div>
  )
}
