import { DatabaseSync } from 'node:sqlite'
import { overlaps } from './time'
import type { CalendarEvent, CalendarInfo, DateRange, RemoteCalendar } from './types'

/** A cached calendar, with the user's choice of whether to show it. */
export interface StoredCalendar extends CalendarInfo {
  visible: boolean
}

/** What was fetched for a calendar last time, so unchanged calendars can be skipped. */
export interface CalendarSyncState {
  version: string | null
  from: Date
  to: Date
}

type CalendarRow = {
  id: string
  name: string
  color: string | null
  read_only: number
  visible: number
  version: string | null
  synced_from: number | null
  synced_to: number | null
}

type EventRow = {
  calendar_id: string
  uid: string
  recurrence_id: string
  title: string
  start: number
  end: number
  all_day: number
  location: string | null
  notes: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  read_only INTEGER NOT NULL,
  visible INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL,
  version TEXT,
  synced_from INTEGER,
  synced_to INTEGER
);
CREATE TABLE IF NOT EXISTS events (
  calendar_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  recurrence_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  all_day INTEGER NOT NULL,
  location TEXT,
  notes TEXT,
  PRIMARY KEY (calendar_id, uid, recurrence_id)
);
CREATE INDEX IF NOT EXISTS events_start ON events (start);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const DAY_MS = 86_400_000

/*
 * All-day events are stored as UTC midnight of their date rather than local midnight, so
 * they stay on the right day if the computer's time zone changes. Timed events are instants.
 */
const toUtcDate = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
const fromUtcDate = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Local cache of calendars and event occurrences, backed by Node's built-in SQLite. */
export class CalendarStore {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  calendars(): StoredCalendar[] {
    const rows = this.db.prepare('SELECT * FROM calendars ORDER BY position').all() as CalendarRow[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color ?? undefined,
      readOnly: r.read_only === 1,
      visible: r.visible === 1,
    }))
  }

  /**
   * Record the provider's current list of calendars. Keeps each calendar's visibility and
   * sync state, and forgets calendars (and their events) that no longer exist.
   */
  setCalendars(list: RemoteCalendar[]): void {
    const upsert = this.db.prepare(
      'INSERT INTO calendars (id, name, color, read_only, position) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, ' +
        'read_only = excluded.read_only, position = excluded.position',
    )
    const ids = new Set(list.map((c) => c.id))
    const gone = this.calendars().filter((c) => !ids.has(c.id))
    this.transaction(() => {
      list.forEach((c, i) => upsert.run(c.id, c.name, c.color ?? null, c.readOnly ? 1 : 0, i))
      for (const c of gone) {
        this.db.prepare('DELETE FROM events WHERE calendar_id = ?').run(c.id)
        this.db.prepare('DELETE FROM calendars WHERE id = ?').run(c.id)
      }
    })
  }

  setVisible(calendarId: string, visible: boolean): void {
    this.db.prepare('UPDATE calendars SET visible = ? WHERE id = ?').run(visible ? 1 : 0, calendarId)
  }

  syncState(calendarId: string): CalendarSyncState | null {
    const r = this.db
      .prepare('SELECT version, synced_from, synced_to FROM calendars WHERE id = ?')
      .get(calendarId) as Pick<CalendarRow, 'version' | 'synced_from' | 'synced_to'> | undefined
    if (!r || r.synced_from === null || r.synced_to === null) return null
    return { version: r.version, from: new Date(r.synced_from), to: new Date(r.synced_to) }
  }

  /** Replace every cached occurrence of a calendar with a fresh fetch of `window`. */
  replaceEvents(calendarId: string, events: CalendarEvent[], window: DateRange, version?: string): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO events (calendar_id, uid, recurrence_id, title, start, end, all_day, location, notes) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE calendar_id = ?').run(calendarId)
      for (const e of events) {
        insert.run(
          calendarId,
          e.uid,
          e.recurrenceId ?? '',
          e.title,
          e.allDay ? toUtcDate(e.start) : e.start.getTime(),
          e.allDay ? toUtcDate(e.end) : e.end.getTime(),
          e.allDay ? 1 : 0,
          e.location ?? null,
          e.notes ?? null,
        )
      }
      this.db
        .prepare('UPDATE calendars SET version = ?, synced_from = ?, synced_to = ? WHERE id = ?')
        .run(version ?? null, window.start.getTime(), window.end.getTime(), calendarId)
    })
  }

  /** Occurrences overlapping `range`, earliest first. By default only from visible calendars. */
  events(range: DateRange, { includeHidden = false } = {}): CalendarEvent[] {
    // All-day rows are UTC dates, up to a day away from local midnight: widen, then filter exactly.
    const rows = this.db
      .prepare(
        'SELECT e.* FROM events e JOIN calendars c ON c.id = e.calendar_id ' +
          'WHERE e.start < ? AND e.end > ? AND (? OR c.visible = 1) ORDER BY e.start',
      )
      .all(range.end.getTime() + DAY_MS, range.start.getTime() - DAY_MS, includeHidden ? 1 : 0) as EventRow[]
    return rows
      .map((r): CalendarEvent => ({
        uid: r.uid,
        calendarId: r.calendar_id,
        title: r.title,
        start: r.all_day ? fromUtcDate(r.start) : new Date(r.start),
        end: r.all_day ? fromUtcDate(r.end) : new Date(r.end),
        allDay: r.all_day === 1,
        location: r.location ?? undefined,
        notes: r.notes ?? undefined,
        recurrenceId: r.recurrence_id || undefined,
      }))
      .filter((e) => overlaps(e.start, e.end, range))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n
  }

  meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined
    return r?.value ?? null
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key)
    else
      this.db
        .prepare(
          'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(key, value)
  }

  /** Forget every calendar and event, e.g. when the account is disconnected. */
  clear(): void {
    this.db.exec('DELETE FROM events; DELETE FROM calendars; DELETE FROM meta;')
  }

  close(): void {
    this.db.close()
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
