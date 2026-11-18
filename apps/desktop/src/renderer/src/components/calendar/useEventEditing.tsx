import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  isLong,
  type CalendarEvent,
  type DateRange,
  type EditScope,
  type EventDraft,
} from '@ordo/calendar-core'
import type { CalendarChangeOutcome, CalendarListItem, EventDetails, EventRef } from '@ordo/shared'
import { ChangeSheet, EventEditor } from './EventEditor'
import {
  moveDraft,
  newDraft,
  optimisticCreate,
  optimisticDelete,
  optimisticUpdate,
  readOnlyReason,
  REPEAT_LABELS,
  writable,
  type Optimistic,
} from './editing'
import type { PopoverEdit } from './ItemPopover'
import type { CalendarItem } from './model'

const NEW_IN_KEY = 'ordo.calendar.new-in'

type EventItem = Extract<CalendarItem, { type: 'event' }>

type EditorState =
  | { mode: 'new'; draft: EventDraft; calendarId: string }
  | { mode: 'edit'; ref: EventRef; details: EventDetails; calendar: CalendarListItem; draft: EventDraft }

interface Ask {
  kind: 'save' | 'delete'
  title: string
  recurring: boolean
  resolve: (scope: EditScope | null) => void
}

const refOf = (e: CalendarEvent): EventRef => ({
  calendarId: e.calendarId,
  uid: e.uid,
  ...(e.recurrenceId && { recurrenceId: e.recurrenceId }),
})

/** Shown events that are still on their way to iCloud have a temporary UID. */
const isPending = (e: CalendarEvent) => e.uid.startsWith('pending-')

function remembered(): string | null {
  try {
    return localStorage.getItem(NEW_IN_KEY)
  } catch {
    return null
  }
}

/**
 * Creating, editing, moving and deleting events from the calendar views. Changes show at once
 * (optimistically) and are rolled back if iCloud refuses them; either way the views then show
 * what's in the cache, which the main process has just brought up to date.
 */
export function useEventEditing({
  enabled,
  calendars,
  range,
  reload,
}: {
  enabled: boolean
  calendars: CalendarListItem[]
  range: DateRange
  /** Load the visible range from the cache again. */
  reload: () => Promise<void>
}) {
  const [pending, setPending] = useState<{ id: number; apply: Optimistic }[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [selected, setSelected] = useState<{ key: string; details: EventDetails | null | 'loading' } | null>(
    null,
  )
  const seq = useRef(0)
  const rangeRef = useRef(range)
  useEffect(() => {
    rangeRef.current = range
  }, [range])

  const targets = useMemo(() => calendars.filter(writable), [calendars])
  const byId = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars])
  const busy = editor !== null || ask !== null

  /** Apply `optimistic` now, make the change, then show what the cache says. */
  const run = useCallback(
    async (optimistic: Optimistic, call: () => Promise<CalendarChangeOutcome>) => {
      const id = ++seq.current
      setNotice(null)
      setPending((p) => [...p, { id, apply: optimistic }])
      try {
        const r = await call()
        if (!r.ok) setNotice(r.message)
      } catch {
        setNotice('Something went wrong changing your calendar. Try again in a moment.')
      } finally {
        await reload().catch(() => {})
        setPending((p) => p.filter((x) => x.id !== id))
      }
    },
    [reload],
  )

  const askScope = (kind: Ask['kind'], title: string, recurring: boolean) =>
    new Promise<EditScope | null>((resolve) => setAsk({ kind, title, recurring, resolve }))

  const details = async (e: CalendarEvent): Promise<EventDetails | null> => {
    const d = await window.ordo.calendar.details(refOf(e))
    if (!d) {
      setNotice(
        readOnlyReason(byId.get(e.calendarId)) ??
          'Ordo hasn’t got this event’s details yet. Sync, then try again.',
      )
      return null
    }
    if (!d.editable) {
      setNotice(d.reason ?? 'This event can’t be changed.')
      return null
    }
    return d
  }

  const canEdit = useCallback(
    (item: CalendarItem): item is EventItem =>
      enabled && item.type === 'event' && !isPending(item.event) && !readOnlyReason(item.calendar),
    [enabled],
  )

  // ---- Actions -------------------------------------------------------------------------------

  /** Start a new event on a day (09:00, or the next hour today), at a time slot, or all day. */
  const create = (at: Date, { allDay = false, exact = false } = {}) => {
    if (!enabled || busy) return
    if (!targets.length) {
      setNotice('Add events to one of your iCloud calendars. Calendars added by link or file are read-only.')
      return
    }
    const saved = remembered()
    const calendarId =
      targets.find((c) => c.id === saved)?.id ?? targets.find((c) => c.visible)?.id ?? targets[0]!.id
    setNotice(null)
    setEditor({ mode: 'new', draft: newDraft(at, { allDay, exact }), calendarId })
  }

  const edit = async (item: CalendarItem) => {
    if (!canEdit(item) || busy) return
    const d = await details(item.event)
    if (d && item.calendar)
      setEditor({ mode: 'edit', ref: refOf(item.event), details: d, calendar: item.calendar, draft: d.draft })
  }

  const remove = async (ref: EventRef, d: EventDetails) => {
    const scope = await askScope('delete', d.draft.title, d.recurring)
    if (!scope) return
    await run(optimisticDelete(ref, scope), () => window.ordo.calendar.deleteEvent({ ref, scope }))
  }

  /** Drag or keyboard move in the week view. */
  const move = async (item: CalendarItem, span: { start: Date; end: Date }) => {
    if (!canEdit(item)) return
    const d = await details(item.event)
    if (!d) return
    const draft = moveDraft(d.draft, span.start, span.end)
    const scope = d.recurring ? await askScope('save', d.draft.title, true) : 'all'
    if (!scope) return
    const ref = refOf(item.event)
    await run(optimisticUpdate(ref, draft, scope, rangeRef.current), () =>
      window.ordo.calendar.updateEvent({ ref, draft, scope }),
    )
  }

  const save = async (draft: EventDraft, calendarId: string, repeatChanged: boolean) => {
    const ed = editor
    if (!ed) return
    setEditor(null)
    if (ed.mode === 'new') {
      try {
        localStorage.setItem(NEW_IN_KEY, calendarId)
      } catch {
        // Not remembering the calendar is fine.
      }
      await run(optimisticCreate(calendarId, draft, rangeRef.current), () =>
        window.ordo.calendar.createEvent({ calendarId, draft }),
      )
      return
    }
    // Changing how it repeats is always for the whole series.
    const scope = ed.details.recurring && !repeatChanged ? await askScope('save', draft.title, true) : 'all'
    if (!scope) {
      setEditor({ ...ed, draft })
      return
    }
    await run(optimisticUpdate(ed.ref, draft, scope, rangeRef.current), () =>
      window.ordo.calendar.updateEvent({ ref: ed.ref, draft, scope }),
    )
  }

  // ---- The popover ---------------------------------------------------------------------------

  /** Look an event up when its popover opens, to offer Edit and Delete. */
  const select = useCallback(
    (item: CalendarItem | null) => {
      if (!item || !canEdit(item)) return setSelected(null)
      const key = item.key
      setSelected({ key, details: 'loading' })
      void window.ordo.calendar
        .details(refOf(item.event))
        .then((d) => setSelected((s) => (s?.key === key ? { key, details: d } : s)))
    },
    [canEdit],
  )

  const popoverEdit = (item: CalendarItem, close: () => void): PopoverEdit | undefined => {
    if (!enabled || item.type !== 'event') return undefined
    const reason = readOnlyReason(item.calendar)
    const noop = () => {}
    if (reason) return { state: 'locked', reason, onEdit: noop, onDelete: noop }
    if (isPending(item.event)) return { state: 'checking', onEdit: noop, onDelete: noop }
    const s = selected?.key === item.key ? selected.details : 'loading'
    if (s === 'loading') return { state: 'checking', onEdit: noop, onDelete: noop }
    if (!s || !s.editable)
      return {
        state: 'locked',
        reason: s?.reason ?? 'Ordo hasn’t got this event’s details yet. Sync, then try again.',
        onEdit: noop,
        onDelete: noop,
      }
    const r = s.draft.repeat
    return {
      state: 'editable',
      repeats: r ? (r.custom ? 'Repeats' : `Repeats ${REPEAT_LABELS[r.frequency].toLowerCase()}`) : undefined,
      onEdit: () => {
        close()
        if (item.calendar)
          setEditor({
            mode: 'edit',
            ref: refOf(item.event),
            details: s,
            calendar: item.calendar,
            draft: s.draft,
          })
      },
      onDelete: () => {
        close()
        void remove(refOf(item.event), s)
      },
    }
  }

  // ---- What to draw --------------------------------------------------------------------------

  const display = useCallback(
    (events: CalendarEvent[]) => pending.reduce((evs, p) => p.apply(evs), events),
    [pending],
  )

  const sheets: ReactNode = (
    <>
      {editor && (
        <EventEditor
          key={editor.mode === 'edit' ? `${editor.ref.uid}|${editor.ref.recurrenceId ?? ''}` : 'new'}
          editing={
            editor.mode === 'edit' ? { calendar: editor.calendar, recurring: editor.details.recurring } : null
          }
          initial={editor.draft}
          original={editor.mode === 'edit' ? editor.details.draft : undefined}
          calendars={targets}
          calendarId={editor.mode === 'edit' ? editor.ref.calendarId : editor.calendarId}
          onSave={(d, c, repeatChanged) => void save(d, c, repeatChanged)}
          onDelete={
            editor.mode === 'edit'
              ? () => {
                  const ed = editor
                  setEditor(null)
                  void remove(ed.ref, ed.details)
                }
              : undefined
          }
          onClose={() => setEditor(null)}
        />
      )}
      {ask && (
        <ChangeSheet
          kind={ask.kind}
          title={ask.title}
          recurring={ask.recurring}
          onChoose={(scope) => {
            setAsk(null)
            ask.resolve(scope)
          }}
          onClose={() => {
            setAsk(null)
            ask.resolve(null)
          }}
        />
      )}
    </>
  )

  return {
    /** Whether the toolbar's New Event button can be used, and why not. */
    canCreate: enabled && targets.length > 0,
    busy,
    create,
    edit,
    move,
    select,
    popoverEdit,
    canMove: (item: CalendarItem) => canEdit(item) && !isLong(item),
    display,
    notice,
    dismissNotice: () => setNotice(null),
    sheets,
  }
}
