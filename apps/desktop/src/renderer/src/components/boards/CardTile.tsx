import { useId, type KeyboardEvent, type MouseEvent, type PointerEvent, type Ref } from 'react'
import { AlignLeft, CalendarDays, Link2, SquareCheck, UserRound } from 'lucide-react'
import { dueState, fieldText, type Card, type FieldDef, type ISODate, type Label } from '@ordo/boards-core'
import { chipStyle, datesLabel, dayLabel, labelColor, tint, toneStyle } from './model'

interface Props {
  card: Card
  labels: ReadonlyMap<string, Label>
  /** Fields shown on cards. */
  fields: readonly FieldDef[]
  today: ISODate
  /** The card is in a done column: no overdue warning, title muted. */
  done: boolean
  /** The lifted copy that follows the pointer while dragging. */
  lifted?: boolean
  describedBy?: string
  buttonRef?: Ref<HTMLButtonElement>
  onClick?: (e: MouseEvent) => void
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void
  onContextMenu?: (e: MouseEvent) => void
}

const DUE_TONE = {
  overdue: toneStyle('var(--danger)', 12),
  today: toneStyle('var(--label-orange)'),
  soon: undefined,
  later: undefined,
} as const

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A card on the board: labels, title, then dates, checklist, links and fields in one quiet row. */
export function CardTile({
  card,
  labels,
  fields,
  today,
  done,
  lifted,
  describedBy,
  buttonRef,
  onClick,
  onPointerDown,
  onKeyDown,
  onContextMenu,
}: Props) {
  const cardLabels = card.labelIds.map((id) => labels.get(id)).filter((l): l is Label => l !== undefined)
  const state = dueState(card, today, done)
  const dates = datesLabel(card, today)
  const shown = fields.filter((f) => card.fields[f.id] !== undefined && f.showOnCard)
  const { done: ticked, total } = card.checklist
  const hasMeta = dates || total > 0 || card.links > 0 || card.notes.trim() || shown.length > 0
  const summaryId = useId()
  // What the card shows, in words, read after its title.
  const summary = [
    cardLabels.length ? `Labels: ${cardLabels.map((l) => l.name).join(', ')}.` : '',
    dates ? (state === 'overdue' ? `Overdue, due ${dates}.` : `Due ${dates}.`) : '',
    total ? `${ticked} of ${plural(total, 'step')} done.` : '',
    card.links ? `${plural(card.links, 'link')}.` : '',
    card.notes.trim() ? 'Has notes.' : '',
    ...shown.map((f) => {
      const text =
        f.type === 'date' ? dayLabel(String(card.fields[f.id]), today) : fieldText(f, card.fields[f.id])
      return f.type === 'checkbox' ? `${f.name}.` : f.type === 'url' ? '' : `${f.name}: ${text}.`
    }),
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={buttonRef}
      type="button"
      data-card-id={card.id}
      aria-label={card.title}
      aria-describedby={[summary && summaryId, describedBy].filter(Boolean).join(' ') || undefined}
      aria-roledescription="card"
      tabIndex={lifted ? -1 : 0}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className={`group/card relative flex w-full flex-col gap-1.5 rounded-[9px] border border-sep bg-card px-3 py-2.5 text-left outline-none transition-[box-shadow,transform] duration-150 focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-accent ${
        lifted
          ? 'rotate-[1.5deg] shadow-[var(--lift-shadow)]'
          : 'shadow-[var(--card-shadow)] hover:border-[color-mix(in_srgb,var(--ink)_16%,transparent)]'
      }`}
    >
      {summary && (
        <span id={summaryId} className="sr-only">
          {summary}
        </span>
      )}
      {cardLabels.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {cardLabels.map((l) => (
            <span
              key={l.id}
              className="inline-flex h-[18px] max-w-full items-center gap-1 truncate rounded-[5px] px-1.5 text-[11px] font-medium"
              style={chipStyle(l.color)}
            >
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: labelColor(l.color) }} />
              <span className="truncate">{l.name}</span>
            </span>
          ))}
        </span>
      )}
      <span
        className={`text-[13px] leading-snug font-medium break-words ${done ? 'text-ink-2' : 'text-ink'}`}
      >
        {card.title}
      </span>
      {hasMeta && (
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-ink-2">
          {dates && (
            <span
              className={`-mx-1 inline-flex h-[18px] items-center gap-1 rounded-[5px] px-1 font-medium tabular-nums ${
                state ? '' : 'text-ink-2'
              }`}
              style={state ? DUE_TONE[state] : undefined}
              title={state === 'overdue' ? 'Overdue' : undefined}
            >
              <CalendarDays size={11} aria-hidden="true" />
              {dates}
            </span>
          )}
          {total > 0 && (
            <span
              className="inline-flex items-center gap-1 tabular-nums"
              style={ticked === total ? { color: tint('var(--success)') } : undefined}
              title={`${ticked} of ${total} steps done`}
            >
              <SquareCheck size={11} aria-hidden="true" />
              {ticked}/{total}
            </span>
          )}
          {card.links > 0 && (
            <span className="inline-flex items-center gap-1 tabular-nums" title={`${card.links} linked`}>
              <Link2 size={11} aria-hidden="true" />
              {card.links}
            </span>
          )}
          {card.notes.trim() && <AlignLeft size={11} aria-label="Has notes" />}
          {shown.map((f) => {
            const value = card.fields[f.id]
            const text = fieldText(f, value)
            if (f.type === 'select') {
              const option = f.options.find((o) => o.id === value)
              return option ? (
                <span
                  key={f.id}
                  title={f.name}
                  className="inline-flex h-[16px] items-center rounded-[4px] px-1 font-medium"
                  style={chipStyle(option.color)}
                >
                  {option.name}
                </span>
              ) : null
            }
            if (f.type === 'person')
              return (
                <span key={f.id} title={f.name} className="inline-flex items-center gap-1">
                  <UserRound size={11} aria-hidden="true" />
                  {text}
                </span>
              )
            if (f.type === 'checkbox')
              return (
                <span key={f.id} className="inline-flex items-center gap-1">
                  <SquareCheck size={11} aria-hidden="true" />
                  {f.name}
                </span>
              )
            if (f.type === 'url') return null
            return (
              <span key={f.id} title={f.name} className="max-w-[120px] truncate">
                {f.type === 'number'
                  ? `${f.name} ${text}`
                  : f.type === 'date'
                    ? `${f.name} ${dayLabel(text, today)}`
                    : text}
              </span>
            )
          })}
        </span>
      )}
    </button>
  )
}
