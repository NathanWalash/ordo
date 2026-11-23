import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { CalendarPlus, Pencil } from 'lucide-react'
import { checkDraft, localZone, sameRepeat, type EventDraft, type RepeatRule } from '@ordo/calendar-core'
import type { CalendarListItem } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import {
  ALL_DAY_ALERTS,
  alertLabel,
  calendarGroups,
  canonicalZone,
  deleteNote,
  defaultUntil,
  REPEAT_LABELS,
  TIMED_ALERTS,
  timeZones,
  toggleAllDay,
  withStart,
  zoneCity,
  zoneLabel,
  type TimedMemory,
} from './editing'

interface Props {
  /** Null for a new event. */
  editing: { calendar: CalendarListItem; recurring: boolean } | null
  initial: EventDraft
  /** The event as it is saved now, when `initial` already has unsaved changes. */
  original?: EventDraft
  /** Calendars a new event can go in. */
  calendars: CalendarListItem[]
  calendarId: string
  onSave: (draft: EventDraft, calendarId: string, repeatChanged: boolean) => void
  /** Delete, with the editor's draft so it can come back if the delete is cancelled. */
  onDelete?: (draft: EventDraft) => void
  onClose: () => void
}

const field =
  'no-drag h-7 min-w-0 rounded-md border border-sep bg-field px-2 text-[13px] text-ink outline-none select-text focus:border-accent focus:ring-1 focus:ring-accent focus-visible:outline-none aria-[invalid=true]:border-danger aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger'
/** Pop-up buttons size to their contents, like macOS, rather than stretching across the sheet. */
const popup = `${field} w-auto min-w-40 justify-self-start`

/** Which part of the form a problem from `checkDraft` is about. */
function problemAt(message: string): 'start' | 'end' | 'repeat' | 'other' {
  if (/^Enter a start/.test(message)) return 'start'
  if (/^Enter an end|ends before it starts/.test(message)) return 'end'
  if (/repeat/i.test(message)) return 'repeat'
  return 'other'
}

/** New event and Edit event: a sheet with the fields macOS Calendar's inspector has. */
export function EventEditor({
  editing,
  initial,
  original = initial,
  calendars,
  calendarId: initialCalendar,
  onSave,
  onDelete,
  onClose,
}: Props) {
  const [d, setD] = useState(() =>
    initial.timeZone ? { ...initial, timeZone: canonicalZone(initial.timeZone) } : initial,
  )
  const [calendarId, setCalendarId] = useState(initialCalendar)
  const [error, setError] = useState<string | null>(null)
  const [memory, setMemory] = useState<TimedMemory | null>(null)
  const here = useMemo(() => canonicalZone(localZone()), [])
  const [zoneOpen, setZoneOpen] = useState(false)
  const id = useId()
  const startRef = useRef<HTMLInputElement>(null)
  const endDateRef = useRef<HTMLInputElement>(null)
  const endTimeRef = useRef<HTMLInputElement>(null)
  const zones = useMemo(() => timeZones(initial.timeZone, here), [initial.timeZone, here])
  const set = (patch: Partial<EventDraft>) => {
    setError(null)
    setD((x) => ({ ...x, ...patch }))
  }
  const calendar = editing?.calendar ?? calendars.find((c) => c.id === calendarId)

  const save = () => {
    const problem = checkDraft(d)
    if (problem) {
      setError(problem)
      const at = problemAt(problem)
      if (at === 'end') (d.allDay ? endDateRef : endTimeRef).current?.focus()
      if (at === 'start') startRef.current?.focus()
      return
    }
    onSave(d, calendarId, !sameRepeat(original.repeat, d.repeat))
  }

  const date = (s: string) => s.slice(0, 10)
  const time = (s: string) => s.slice(11, 16)
  const join = (day: string, t: string) => (d.allDay ? day : `${day}T${t || '00:00'}`)
  const alerts = d.allDay ? ALL_DAY_ALERTS : TIMED_ALERTS
  const repeatEnd = !d.repeat
    ? 'never'
    : d.repeat.until !== undefined
      ? 'date'
      : d.repeat.count !== undefined
        ? 'count'
        : 'never'
  const setRepeat = (r: RepeatRule | null) => set({ repeat: r })
  const at = error ? problemAt(error) : null
  const whenError = at === 'start' || at === 'end'
  const errorId = `${id}-error`

  return (
    <Sheet
      title={editing ? 'Edit event' : 'New event'}
      subtitle={
        editing ? `${editing.calendar.name}${editing.recurring ? ' · Repeating event' : ''}` : undefined
      }
      icon={editing ? <Pencil size={20} /> : <CalendarPlus size={22} />}
      width={480}
      onClose={onClose}
      onSubmit={save}
      footer={
        <>
          {onDelete && <Button onClick={() => onDelete(d)}>Delete…</Button>}
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            {editing ? 'Save' : 'Add event'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <input
          aria-label="Title"
          placeholder="New Event"
          value={d.title}
          maxLength={500}
          onChange={(e) => set({ title: e.target.value })}
          className={`${field} h-8 text-[15px] font-semibold`}
        />
        <input
          aria-label="Location"
          placeholder="Add location"
          value={d.location}
          maxLength={1000}
          onChange={(e) => set({ location: e.target.value })}
          className={field}
        />
      </div>

      <div className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2 border-t border-sep pt-3 text-[13px]">
        <Label htmlFor={editing ? undefined : `${id}-cal`}>Calendar</Label>
        {editing ? (
          <span className="flex items-center gap-2">
            <Dot color={calendar?.color} />
            {editing.calendar.name}
          </span>
        ) : (
          <span className="relative justify-self-start">
            <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2">
              <Dot color={calendar?.color} />
            </span>
            <select
              id={`${id}-cal`}
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              className={`${popup} pl-6`}
            >
              {calendarGroups(calendars).map((g) =>
                g.label ? (
                  <optgroup key={g.label} label={g.label}>
                    {g.calendars.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  g.calendars.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))
                ),
              )}
            </select>
          </span>
        )}

        <Label htmlFor={`${id}-allday`}>All-day</Label>
        <span>
          <input
            id={`${id}-allday`}
            type="checkbox"
            checked={d.allDay}
            onChange={(e) => {
              setError(null)
              const r = toggleAllDay(d, e.target.checked, memory, here)
              setD(r.draft)
              setMemory(r.memory)
            }}
            className="size-3.5 accent-[var(--accent)]"
          />
        </span>

        <Label htmlFor={`${id}-start`}>Starts</Label>
        <span className="flex gap-2">
          <input
            id={`${id}-start`}
            ref={startRef}
            type="date"
            aria-label="Start date"
            required
            aria-invalid={at === 'start' || undefined}
            aria-describedby={at === 'start' ? errorId : undefined}
            value={date(d.start)}
            onChange={(e) => {
              if (!e.target.value) return
              setError(null)
              setD((x) => withStart(x, join(e.target.value, time(x.start))))
            }}
            className={field}
          />
          {!d.allDay && (
            <input
              type="time"
              aria-label="Start time"
              required
              value={time(d.start)}
              onChange={(e) => {
                if (!e.target.value) return
                setError(null)
                setD((x) => withStart(x, join(date(x.start), e.target.value)))
              }}
              className={field}
            />
          )}
        </span>

        <Label htmlFor={`${id}-end`}>Ends</Label>
        <span className="flex gap-2">
          <input
            id={`${id}-end`}
            ref={endDateRef}
            type="date"
            aria-label="End date"
            required
            aria-invalid={at === 'end' || undefined}
            aria-describedby={at === 'end' ? errorId : undefined}
            value={date(d.end)}
            onChange={(e) => e.target.value && set({ end: join(e.target.value, time(d.end)) })}
            className={field}
          />
          {!d.allDay && (
            <input
              ref={endTimeRef}
              type="time"
              aria-label="End time"
              required
              aria-invalid={at === 'end' || undefined}
              aria-describedby={at === 'end' ? errorId : undefined}
              value={time(d.end)}
              onChange={(e) => e.target.value && set({ end: join(date(d.end), e.target.value) })}
              className={field}
            />
          )}
        </span>
        {whenError && (
          <p id={errorId} role="alert" className="col-start-2 -mt-1 text-[12px] text-danger">
            {error}
          </p>
        )}

        {!d.allDay &&
          (zoneOpen || d.timeZone !== here ? (
            <>
              <Label htmlFor={`${id}-tz`}>Time zone</Label>
              <select
                id={`${id}-tz`}
                value={d.timeZone ?? ''}
                onChange={(e) => set({ timeZone: e.target.value || null })}
                className={`${popup} max-w-full`}
              >
                <option value="">None (same clock time everywhere)</option>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {zoneLabel(z)}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="col-start-2 -mt-1 text-[12px] text-ink-2">
              {zoneCity(d.timeZone ?? here)} time ·{' '}
              <button
                type="button"
                onClick={() => setZoneOpen(true)}
                className="no-drag rounded text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Change…
              </button>
            </span>
          ))}

        <Label htmlFor={`${id}-repeat`}>Repeat</Label>
        <select
          id={`${id}-repeat`}
          value={d.repeat ? (d.repeat.custom ? 'custom' : d.repeat.frequency) : 'none'}
          aria-describedby={editing?.recurring ? `${id}-repeat-hint` : undefined}
          onChange={(e) => {
            const v = e.target.value
            if (v === 'none') setRepeat(null)
            else if (v === 'custom') setRepeat(original.repeat)
            else
              setRepeat({
                frequency: v as RepeatRule['frequency'],
                ...(d.repeat?.until && { until: d.repeat.until }),
                ...(d.repeat?.count && { count: d.repeat.count }),
              })
          }}
          className={popup}
        >
          <option value="none">Never</option>
          {Object.entries(REPEAT_LABELS).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
          {original.repeat?.custom && <option value="custom">Custom (set in another app)</option>}
        </select>
        {editing?.recurring && (
          <p id={`${id}-repeat-hint`} className="col-start-2 -mt-1 text-[11px] leading-snug text-ink-2">
            Changing how it repeats changes every event in the series.
          </p>
        )}

        {d.repeat && !d.repeat.custom && (
          <>
            <Label htmlFor={`${id}-repeat-end`}>End repeat</Label>
            <span className="flex flex-wrap items-center gap-2">
              <select
                id={`${id}-repeat-end`}
                value={repeatEnd}
                onChange={(e) => {
                  const f = d.repeat!.frequency
                  if (e.target.value === 'never') setRepeat({ frequency: f })
                  else if (e.target.value === 'date')
                    setRepeat({ frequency: f, until: defaultUntil(d.start, f) })
                  else setRepeat({ frequency: f, count: 10 })
                }}
                className={popup}
              >
                <option value="never">Never</option>
                <option value="date">On date</option>
                <option value="count">After</option>
              </select>
              {repeatEnd === 'date' && (
                <input
                  type="date"
                  aria-label="Repeat until"
                  required
                  aria-invalid={at === 'repeat' || undefined}
                  value={d.repeat.until}
                  onChange={(e) =>
                    e.target.value && setRepeat({ frequency: d.repeat!.frequency, until: e.target.value })
                  }
                  className={field}
                />
              )}
              {repeatEnd === 'count' && (
                <span className="flex items-center gap-2">
                  <input
                    type="number"
                    aria-label="Number of times"
                    min={1}
                    max={1000}
                    required
                    value={d.repeat.count}
                    onChange={(e) =>
                      setRepeat({ frequency: d.repeat!.frequency, count: Number(e.target.value) })
                    }
                    className={`${field} w-16`}
                  />
                  times
                </span>
              )}
            </span>
          </>
        )}

        <Label htmlFor={`${id}-alert`}>Alert</Label>
        <select
          id={`${id}-alert`}
          value={d.alert === null ? 'none' : String(d.alert)}
          onChange={(e) => set({ alert: e.target.value === 'none' ? null : Number(e.target.value) })}
          className={popup}
        >
          <option value="none">None</option>
          {d.alert !== null && !alerts.some((a) => a.value === d.alert) && (
            <option value={String(d.alert)}>{alertLabel(d.alert)}</option>
          )}
          {alerts.map((a) => (
            <option key={a.value} value={String(a.value)}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      <textarea
        aria-label="Notes"
        placeholder="Add notes"
        value={d.notes}
        maxLength={10_000}
        rows={3}
        onChange={(e) => set({ notes: e.target.value })}
        className="no-drag min-h-16 resize-y rounded-md border border-sep bg-field px-2 py-1.5 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent focus-visible:outline-none"
      />
      {error && !whenError && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
    </Sheet>
  )
}

function Label({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-right text-ink-2">
      {children}
    </label>
  )
}

function Dot({ color }: { color?: string }) {
  return (
    <span
      className="block size-2.5 shrink-0 rounded-full"
      style={{ background: color ?? 'var(--accent)' }}
      aria-hidden="true"
    />
  )
}

/**
 * Asks whether a change to a repeating event is for this occurrence only or for all of them,
 * and confirms deleting any event. Deleting is never the default: Return does nothing and focus
 * starts on Cancel.
 */
export function ChangeSheet({
  kind,
  title,
  recurring,
  calendar,
  onChoose,
  onClose,
}: {
  kind: 'save' | 'delete'
  title: string
  recurring: boolean
  calendar?: CalendarListItem
  onChoose: (scope: 'this' | 'all') => void
  onClose: () => void
}) {
  const name = title.trim() || 'New Event'
  const permanent = deleteNote(calendar)
  if (kind === 'save')
    return (
      <Sheet
        title="Change a repeating event?"
        width={440}
        onClose={onClose}
        onSubmit={() => onChoose('this')}
        footer={
          <>
            <span className="flex-1" />
            <Button onClick={onClose}>Cancel</Button>
            <Button onClick={() => onChoose('all')}>All events</Button>
            <Button type="submit" variant="primary">
              This event only
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-snug text-ink-2">
          “{name}” repeats. Change just this event, or every event in the series?
        </p>
      </Sheet>
    )
  return (
    <Sheet
      title={recurring ? 'Delete a repeating event?' : `Delete “${name}”?`}
      width={440}
      onClose={onClose}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose} data-autofocus>
            Cancel
          </Button>
          {recurring ? (
            <>
              <Button onClick={() => onChoose('all')}>Delete all events</Button>
              <Button variant="destructive" onClick={() => onChoose('this')}>
                Delete this event only
              </Button>
            </>
          ) : (
            <Button variant="destructive" onClick={() => onChoose('all')}>
              Delete
            </Button>
          )}
        </>
      }
    >
      <p className="text-[13px] leading-snug text-ink-2">
        {recurring ? `“${name}” repeats. Delete just this event, or every event in the series? ` : ''}
        {permanent}
      </p>
    </Sheet>
  )
}
