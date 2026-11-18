import { useId, useMemo, useState, type ReactNode } from 'react'
import { CalendarPlus, Pencil } from 'lucide-react'
import { checkDraft, localZone, sameRepeat, type EventDraft, type RepeatRule } from '@ordo/calendar-core'
import type { CalendarListItem } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import {
  ALL_DAY_ALERTS,
  alertLabel,
  REPEAT_LABELS,
  TIMED_ALERTS,
  timeZones,
  withAllDay,
  withStart,
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
  onDelete?: () => void
  onClose: () => void
}

const field =
  'no-drag h-7 min-w-0 rounded-md border border-sep bg-field px-2 text-[13px] text-ink outline-none select-text focus:border-accent focus:ring-1 focus:ring-accent'

/** New Event and Edit Event: a sheet with the fields macOS Calendar's inspector has. */
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
  const [d, setD] = useState(initial)
  const [calendarId, setCalendarId] = useState(initialCalendar)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const zones = useMemo(() => timeZones(initial.timeZone, localZone()), [initial.timeZone])
  const set = (patch: Partial<EventDraft>) => {
    setError(null)
    setD((x) => ({ ...x, ...patch }))
  }
  const calendar = editing?.calendar ?? calendars.find((c) => c.id === calendarId)

  const save = () => {
    const problem = checkDraft(d)
    if (problem) return setError(problem)
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

  return (
    <Sheet
      title={editing ? 'Edit Event' : 'New Event'}
      subtitle={
        editing ? `${editing.calendar.name}${editing.recurring ? ' · Repeating event' : ''}` : undefined
      }
      icon={editing ? <Pencil size={20} /> : <CalendarPlus size={22} />}
      width={480}
      onClose={onClose}
      onSubmit={save}
      footer={
        <>
          {onDelete && <Button onClick={onDelete}>Delete…</Button>}
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            {editing ? 'Save' : 'Add Event'}
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
          <span className="flex items-center gap-2">
            <Dot color={calendar?.color} />
            <select
              id={`${id}-cal`}
              value={calendarId}
              onChange={(e) => setCalendarId(e.target.value)}
              className={`${field} flex-1`}
            >
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
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
              setD((x) => ({ ...withAllDay(x, e.target.checked), alert: null }))
            }}
            className="size-3.5 accent-[var(--accent)]"
          />
        </span>

        <Label htmlFor={`${id}-start`}>Starts</Label>
        <span className="flex gap-2">
          <input
            id={`${id}-start`}
            type="date"
            aria-label="Start date"
            required
            value={date(d.start)}
            onChange={(e) => e.target.value && setD((x) => withStart(x, join(e.target.value, time(x.start))))}
            className={field}
          />
          {!d.allDay && (
            <input
              type="time"
              aria-label="Start time"
              required
              value={time(d.start)}
              onChange={(e) =>
                e.target.value && setD((x) => withStart(x, join(date(x.start), e.target.value)))
              }
              className={field}
            />
          )}
        </span>

        <Label htmlFor={`${id}-end`}>Ends</Label>
        <span className="flex gap-2">
          <input
            id={`${id}-end`}
            type="date"
            aria-label="End date"
            required
            value={date(d.end)}
            onChange={(e) => e.target.value && set({ end: join(e.target.value, time(d.end)) })}
            className={field}
          />
          {!d.allDay && (
            <input
              type="time"
              aria-label="End time"
              required
              value={time(d.end)}
              onChange={(e) => e.target.value && set({ end: join(date(d.end), e.target.value) })}
              className={field}
            />
          )}
        </span>

        {!d.allDay && (
          <>
            <Label htmlFor={`${id}-tz`}>Time zone</Label>
            <select
              id={`${id}-tz`}
              value={d.timeZone ?? ''}
              onChange={(e) => set({ timeZone: e.target.value || null })}
              className={field}
            >
              {d.timeZone === null && <option value="">Floating (always local time)</option>}
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </>
        )}

        <Label htmlFor={`${id}-repeat`}>Repeat</Label>
        <select
          id={`${id}-repeat`}
          value={d.repeat ? (d.repeat.custom ? 'custom' : d.repeat.frequency) : 'none'}
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
          className={field}
        >
          <option value="none">Never</option>
          {Object.entries(REPEAT_LABELS).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
          {original.repeat?.custom && <option value="custom">Custom (as set elsewhere)</option>}
        </select>

        {d.repeat && !d.repeat.custom && (
          <>
            <Label htmlFor={`${id}-repeat-end`}>End repeat</Label>
            <span className="flex gap-2">
              <select
                id={`${id}-repeat-end`}
                value={repeatEnd}
                onChange={(e) => {
                  const f = d.repeat!.frequency
                  if (e.target.value === 'never') setRepeat({ frequency: f })
                  else if (e.target.value === 'date')
                    setRepeat({
                      frequency: f,
                      until: date(d.end) > date(d.start) ? date(d.end) : date(d.start),
                    })
                  else setRepeat({ frequency: f, count: 10 })
                }}
                className={field}
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
          className={field}
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
        className="no-drag min-h-16 resize-y rounded-md border border-sep bg-field px-2 py-1.5 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent"
      />
      {error && (
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
      className="size-2.5 shrink-0 rounded-full"
      style={{ background: color ?? 'var(--accent)' }}
      aria-hidden="true"
    />
  )
}

/**
 * Asks whether a change to a repeating event is for this occurrence only or for all of them.
 * Also the confirmation for deleting any event.
 */
export function ChangeSheet({
  kind,
  title,
  recurring,
  onChoose,
  onClose,
}: {
  kind: 'save' | 'delete'
  title: string
  recurring: boolean
  onChoose: (scope: 'this' | 'all') => void
  onClose: () => void
}) {
  const name = title.trim() || 'New Event'
  const heading =
    kind === 'delete'
      ? recurring
        ? 'Delete a repeating event?'
        : `Delete “${name}”?`
      : 'Change a repeating event?'
  return (
    <Sheet
      title={heading}
      width={440}
      onClose={onClose}
      onSubmit={() => onChoose(recurring ? 'this' : 'all')}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <span className="flex-1" />
          {recurring ? (
            <>
              <Button onClick={() => onChoose('all')}>All Events</Button>
              <Button type="submit" variant="primary">
                {kind === 'delete' ? 'Delete This Event Only' : 'This Event Only'}
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary">
              Delete
            </Button>
          )}
        </>
      }
    >
      <p className="text-[13px] leading-snug text-ink-2">
        {recurring
          ? kind === 'delete'
            ? `“${name}” repeats. Delete just this event, or every event in the series?`
            : `“${name}” repeats. Change just this event, or every event in the series?`
          : 'It’s removed from iCloud, so it goes from your other devices too.'}
      </p>
    </Sheet>
  )
}
