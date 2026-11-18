import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  Check,
  Ellipsis,
  ExternalLink,
  Link2,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import {
  addDays,
  type ChecklistItem,
  type FieldDef,
  type FieldValue,
  type ISODate,
  type LinkCandidate,
  type UndoToken,
} from '@ordo/boards-core'
import type { BoardView, CardDetail as Detail, SuggestOutcome, SuggestProvider } from '@ordo/shared'
import { OverContent } from '../Sheet'
import { Markdown } from './Markdown'
import { Menu, type MenuAnchor } from './Menu'
import { LinkPicker } from './LinkPicker'
import { LinkRow } from './LinkRow'
import { FIELD_ICONS } from './BoardSettingsSheet'
import { Suggestions, flatten, suggestionKey, type Suggestion } from './Suggestions'
import { chipStyle, labelColor, reorder } from './model'

interface Props {
  cardId: string
  view: BoardView
  today: ISODate
  onClose: () => void
  /** Something changed: reload the board behind. */
  onChanged: () => Promise<void>
  offerUndo: (token: UndoToken, message: string) => void
  onOpenCard: (id: string) => void
  onOpenSettings: () => void
  announce: (message: string) => void
}

type Result<T> = { ok: true; value: T } | { ok: false; message: string }

/** A card's details: title, notes, checklist, links, dates, labels, fields and AI suggestions. */
export function CardDetail({
  cardId,
  view,
  today,
  onClose,
  onChanged,
  offerUndo,
  onOpenCard,
  onOpenSettings,
  announce,
}: Props) {
  const api = window.ordo.boards
  const titleId = useId()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [picker, setPicker] = useState<DOMRect | null>(null)
  const [asking, setAsking] = useState(false)
  const [suggested, setSuggested] = useState<{
    provider: SuggestProvider
    sent: number
    items: Suggestion[]
  } | null>(null)
  const [suggestError, setSuggestError] = useState<{ message: string; settings: boolean } | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const d = await api.card(cardId)
    if (!d) return onClose()
    setDetail(d)
  }, [api, cardId, onClose])

  useEffect(() => {
    let live = true
    void api.card(cardId).then((d) => {
      if (!live) return
      if (!d) onClose()
      else setDetail(d)
    })
    return () => {
      live = false
    }
  }, [api, cardId, onClose])

  // A new card: start with no suggestions.
  const [shownFor, setShownFor] = useState(cardId)
  if (shownFor !== cardId) {
    setShownFor(cardId)
    setSuggested(null)
    setSuggestError(null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement
      if (t.matches('input, textarea, select')) return t.blur()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    panel.current?.focus()
  }, [cardId])

  /** Run a change, then show the card and the board as they are now. */
  const change = async <T,>(p: Promise<Result<T>>): Promise<T | null> => {
    const r = await p
    setError(r.ok ? null : r.message)
    await Promise.all([load(), onChanged()])
    return r.ok ? r.value : null
  }

  if (!detail) return null
  const { card, checklist, links, backlinks } = detail
  const column = view.columns.find((c) => c.id === card.columnId)
  const archived = card.archivedAt !== null

  const update = (patch: Omit<Parameters<typeof api.updateCard>[0], 'id'>) =>
    change(api.updateCard({ id: card.id, ...patch }))

  const suggest = async () => {
    setAsking(true)
    setSuggestError(null)
    const r: SuggestOutcome = await api.suggest(card.id)
    setAsking(false)
    if (r.ok) {
      setSuggested({ provider: r.provider, sent: r.sent.candidates, items: flatten(r.suggestions) })
      announce(`${flatten(r.suggestions).length} suggestions from ${r.provider.label}.`)
    } else setSuggestError({ message: r.message, settings: r.error === 'no-ai' || r.error === 'consent' })
  }

  const accept = async (s: Suggestion) => {
    setSuggested((x) => x && { ...x, items: x.items.filter((i) => suggestionKey(i) !== suggestionKey(s)) })
    if (s.kind === 'due')
      await update({ due: s.date, ...(card.start && card.start > s.date && { start: null }) })
    if (s.kind === 'step') await change(api.addChecklistItem({ cardId: card.id, text: s.text }))
    if (s.kind === 'label') await update({ labelIds: [...card.labelIds, s.label.id] })
    if (s.kind === 'link') await addLink(s.candidate)
  }

  const acceptAll = async () => {
    const items = suggested?.items ?? []
    setSuggested((x) => x && { ...x, items: [] })
    let labels = card.labelIds
    for (const s of items) {
      if (s.kind === 'label') labels = [...labels, s.label.id]
      else await accept(s)
    }
    if (labels !== card.labelIds) await update({ labelIds: labels })
  }

  const addLink = (c: LinkCandidate) =>
    change(api.addLink({ cardId: card.id, target: c.target, title: c.title, detail: c.detail, date: c.date }))

  const remove = async () => {
    const token = await change(api.deleteCard(card.id))
    if (token) offerUndo(token, `Deleted “${card.title}”`)
    onClose()
  }

  return (
    <OverContent>
      <div
        className="absolute inset-0 z-20 flex justify-center overflow-auto bg-black/20 px-4 pt-10 pb-8 dark:bg-black/40"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="flex h-fit w-[760px] max-w-full flex-col rounded-xl border border-black/10 bg-sheet shadow-[0_20px_50px_rgb(0_0_0/0.25)] outline-none dark:border-white/10"
        >
          <div className="flex h-11 items-center gap-1 border-b border-sep pr-2 pl-5 text-[12px] text-ink-2">
            <span className="truncate">{view.board.name}</span>
            <span className="text-ink-3">›</span>
            <span className="truncate">{column?.name}</span>
            {archived && (
              <span className="ml-2 rounded-[5px] bg-hover px-1.5 py-px text-[11px] font-medium">
                Archived
              </span>
            )}
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void suggest()}
              disabled={asking}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-[color-mix(in_srgb,var(--label-purple)_80%,var(--ink))] hover:bg-hover disabled:opacity-60"
            >
              {asking ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {asking ? 'Thinking…' : 'Suggest'}
            </button>
            {asking && (
              <button
                type="button"
                onClick={() => void api.stopSuggest()}
                className="h-7 rounded-md px-2 text-[12px] text-ink-2 hover:bg-hover"
              >
                Stop
              </button>
            )}
            <HeaderButton label="More" onClick={(r) => setMenu(r)}>
              <Ellipsis size={15} />
            </HeaderButton>
            <HeaderButton label="Close" onClick={onClose}>
              <X size={15} />
            </HeaderButton>
          </div>

          <div className="px-5 pt-4">
            <TitleEditor id={titleId} title={card.title} onSave={(title) => void update({ title })} />
            {error && (
              <p role="alert" className="mt-1 text-[12px] text-danger">
                {error}
              </p>
            )}
          </div>

          <div className="flex gap-6 px-5 pt-3 pb-5">
            <div className="flex min-w-0 flex-1 flex-col gap-5">
              {suggestError && (
                <div
                  role="alert"
                  className="flex items-center gap-3 rounded-lg bg-hover px-3 py-2 text-[12px] text-ink-2"
                >
                  <span className="flex-1">{suggestError.message}</span>
                  {suggestError.settings && (
                    <button
                      type="button"
                      onClick={onOpenSettings}
                      className="font-medium text-accent hover:underline"
                    >
                      Open Settings
                    </button>
                  )}
                </div>
              )}
              {suggested && (
                <Suggestions
                  items={suggested.items}
                  provider={suggested.provider}
                  sent={suggested.sent}
                  today={today}
                  onAccept={(s) => void accept(s)}
                  onReject={(s) =>
                    setSuggested(
                      (x) =>
                        x && { ...x, items: x.items.filter((i) => suggestionKey(i) !== suggestionKey(s)) },
                    )
                  }
                  onAcceptAll={() => void acceptAll()}
                  onDismiss={() => setSuggested(null)}
                />
              )}

              <Section title="Notes">
                <NotesEditor notes={card.notes} onSave={(notes) => void update({ notes })} />
              </Section>

              <Section
                title="Checklist"
                aside={
                  checklist.length > 0 && (
                    <span className="text-[11px] text-ink-3 tabular-nums">
                      {checklist.filter((i) => i.done).length} of {checklist.length}
                    </span>
                  )
                }
              >
                <Checklist
                  items={checklist}
                  onToggle={(i) => {
                    // Tick it straight away; the main process confirms.
                    setDetail(
                      (d) =>
                        d && {
                          ...d,
                          checklist: d.checklist.map((x) => (x.id === i.id ? { ...x, done: !i.done } : x)),
                        },
                    )
                    void change(api.updateChecklistItem({ id: i.id, done: !i.done }))
                  }}
                  onEdit={(i, text) => void change(api.updateChecklistItem({ id: i.id, text }))}
                  onAdd={(text) => void change(api.addChecklistItem({ cardId: card.id, text }))}
                  onMove={(i, index) => {
                    setDetail((d) => d && { ...d, checklist: reorder(d.checklist, i.id, index) })
                    void change(api.moveChecklistItem({ id: i.id, index }))
                  }}
                  onDelete={async (i) => {
                    const token = await change(api.deleteChecklistItem(i.id))
                    if (token) offerUndo(token, `Deleted “${i.text}”`)
                  }}
                />
              </Section>

              <Section
                title="Links"
                aside={
                  <button
                    type="button"
                    onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())}
                    className="flex items-center gap-1 rounded px-1.5 text-[12px] font-medium text-accent hover:bg-hover"
                  >
                    <Link2 size={12} /> Link…
                  </button>
                }
              >
                {links.length === 0 && backlinks.length === 0 ? (
                  <p className="text-[12px] text-ink-3">
                    Link an event, email, bill, payment or another card.
                  </p>
                ) : (
                  <ul className="-mx-2 flex flex-col">
                    {links.map((l) => (
                      <LinkRow
                        key={l.id}
                        kind={l.target.kind}
                        title={l.title}
                        detail={l.detail}
                        date={l.date}
                        found={l.found}
                        today={today}
                        onOpen={
                          l.target.kind === 'card' && l.found
                            ? () => onOpenCard((l.target as { cardId: string }).cardId)
                            : undefined
                        }
                        onRemove={() => void change(api.removeLink(l.id))}
                      />
                    ))}
                    {backlinks.map((b) => (
                      <LinkRow
                        key={`from:${b.cardId}`}
                        kind="card"
                        title={b.title}
                        detail={`Links here · ${b.boardName} · ${b.columnName}`}
                        date={null}
                        today={today}
                        onOpen={() => onOpenCard(b.cardId)}
                      />
                    ))}
                  </ul>
                )}
              </Section>
            </div>

            <aside className="flex w-[220px] shrink-0 flex-col gap-4 text-[12px]" aria-label="Details">
              <Property label="Column">
                <select
                  value={card.columnId}
                  disabled={archived}
                  aria-label="Column"
                  onChange={(e) =>
                    void change(api.moveCard({ id: card.id, columnId: e.target.value, index: 100_000 })).then(
                      () => announce(`Moved to ${view.columns.find((c) => c.id === e.target.value)?.name}.`),
                    )
                  }
                  className={FIELD_CLASS}
                >
                  {view.columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Property>

              <Property label={card.start ? 'Dates' : 'Due'}>
                {card.start !== null && (
                  <DateInput
                    label="Start date"
                    value={card.start}
                    max={card.due ?? undefined}
                    onChange={(start) => void update({ start })}
                  />
                )}
                <DateInput
                  label="Due date"
                  value={card.due}
                  min={card.start ?? undefined}
                  onChange={(due) => void update({ due, ...(due === null && { start: null }) })}
                />
                <div className="flex gap-2">
                  {card.due && card.start === null && (
                    <LinkButton onClick={() => void update({ start: addDays(card.due!, -1) })}>
                      Make it a range
                    </LinkButton>
                  )}
                  {card.start !== null && (
                    <LinkButton onClick={() => void update({ start: null })}>One day only</LinkButton>
                  )}
                  {!card.due && <LinkButton onClick={() => void update({ due: today })}>Today</LinkButton>}
                  {!card.due && (
                    <LinkButton onClick={() => void update({ due: addDays(today, 1) })}>Tomorrow</LinkButton>
                  )}
                </div>
              </Property>

              <Property label="Labels">
                {view.labels.length === 0 ? (
                  <span className="text-ink-3">No labels on this board.</span>
                ) : (
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Labels">
                    {view.labels.map((l) => {
                      const on = card.labelIds.includes(l.id)
                      return (
                        <button
                          key={l.id}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          onClick={() =>
                            void update({
                              labelIds: on
                                ? card.labelIds.filter((x) => x !== l.id)
                                : [...card.labelIds, l.id],
                            })
                          }
                          className={`inline-flex h-[22px] items-center gap-1 rounded-[6px] px-1.5 text-[12px] font-medium ${
                            on ? '' : 'text-ink-2 ring-1 ring-sep ring-inset hover:bg-hover'
                          }`}
                          style={on ? chipStyle(l.color) : undefined}
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{ background: labelColor(l.color) }}
                          />
                          {l.name}
                          {on && <Check size={11} />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </Property>

              {view.fields.map((f) => (
                <Property key={f.id} label={f.name} icon={FIELD_ICONS[f.type]}>
                  <FieldInput
                    field={f}
                    value={card.fields[f.id]}
                    people={[
                      ...new Set(
                        view.cards
                          .map((c) => c.fields[f.id])
                          .filter((v): v is string => f.type === 'person' && typeof v === 'string'),
                      ),
                    ]}
                    onChange={(value) => void update({ fields: { [f.id]: value } })}
                  />
                </Property>
              ))}
            </aside>
          </div>
        </div>
      </div>

      {menu && (
        <Menu
          label="Card options"
          anchor={menu}
          onClose={() => setMenu(null)}
          items={[
            archived
              ? {
                  label: 'Restore to the board',
                  icon: <ArchiveRestore size={13} />,
                  onSelect: () => void change(api.archiveCard({ id: card.id, archived: false })),
                }
              : {
                  label: 'Archive',
                  icon: <Archive size={13} />,
                  onSelect: async () => {
                    await change(api.archiveCard({ id: card.id, archived: true }))
                    announce(`Archived “${card.title}”.`)
                    onClose()
                  },
                },
            { separator: true },
            { label: 'Delete card', icon: <Trash2 size={13} />, danger: true, onSelect: () => void remove() },
          ]}
        />
      )}
      {picker && (
        <LinkPicker
          cardId={card.id}
          anchor={picker}
          today={today}
          onClose={() => setPicker(null)}
          onPick={(c) => {
            setPicker(null)
            void addLink(c)
          }}
        />
      )}
    </OverContent>
  )
}

const FIELD_CLASS =
  'h-7 w-full rounded-md border border-sep bg-field px-2 text-[12px] text-ink outline-none select-text focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60'

function HeaderButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: (r: DOMRect) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => onClick(e.currentTarget.getBoundingClientRect())}
      className="flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
    >
      {children}
    </button>
  )
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-[11px] font-medium text-accent hover:underline">
      {children}
    </button>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold tracking-wide text-ink-3 uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Property({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-3">
        {icon}
        {label}
      </span>
      {children}
    </div>
  )
}

function TitleEditor({ id, title, onSave }: { id: string; title: string; onSave: (t: string) => void }) {
  const [text, setText] = useState(title)
  const [prev, setPrev] = useState(title)
  const ref = useRef<HTMLTextAreaElement>(null)
  if (prev !== title) {
    setPrev(title)
    setText(title)
  }
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])
  const commit = () => {
    const t = text.replace(/\s+/g, ' ').trim()
    if (t && t !== title) onSave(t)
    else setText(title)
  }
  return (
    <textarea
      ref={ref}
      id={id}
      rows={1}
      value={text}
      maxLength={300}
      aria-label="Title"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') setText(title)
      }}
      className="-mx-1.5 block w-[calc(100%+12px)] resize-none rounded-md bg-transparent px-1.5 py-0.5 text-[19px] leading-snug font-semibold tracking-tight text-ink outline-none select-text hover:bg-hover focus:bg-field focus:ring-1 focus:ring-accent"
    />
  )
}

function NotesEditor({ notes, onSave }: { notes: string; onSave: (n: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(notes)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!editing) return
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(96, el.scrollHeight)}px`
  }, [editing, text])
  if (editing)
    return (
      <div className="flex flex-col gap-1">
        <textarea
          ref={ref}
          autoFocus
          value={text}
          maxLength={20_000}
          aria-label="Notes"
          placeholder="Write anything. **Bold**, *italic*, lists with - and [links](https://…) work."
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setEditing(false)
            if (text !== notes) onSave(text)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setText(notes)
              setEditing(false)
            }
          }}
          className="w-full resize-none rounded-md border border-accent bg-field px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none ring-1 ring-accent select-text placeholder:text-ink-3"
        />
        <span className="text-[11px] text-ink-3">Simple markdown. Click away to save, Esc to cancel.</span>
      </div>
    )
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={notes.trim() ? 'Edit notes' : 'Add notes'}
      onClick={() => {
        setText(notes)
        setEditing(true)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) {
          e.preventDefault()
          setText(notes)
          setEditing(true)
        }
      }}
      className="-mx-2.5 cursor-text rounded-md px-2.5 py-2 hover:bg-hover"
    >
      {notes.trim() ? (
        <Markdown source={notes} />
      ) : (
        <span className="text-[13px] text-ink-3">Add notes…</span>
      )}
    </div>
  )
}

function Checklist({
  items,
  onToggle,
  onEdit,
  onAdd,
  onMove,
  onDelete,
}: {
  items: ChecklistItem[]
  onToggle: (i: ChecklistItem) => void
  onEdit: (i: ChecklistItem, text: string) => void
  onAdd: (text: string) => void
  onMove: (i: ChecklistItem, index: number) => void
  onDelete: (i: ChecklistItem) => void
}) {
  const [text, setText] = useState('')
  const done = items.filter((i) => i.done).length
  return (
    <div className="flex flex-col gap-1">
      {items.length > 0 && (
        <div className="mb-1 h-1 overflow-hidden rounded-full bg-hover" aria-hidden="true">
          <div
            className="h-full rounded-full bg-success transition-[width]"
            style={{ width: `${(done / items.length) * 100}%` }}
          />
        </div>
      )}
      <ul className="-mx-2 flex flex-col" aria-label="Steps">
        {items.map((item, i) => (
          <li key={item.id} className="group flex items-center gap-2 rounded-md px-2 py-0.5 hover:bg-hover">
            <input
              type="checkbox"
              checked={item.done}
              aria-label={item.text}
              onChange={() => onToggle(item)}
              className="size-3.5 shrink-0 accent-[var(--accent)]"
            />
            <StepText
              item={item}
              onSave={(t) => onEdit(item, t)}
              onMove={(dir) => {
                const to = i + dir
                if (to >= 0 && to < items.length) onMove(item, to)
              }}
            />
            <button
              type="button"
              aria-label={`Delete ${item.text}`}
              title="Delete"
              onClick={() => onDelete(item)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Plus size={13} className="ml-px shrink-0 text-ink-3" aria-hidden="true" />
        <input
          value={text}
          maxLength={300}
          placeholder="Add a step"
          aria-label="Add a step"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              e.preventDefault()
              onAdd(text.trim())
              setText('')
            }
          }}
          className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none select-text placeholder:text-ink-3"
        />
      </div>
    </div>
  )
}

function StepText({
  item,
  onSave,
  onMove,
}: {
  item: ChecklistItem
  onSave: (t: string) => void
  onMove: (dir: -1 | 1) => void
}) {
  const [text, setText] = useState(item.text)
  const [prev, setPrev] = useState(item.text)
  if (prev !== item.text) {
    setPrev(item.text)
    setText(item.text)
  }
  return (
    <input
      value={text}
      maxLength={300}
      aria-label={`Step: ${item.text}. Option and up or down moves it.`}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim()
        if (t && t !== item.text) onSave(t)
        else setText(item.text)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          onMove(e.key === 'ArrowUp' ? -1 : 1)
        }
      }}
      className={`h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none select-text ${
        item.done ? 'text-ink-3 line-through' : 'text-ink'
      }`}
    />
  )
}

function DateInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: ISODate | null
  min?: ISODate
  max?: ISODate
  onChange: (v: ISODate | null) => void
}) {
  return (
    <span className="flex items-center gap-1">
      <input
        type="date"
        aria-label={label}
        value={value ?? ''}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value || null)}
        className={`${FIELD_CLASS} flex-1`}
      />
      {value && (
        <button
          type="button"
          aria-label={`Clear ${label.toLowerCase()}`}
          title="Clear"
          onClick={() => onChange(null)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
        >
          <X size={12} />
        </button>
      )}
    </span>
  )
}

function FieldInput({
  field,
  value,
  people,
  onChange,
}: {
  field: FieldDef
  value: FieldValue | undefined
  people: string[]
  onChange: (v: FieldValue | null) => void
}) {
  const listId = useId()
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value === undefined ? '' : String(value))
  }
  const commit = () => {
    if (text.trim() === (value === undefined ? '' : String(value))) return
    onChange(text.trim() ? (field.type === 'number' ? Number(text) : text.trim()) : null)
  }
  const textProps = {
    value: text,
    'aria-label': field.name,
    onChange: (e: { target: { value: string } }) => setText(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && e.currentTarget.blur(),
    className: FIELD_CLASS,
  }
  switch (field.type) {
    case 'select':
      return (
        <select
          aria-label={field.name}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
          className={FIELD_CLASS}
        >
          <option value="">None</option>
          {field.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="size-3.5 accent-[var(--accent)]"
          />
          {value === true ? 'Yes' : 'No'}
        </label>
      )
    case 'date':
      return (
        <DateInput label={field.name} value={typeof value === 'string' ? value : null} onChange={onChange} />
      )
    case 'number':
      return <input {...textProps} type="number" inputMode="decimal" />
    case 'url':
      return (
        <span className="flex items-center gap-1">
          <input {...textProps} type="url" placeholder="https://" />
          {typeof value === 'string' && (
            <a
              href={value}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${field.name}`}
              title={value}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-accent hover:bg-hover"
            >
              <ExternalLink size={12} />
            </a>
          )}
        </span>
      )
    case 'person':
      return (
        <>
          <input {...textProps} list={listId} placeholder="Name" />
          <datalist id={listId}>
            {people.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </>
      )
    default:
      return <input {...textProps} type="text" />
  }
}
