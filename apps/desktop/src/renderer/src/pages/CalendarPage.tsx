import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, ChevronLeft, ChevronRight, Info, Plus, RefreshCw, X } from 'lucide-react'
import {
  startOfDay,
  sameDay,
  step,
  visibleRange,
  type CalendarEvent,
  type CalendarView,
  type DateRange,
} from '@ordo/calendar-core'
import type {
  AccountStatus,
  CalendarListItem,
  CalendarOverlayItem,
  CalendarStatus,
  CalendarSyncProgress,
} from '@ordo/shared'
import { Button } from '../components/Button'
import { Sheet } from '../components/Sheet'
import { AddCalendarSheet } from '../components/calendar/AddCalendarSheet'
import { SegmentedControl } from '../components/SegmentedControl'
import { AgendaView } from '../components/calendar/AgendaView'
import { CalendarList } from '../components/calendar/CalendarList'
import { ItemPopover } from '../components/calendar/ItemPopover'
import { MonthView } from '../components/calendar/MonthView'
import { WeekView } from '../components/calendar/WeekView'
import { firstDayOfWeek, toItems, viewTitle, type CalendarItem } from '../components/calendar/model'
import { loadOverlays, OVERLAY_SOURCES } from '../components/calendar/overlays'
import { CreateCardSheet } from '../components/boards/CreateCardSheet'
import { useToast } from '../components/boards/UndoToast'
import { useEventEditing } from '../components/calendar/useEventEditing'
import { writable } from '../components/calendar/editing'
import { SAMPLE_CALENDARS, sampleEvents } from './calendarSample'

interface Props {
  account: AccountStatus | null
  onConnect: () => void
}

/**
 * Calendar shows the iCloud account connected for Mail, connected Google accounts and any
 * calendars added by link or file. With none of them, it previews sample data.
 */
export function CalendarPage({ account, onConnect }: Props) {
  const [subscriptions, setSubscriptions] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [changes, setChanges] = useState(0)

  // Calendars that work without iCloud: links, files and Google accounts.
  const recount = useCallback(async () => {
    const s = await window.ordo.calendar.status()
    setSubscriptions(s.subscriptions + (s.google ?? 0))
  }, [])
  useEffect(() => {
    let live = true
    void window.ordo.calendar
      .status()
      .then((s) => live && setSubscriptions(s.subscriptions + (s.google ?? 0)))
    return () => {
      live = false
    }
  }, [account])

  if (subscriptions === null) return null
  const add = () => setAdding(true)
  return (
    <>
      {account?.connected || subscriptions > 0 ? (
        <LiveCalendar
          key={account?.connected ? account.email : 'links'}
          icloud={account?.connected === true}
          changes={changes}
          onAdd={add}
          onRemoved={() => void recount()}
        />
      ) : (
        <SampleCalendar onConnect={onConnect} onAdd={add} />
      )}
      {adding && (
        <AddCalendarSheet
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            setChanges((n) => n + 1)
            void recount()
          }}
        />
      )}
    </>
  )
}

const loadSample = async (range: DateRange) => sampleEvents(range)
const loadLive = (range: DateRange) => window.ordo.calendar.events(range)

function SampleCalendar({ onConnect, onAdd }: { onConnect: () => void; onAdd: () => void }) {
  const [calendars, setCalendars] = useState(SAMPLE_CALENDARS)
  return (
    <CalendarBrowser
      listTitle="Sample"
      calendars={calendars}
      onToggle={(id, visible) => setCalendars((cs) => cs.map((c) => (c.id === id ? { ...c, visible } : c)))}
      onAdd={onAdd}
      loadEvents={loadSample}
      reloadKey={0}
      banner={
        <div className="flex items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-ink-2">
          Sample data. Connect your iCloud account, connect a Google account in Settings, or add a calendar by
          link to see your own.
          <span className="flex shrink-0 gap-2">
            <Button onClick={onAdd}>Add calendar…</Button>
            <Button variant="primary" onClick={onConnect}>
              Connect iCloud
            </Button>
          </span>
        </div>
      }
    />
  )
}

/** Sync again on opening if the cache is older than this. */
const STALE_MS = 10 * 60_000

function LiveCalendar({
  icloud,
  changes,
  onAdd,
  onRemoved,
}: {
  icloud: boolean
  /** Bumped when a calendar is added elsewhere, to reload the list. */
  changes: number
  onAdd: () => void
  onRemoved: () => void
}) {
  const [calendars, setCalendars] = useState<CalendarListItem[]>([])
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [progress, setProgress] = useState<CalendarSyncProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [removing, setRemoving] = useState<CalendarListItem | null>(null)
  const [reauth, setReauth] = useState<{ id: string; email: string }[]>([])

  const refresh = useCallback(async () => {
    const [c, s, g] = await Promise.all([
      window.ordo.calendar.calendars(),
      window.ordo.calendar.status(),
      window.ordo.google.status(),
    ])
    setCalendars(c)
    setStatus(s)
    setReauth(g.accounts.filter((a) => a.needsReauth))
    setReloadKey((k) => k + 1)
  }, [])

  // Google calendars sync in the background: show what changed.
  useEffect(() => window.ordo.calendar.onChanged(() => void refresh()), [refresh])
  useEffect(() => {
    let live = true
    void window.ordo.google.status().then((g) => live && setReauth(g.accounts.filter((a) => a.needsReauth)))
    return () => {
      live = false
    }
  }, [])

  const signInAgain = async (id: string) => {
    const r = await window.ordo.google.connect({ accountId: id })
    if (!r.ok && r.error !== 'cancelled') setError(r.message)
    await refresh()
  }

  const sync = useCallback(
    async (force = false) => {
      setError(null)
      setProgress({ done: 0, total: 0 })
      const off = window.ordo.calendar.onSyncProgress(setProgress)
      try {
        const res = await window.ordo.calendar.sync({ force })
        if (!res.ok && res.error !== 'busy') setError(res.message)
        if (res.ok && res.failed?.length) setError(failedMessage(res.failed))
        await refresh()
      } finally {
        off()
        setProgress(null)
      }
    },
    [refresh],
  )

  // Show the cache straight away, then sync in the background if it's stale.
  useEffect(() => {
    let live = true
    void Promise.all([window.ordo.calendar.calendars(), window.ordo.calendar.status()]).then(([c, s]) => {
      if (!live) return
      setCalendars(c)
      setStatus(s)
      if (!s.lastSync || Date.now() - Date.parse(s.lastSync) > STALE_MS) void sync()
    })
    return () => {
      live = false
    }
  }, [sync])

  // A calendar was added: it's already cached, so just show it.
  useEffect(() => {
    if (!changes) return
    let live = true
    void Promise.all([window.ordo.calendar.calendars(), window.ordo.calendar.status()]).then(([c, s]) => {
      if (!live) return
      setCalendars(c)
      setStatus(s)
      setReloadKey((k) => k + 1)
    })
    return () => {
      live = false
    }
  }, [changes])

  const toggle = async (id: string, visible: boolean) => {
    setCalendars((cs) => cs.map((c) => (c.id === id ? { ...c, visible } : c)))
    await window.ordo.calendar.setVisible({ calendarId: id, visible })
    setReloadKey((k) => k + 1)
  }

  const lastSync = status?.lastSync ?? null
  return (
    <>
      <CalendarBrowser
        listTitle="iCloud"
        editable={calendars.some(writable)}
        calendars={calendars}
        onToggle={(id, visible) => void toggle(id, visible)}
        onAdd={onAdd}
        onRemove={setRemoving}
        loadEvents={loadLive}
        reloadKey={reloadKey}
        banner={
          (error || reauth.length > 0) && (
            <div className="flex flex-col gap-2">
              {reauth.map((a) => (
                <div
                  key={a.id}
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-md bg-warn-tint px-3 py-2 text-ink"
                >
                  <span>Google needs you to sign in to {a.email} again before its calendars can update.</span>
                  <Button variant="primary" onClick={() => void signInAgain(a.id)}>
                    Sign in again
                  </Button>
                </div>
              ))}
              {error && <div className="rounded-md bg-hover px-3 py-2 text-danger">{error}</div>}
            </div>
          )
        }
        actions={
          <button
            type="button"
            onClick={() => void sync(true)}
            disabled={progress !== null}
            aria-label="Sync calendars"
            title="Sync calendars"
            className="no-drag flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover disabled:opacity-60"
          >
            <RefreshCw size={14} className={progress ? 'animate-spin' : ''} />
          </button>
        }
        footer={
          <span aria-live="polite">
            {progress
              ? progress.total
                ? `Syncing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
                : icloud
                  ? 'Connecting to iCloud…'
                  : 'Syncing…'
              : lastSync
                ? `Updated ${new Date(lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
                : 'Not synced yet'}
          </span>
        }
      />
      {removing && (
        <RemoveSheet
          calendar={removing}
          onClose={() => setRemoving(null)}
          onRemoved={async () => {
            setRemoving(null)
            await refresh()
            onRemoved()
          }}
        />
      )}
    </>
  )
}

function failedMessage(failed: { name: string; message: string }[]): string {
  if (failed.length === 1)
    return failed[0]!.message.startsWith(failed[0]!.name)
      ? failed[0]!.message
      : `Couldn’t update ${failed[0]!.name}. ${failed[0]!.message}`
  return `Couldn’t update ${failed.map((f) => f.name).join(', ')}. ${failed[0]!.message}`
}

function RemoveSheet({
  calendar,
  onClose,
  onRemoved,
}: {
  calendar: CalendarListItem
  onClose: () => void
  onRemoved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    const r = await window.ordo.calendar.remove(calendar.id)
    setBusy(false)
    if (r.ok) onRemoved()
    else setError(r.message)
  }
  return (
    <Sheet
      title={`Remove “${calendar.name}”?`}
      width={420}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void remove()}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Remove
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-snug text-ink-2">
        {calendar.source === 'link'
          ? 'Ordo stops checking this link and forgets its events. The calendar itself isn’t changed.'
          : 'Ordo forgets the events imported from this file. The file itself isn’t changed.'}
      </p>
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </Sheet>
  )
}

const VIEWS: { value: CalendarView; label: string }[] = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'agenda', label: 'Agenda' },
]
const VIEW_KEY = 'ordo.calendar.view'

function savedView(): CalendarView {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return VIEWS.some((o) => o.value === v) ? (v as CalendarView) : 'month'
  } catch {
    return 'month'
  }
}

interface BrowserProps {
  listTitle: string
  /** Events on writable iCloud calendars can be created, changed and deleted. */
  editable?: boolean
  calendars: CalendarListItem[]
  onToggle: (calendarId: string, visible: boolean) => void
  onAdd?: () => void
  onRemove?: (calendar: CalendarListItem) => void
  /** Must be stable between renders; events are reloaded when it, the range or `reloadKey` changes. */
  loadEvents: (range: DateRange) => Promise<CalendarEvent[]>
  reloadKey: number
  banner?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
}

/** The calendar list, toolbar and current view, independent of where the events come from. */
function CalendarBrowser({
  listTitle,
  editable = false,
  calendars,
  onToggle,
  onAdd,
  onRemove,
  loadEvents,
  reloadKey,
  banner,
  actions,
  footer,
}: BrowserProps) {
  const [view, setViewState] = useState<CalendarView>(savedView)
  const [cursor, setCursor] = useState(() => new Date())
  const [today, setToday] = useState(() => startOfDay(new Date()))
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [overlays, setOverlays] = useState<CalendarOverlayItem[]>([])
  const [selected, setSelected] = useState<{ item: CalendarItem; anchor: DOMRect } | null>(null)
  const [creating, setCreating] = useState<Extract<CalendarItem, { type: 'event' }> | null>(null)
  const toast = useToast()
  const [overlayKey, setOverlayKey] = useState(0)
  const firstDay = useMemo(() => firstDayOfWeek(), [])
  const narrow = useNarrow()
  const range = useMemo(() => visibleRange(view, cursor, firstDay), [view, cursor, firstDay])

  useEffect(() => {
    let live = true
    void loadEvents(range).then((e) => live && setEvents(e))
    void loadOverlays(range).then((o) => live && setOverlays(o))
    return () => {
      live = false
    }
  }, [loadEvents, range, reloadKey, overlayKey])

  // Keep "today" right if the app stays open past midnight.
  useEffect(() => {
    const id = setInterval(
      () => setToday((t) => (sameDay(t, new Date()) ? t : startOfDay(new Date()))),
      60_000,
    )
    return () => clearInterval(id)
  }, [])

  const rangeRef = useRef(range)
  useEffect(() => {
    rangeRef.current = range
  }, [range])
  const reload = useCallback(async () => setEvents(await loadEvents(rangeRef.current)), [loadEvents])
  const editing = useEventEditing({ enabled: editable, calendars, range, reload })
  const { select, display } = editing

  const items = useMemo(
    () => toItems(display(events), overlays, calendars),
    [display, events, overlays, calendars],
  )
  const close = useCallback(() => {
    setSelected(null)
    select(null)
  }, [select])
  const open = useCallback(
    (item: CalendarItem, anchor: DOMRect) => {
      setSelected({ item, anchor })
      select(item)
    },
    [select],
  )

  // Cmd-N (Ctrl-N elsewhere) starts a new event, on today if it's in view.
  const createRef = useRef(editing.create)
  useEffect(() => {
    createRef.current = editing.create
  })
  useEffect(() => {
    if (!editable) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'n') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      e.preventDefault()
      const now = new Date()
      const r = rangeRef.current
      createRef.current(now >= r.start && now < r.end ? now : r.start)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editable])

  const setView = (v: CalendarView) => {
    setViewState(v)
    setSelected(null)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // Not remembering the view is fine.
    }
  }
  const go = (dir: -1 | 1) => {
    setCursor((c) => step(view, c, dir))
    setSelected(null)
  }
  const title = viewTitle(view, cursor, range, { short: narrow })
  /** Double-clicking an event edits it: the popover its first click opened goes. */
  const editItem = (item: CalendarItem) => {
    close()
    void editing.edit(item)
  }

  return (
    <div className="relative flex h-full min-h-0">
      <CalendarList
        title={listTitle}
        calendars={calendars}
        onToggle={onToggle}
        onAdd={onAdd}
        onRemove={onRemove}
        overlaySources={OVERLAY_SOURCES}
        footer={footer}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {banner && <div className="shrink-0 px-4 pt-3">{banner}</div>}
        {editing.notice && (
          <div className="shrink-0 px-4 pt-3">
            <div
              role={editing.notice.kind === 'error' ? 'alert' : 'status'}
              data-kind={editing.notice.kind}
              className="flex items-start gap-2 rounded-md bg-hover px-3 py-2 text-ink"
            >
              {editing.notice.kind === 'error' ? (
                <AlertCircle size={15} className="mt-px shrink-0 text-danger" aria-label="Error" />
              ) : (
                <Info size={15} className="mt-px shrink-0 text-ink-2" aria-hidden="true" />
              )}
              <span className="flex-1">{editing.notice.text}</span>
              <button
                type="button"
                onClick={editing.dismissNotice}
                aria-label="Dismiss"
                className="no-drag -mr-1 flex size-5 shrink-0 items-center justify-center rounded text-ink-2 hover:bg-selected hover:text-ink"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )}
        <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-sep px-4">
          <h2 className="truncate text-[20px] tracking-tight" data-testid="calendar-title" aria-live="polite">
            <span className="font-semibold">{title.month}</span>{' '}
            <span className="font-normal text-ink-2">{title.year}</span>
          </h2>
          <SegmentedControl label="Calendar view" options={VIEWS} value={view} onChange={setView} />
          <div className="flex items-center justify-end gap-1">
            {editable && (
              <NavButton
                label="New event"
                title={`New event (${navigator.platform.startsWith('Mac') ? '⌘N' : 'Ctrl+N'})`}
                // Still clickable when there's nowhere to put an event, so it can say why.
                ariaDisabled={!editing.canCreate}
                onClick={() => {
                  const now = new Date()
                  editing.create(now >= range.start && now < range.end ? now : range.start)
                }}
              >
                <Plus size={16} />
              </NavButton>
            )}
            {actions}
            <NavButton label="Previous" onClick={() => go(-1)}>
              <ChevronLeft size={16} />
            </NavButton>
            <Button
              onClick={() => {
                setCursor(new Date())
                setSelected(null)
              }}
            >
              Today
            </Button>
            <NavButton label="Next" onClick={() => go(1)}>
              <ChevronRight size={16} />
            </NavButton>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {view === 'month' && (
            <MonthView
              range={range}
              cursor={cursor}
              today={today}
              items={items}
              onOpen={open}
              onShowDay={(d) => {
                setCursor(d)
                setView('week')
              }}
              onCreate={editable ? (d) => editing.create(d) : undefined}
              onEditItem={editable ? editItem : undefined}
            />
          )}
          {view === 'week' && (
            <WeekView
              range={range}
              today={today}
              items={items}
              onOpen={open}
              onCreate={editable ? (at, allDay) => editing.create(at, { allDay, exact: !allDay }) : undefined}
              onEditItem={editable ? editItem : undefined}
              canMove={editable ? editing.canMove : undefined}
              onMove={editable ? editing.move : undefined}
            />
          )}
          {view === 'agenda' && <AgendaView range={range} today={today} items={items} onOpen={open} />}
        </div>
      </div>
      {selected && (
        <ItemPopover
          item={selected.item}
          anchor={selected.anchor}
          onClose={close}
          edit={editing.popoverEdit(selected.item, close)}
          onOpenRoute={(route) => {
            window.location.hash = `/${route}`
          }}
          onCreateCard={(item) => {
            setSelected(null)
            setCreating(item)
          }}
        />
      )}
      {editing.sheets}
      {creating && (
        <CreateCardSheet
          event={creating.event}
          calendarName={creating.calendar?.name}
          onClose={() => setCreating(null)}
          onCreated={(id, boardName) => {
            setCreating(null)
            setOverlayKey((k) => k + 1)
            toast.show(`Added to ${boardName}`, {
              action: {
                label: 'Open',
                onClick: () => {
                  window.location.hash = `/boards?card=${encodeURIComponent(id)}`
                },
              },
            })
          }}
        />
      )}
      {toast.node}
    </div>
  )
}

function NavButton({
  label,
  title = label,
  ariaDisabled,
  onClick,
  children,
}: {
  label: string
  title?: string
  /** Looks and reads as unavailable but can still be clicked, to explain why. */
  ariaDisabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title}
      aria-disabled={ariaDisabled || undefined}
      className="no-drag flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink aria-disabled:opacity-40 aria-disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

/** Below about 1100px the toolbar is tight: the title uses the short month ("Nov 2026"). */
function useNarrow(): boolean {
  const query = '(max-width: 1099px)'
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return narrow
}
