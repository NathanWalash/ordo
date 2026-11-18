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

/** A message above the calendar: something went wrong, or why something can't be done. */
export interface Notice {
  kind: 'error' | 'info'
  text: string
}

/** How a move by drag or keyboard went, for the week view to announce. */
export type MoveResult = { saved: Promise<boolean> } | 'cancelled' | 'refused'

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

/** The key the views give an event (see `toItems`). */
const keyOf = (r: EventRef) => `${r.calendarId}|${r.uid}|${r.recurrenceId ?? ''}`

/** Shown events that are still on their way to iCloud have a temporary UID. */
const isPending = (e: CalendarEvent) => e.uid.startsWith('pending-')

const NOT_READY = 'Ordo hasn’t got this event’s details yet. Sync, then try again.'

function remembered(): string | null {
  try {
    return localStorage.getItem(NEW_IN_KEY)
  } catch {
    return null
  }
}

/**
 * Put focus back on an event in the views once they've drawn it: the occurrence `key` if it's
 * there, otherwise any occurrence of the same event.
 */
function focusEvent(key: string) {
  const [calendarId, uid] = key.split('|')
  const find = () =>
    document.querySelector<HTMLElement>(`[data-event-key="${CSS.escape(key)}"]`) ??
    document.querySelector<HTMLElement>(`[data-event-key^="${CSS.escape(`${calendarId}|${uid}|`)}"]`)
  let tries = 0
  const attempt = () => {
    const el = find()
    if (el) el.focus()
    else if (tries++ < 10) setTimeout(attempt, 50)
  }
  requestAnimationFrame(attempt)
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
  const [notice, setNotice] = useState<Notice | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [selected, setSelected] = useState<{ key: string; details: EventDetails | null | 'loading' } | null>(
    null,
  )
  const seq = useRef(0)
  const rangeRef = useRef(range)
  /** The event focus goes back to when the editor closes. */
  const returnKey = useRef<string | null>(null)
  useEffect(() => {
    rangeRef.current = range
  }, [range])

  const targets = useMemo(() => calendars.filter(writable), [calendars])
  const byId = useMemo(() => new Map(calendars.map((c) => [c.id, c])), [calendars])
  const busy = editor !== null || ask !== null
  const info = (text: string) => setNotice({ kind: 'info', text })

  /** Apply `optimistic` now, make the change, then show what the cache says. True if it was saved. */
  const run = useCallback(
    async (
      optimistic: Optimistic,
      call: () => Promise<CalendarChangeOutcome>,
      focus?: (uid: string) => string,
    ) => {
      const id = ++seq.current
      setNotice(null)
      setPending((p) => [...p, { id, apply: optimistic }])
      let saved = false
      let uid: string | null = null
      try {
        const r = await call()
        if (r.ok) {
          saved = true
          uid = r.uid
        } else setNotice({ kind: 'error', text: r.message })
      } catch {
        setNotice({
          kind: 'error',
          text: 'Something went wrong changing your calendar. Try again in a moment.',
        })
      } finally {
        await reload().catch(() => {})
        setPending((p) => p.filter((x) => x.id !== id))
      }
      if (focus && uid) focusEvent(focus(uid))
      return saved
    },
    [reload],
  )

  const askScope = (kind: Ask['kind'], title: string, recurring: boolean) =>
    new Promise<EditScope | null>((resolve) => setAsk({ kind, title, recurring, resolve }))

  const details = async (e: CalendarEvent): Promise<EventDetails | null> => {
    const d = await window.ordo.calendar.details(refOf(e))
    if (!d) {
      info(readOnlyReason(byId.get(e.calendarId)) ?? NOT_READY)
      return null
    }
    if (!d.editable) {
      info(d.reason ?? 'Ordo can’t change this event.')
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
      info('Add events to one of your iCloud calendars. Calendars added by link or file can’t be changed.')
      return
    }
    const saved = remembered()
    const calendarId =
      targets.find((c) => c.id === saved)?.id ?? targets.find((c) => c.visible)?.id ?? targets[0]!.id
    setNotice(null)
    returnKey.current = null
    setEditor({ mode: 'new', draft: newDraft(at, { allDay, exact }), calendarId })
  }

  const openEditor = (item: EventItem, d: EventDetails) => {
    if (!item.calendar) return
    returnKey.current = item.key
    setEditor({ mode: 'edit', ref: refOf(item.event), details: d, calendar: item.calendar, draft: d.draft })
  }

  const edit = async (item: CalendarItem) => {
    if (busy || item.type !== 'event') return
    const reason = readOnlyReason(item.calendar)
    if (reason) return info(reason)
    if (!canEdit(item)) return
    const d = await details(item.event)
    if (d) openEditor(item, d)
  }

  /** Confirm and delete. `restore` brings the editor back if the delete is cancelled from it. */
  const remove = async (ref: EventRef, d: EventDetails, restore?: () => void) => {
    const scope = await askScope('delete', d.draft.title, d.recurring)
    if (!scope) {
      restore?.()
      if (!restore) focusEvent(keyOf(ref))
      return
    }
    await run(optimisticDelete(ref, scope), () => window.ordo.calendar.deleteEvent({ ref, scope }))
  }

  /**
   * Drag or keyboard move in the week view. Resolves once the move is showing (or was cancelled
   * or refused); `saved` says how the save went.
   */
  const move = async (item: CalendarItem, span: { start: Date; end: Date }): Promise<MoveResult> => {
    // One question at a time: a second move while Ordo is asking about the first is ignored.
    if (busy || !canEdit(item)) return 'refused'
    const d = await details(item.event)
    if (!d) return 'refused'
    const draft = moveDraft(d.draft, span.start, span.end)
    const scope = d.recurring ? await askScope('save', d.draft.title, true) : 'all'
    if (!scope) {
      focusEvent(item.key)
      return 'cancelled'
    }
    const ref = refOf(item.event)
    const saved = run(
      optimisticUpdate(ref, draft, scope, rangeRef.current),
      () => window.ordo.calendar.updateEvent({ ref, draft, scope }),
      () => item.key,
    )
    return { saved }
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
      await run(
        optimisticCreate(calendarId, draft, rangeRef.current),
        () => window.ordo.calendar.createEvent({ calendarId, draft }),
        (uid) => `${calendarId}|${uid}|`,
      )
      return
    }
    // Changing how it repeats is always for the whole series.
    const scope = ed.details.recurring && !repeatChanged ? await askScope('save', draft.title, true) : 'all'
    if (!scope) {
      setEditor({ ...ed, draft })
      return
    }
    await run(
      optimisticUpdate(ed.ref, draft, scope, rangeRef.current),
      () => window.ordo.calendar.updateEvent({ ref: ed.ref, draft, scope }),
      () => keyOf(ed.ref),
    )
  }

  const closeEditor = () => {
    setEditor(null)
    if (returnKey.current) focusEvent(returnKey.current)
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
      return { state: 'locked', reason: s?.reason ?? NOT_READY, onEdit: noop, onDelete: noop }
    const r = s.draft.repeat
    return {
      state: 'editable',
      repeats: r ? (r.custom ? 'Repeats' : `Repeats ${REPEAT_LABELS[r.frequency].toLowerCase()}`) : undefined,
      onEdit: () => {
        close()
        openEditor(item, s)
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
              ? (draft) => {
                  const ed = editor
                  setEditor(null)
                  // Cancelling the delete goes back to the editor, with any changes made there.
                  void remove(ed.ref, ed.details, () => setEditor({ ...ed, draft }))
                }
              : undefined
          }
          onClose={closeEditor}
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
    /** Whether new events have somewhere to go; the button still explains when they don't. */
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
