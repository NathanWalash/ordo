import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
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
import { SegmentedControl } from '../components/SegmentedControl'
import { AgendaView } from '../components/calendar/AgendaView'
import { CalendarList } from '../components/calendar/CalendarList'
import { ItemPopover } from '../components/calendar/ItemPopover'
import { MonthView } from '../components/calendar/MonthView'
import { WeekView } from '../components/calendar/WeekView'
import { firstDayOfWeek, toItems, viewTitle, type CalendarItem } from '../components/calendar/model'
import { loadOverlays, OVERLAY_SOURCES } from '../components/calendar/overlays'
import { SAMPLE_CALENDARS, sampleEvents } from './calendarSample'

interface Props {
  account: AccountStatus | null
  onConnect: () => void
}

/** Calendar uses the iCloud account connected for Mail. Until then it previews sample data. */
export function CalendarPage({ account, onConnect }: Props) {
  if (!account?.connected) return <SampleCalendar onConnect={onConnect} />
  return <LiveCalendar key={account.email} />
}

const loadSample = async (range: DateRange) => sampleEvents(range)
const loadLive = (range: DateRange) => window.ordo.calendar.events(range)

function SampleCalendar({ onConnect }: { onConnect: () => void }) {
  const [calendars, setCalendars] = useState(SAMPLE_CALENDARS)
  return (
    <CalendarBrowser
      listTitle="Sample"
      calendars={calendars}
      onToggle={(id, visible) => setCalendars((cs) => cs.map((c) => (c.id === id ? { ...c, visible } : c)))}
      loadEvents={loadSample}
      reloadKey={0}
      banner={
        <div className="flex items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-ink-2">
          Sample data. Connect your iCloud account to see your own calendars.
          <Button variant="primary" onClick={onConnect}>
            Connect iCloud
          </Button>
        </div>
      }
    />
  )
}

/** Sync again on opening if the cache is older than this. */
const STALE_MS = 10 * 60_000

function LiveCalendar() {
  const [calendars, setCalendars] = useState<CalendarListItem[]>([])
  const [status, setStatus] = useState<CalendarStatus | null>(null)
  const [progress, setProgress] = useState<CalendarSyncProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const refresh = useCallback(async () => {
    const [c, s] = await Promise.all([window.ordo.calendar.calendars(), window.ordo.calendar.status()])
    setCalendars(c)
    setStatus(s)
    setReloadKey((k) => k + 1)
  }, [])

  const sync = useCallback(
    async (force = false) => {
      setError(null)
      setProgress({ done: 0, total: 0 })
      const off = window.ordo.calendar.onSyncProgress(setProgress)
      try {
        const res = await window.ordo.calendar.sync({ force })
        if (!res.ok && res.error !== 'busy') setError(res.message)
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
      if (s.connected && (!s.lastSync || Date.now() - Date.parse(s.lastSync) > STALE_MS)) void sync()
    })
    return () => {
      live = false
    }
  }, [sync])

  const toggle = async (id: string, visible: boolean) => {
    setCalendars((cs) => cs.map((c) => (c.id === id ? { ...c, visible } : c)))
    await window.ordo.calendar.setVisible({ calendarId: id, visible })
    setReloadKey((k) => k + 1)
  }

  const lastSync = status?.connected ? status.lastSync : null
  return (
    <CalendarBrowser
      listTitle="iCloud"
      calendars={calendars}
      onToggle={(id, visible) => void toggle(id, visible)}
      loadEvents={loadLive}
      reloadKey={reloadKey}
      banner={error && <div className="rounded-md bg-hover px-3 py-2 text-danger">{error}</div>}
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
              : 'Connecting to iCloud…'
            : lastSync
              ? `Updated ${new Date(lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
              : 'Not synced yet'}
        </span>
      }
    />
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
  calendars: CalendarListItem[]
  onToggle: (calendarId: string, visible: boolean) => void
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
  calendars,
  onToggle,
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
  const firstDay = useMemo(() => firstDayOfWeek(), [])
  const range = useMemo(() => visibleRange(view, cursor, firstDay), [view, cursor, firstDay])

  useEffect(() => {
    let live = true
    void loadEvents(range).then((e) => live && setEvents(e))
    void loadOverlays(range).then((o) => live && setOverlays(o))
    return () => {
      live = false
    }
  }, [loadEvents, range, reloadKey])

  // Keep "today" right if the app stays open past midnight.
  useEffect(() => {
    const id = setInterval(
      () => setToday((t) => (sameDay(t, new Date()) ? t : startOfDay(new Date()))),
      60_000,
    )
    return () => clearInterval(id)
  }, [])

  const items = useMemo(() => toItems(events, overlays, calendars), [events, overlays, calendars])
  const close = useCallback(() => setSelected(null), [])
  const open = useCallback((item: CalendarItem, anchor: DOMRect) => setSelected({ item, anchor }), [])

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
  const title = viewTitle(view, cursor, range)

  return (
    <div className="flex h-full min-h-0">
      <CalendarList
        title={listTitle}
        calendars={calendars}
        onToggle={onToggle}
        overlaySources={OVERLAY_SOURCES}
        footer={footer}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {banner && <div className="shrink-0 px-4 pt-3">{banner}</div>}
        <div className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-sep px-4">
          <h2 className="truncate text-[20px] tracking-tight" data-testid="calendar-title" aria-live="polite">
            <span className="font-semibold">{title.month}</span>{' '}
            <span className="font-normal text-ink-2">{title.year}</span>
          </h2>
          <SegmentedControl label="Calendar view" options={VIEWS} value={view} onChange={setView} />
          <div className="flex items-center justify-end gap-1">
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
            />
          )}
          {view === 'week' && <WeekView range={range} today={today} items={items} onOpen={open} />}
          {view === 'agenda' && <AgendaView range={range} today={today} items={items} onOpen={open} />}
        </div>
      </div>
      {selected && <ItemPopover item={selected.item} anchor={selected.anchor} onClose={close} />}
    </div>
  )
}

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="no-drag flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
    >
      {children}
    </button>
  )
}
