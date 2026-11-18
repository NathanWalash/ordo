import { DatabaseSync } from 'node:sqlite'
import { overlaps } from './time'
import type { FeedKind } from './feeds'
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarResource,
  CalendarSource,
  DateRange,
  RemoteCalendar,
} from './types'

/** A cached calendar, with the user's choice of whether to show it. */
export interface StoredCalendar extends CalendarInfo {
  visible: boolean
}

/**
 * A subscribed link or imported file, as saved. `secret` is the link as the app stores it
 * (encrypted by the caller); `host` is safe to show. Files keep their whole `ics` text.
 */
export interface StoredFeed {
  id: string
  kind: FeedKind
  name: string
  color?: string
  secret?: string
  host?: string
  ics?: string
}

/** What was fetched for a calendar last time, so unchanged calendars can be skipped. */
export interface CalendarSyncState {
  version: string | null
  from: Date
  to: Date
}

type CalendarRow = {
  id: string
  source: string
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
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  secret TEXT,
  host TEXT,
  ics TEXT,
  added INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
  calendar_id TEXT NOT NULL,
  href TEXT NOT NULL,
  uid TEXT NOT NULL,
  etag TEXT,
  ics TEXT NOT NULL,
  PRIMARY KEY (calendar_id, href)
);
CREATE INDEX IF NOT EXISTS resources_uid ON resources (calendar_id, uid);
`

/**
 * Bumped when the cache needs a full refetch to fill something new in. 2: CalDAV resources
 * (href, ETag and iCalendar) are kept, so events can be changed.
 */
const SCHEMA_VERSION = '2'

/** Calendars from the iCloud account; subscribed links and files belong to FEEDS. */
export const ICLOUD = 'icloud'
export const FEEDS = 'feeds'

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
    // The app and a headless Ordo may share this file: wait for the other's write instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    const cols = this.db.prepare('PRAGMA table_info(calendars)').all() as { name: string }[]
    if (!cols.some((c) => c.name === 'provider'))
      this.db.exec(`ALTER TABLE calendars ADD COLUMN provider TEXT NOT NULL DEFAULT '${ICLOUD}'`)
    if (this.meta('schema') !== SCHEMA_VERSION) {
      // Calendars cached before resources were kept: make the next sync fetch them again, and
      // forget when the last sync was so the app syncs as soon as it opens.
      this.db.exec('UPDATE calendars SET version = NULL')
      this.setMeta('lastSync', null)
      this.setMeta('schema', SCHEMA_VERSION)
    }
  }

  /** One calendar, with which provider owns it. */
  calendar(id: string): (StoredCalendar & { provider: string }) | null {
    const r = this.db
      .prepare(
        `SELECT c.*, COALESCE(f.kind, '${ICLOUD}') AS source FROM calendars c ` +
          'LEFT JOIN feeds f ON f.id = c.id WHERE c.id = ?',
      )
      .get(id) as (CalendarRow & { provider: string }) | undefined
    if (!r) return null
    return {
      id: r.id,
      name: r.name,
      color: r.color ?? undefined,
      readOnly: r.read_only === 1,
      visible: r.visible === 1,
      source: r.source as CalendarSource,
      provider: r.provider,
    }
  }

  /** iCloud calendars first, then subscriptions in the order they were added. */
  calendars(): StoredCalendar[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COALESCE(f.kind, '${ICLOUD}') AS source FROM calendars c ` +
          `LEFT JOIN feeds f ON f.id = c.id ORDER BY c.provider = '${FEEDS}', c.position`,
      )
      .all() as CalendarRow[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color ?? undefined,
      readOnly: r.read_only === 1,
      visible: r.visible === 1,
      source: r.source as CalendarSource,
    }))
  }

  /**
   * Record a provider's current list of calendars. Keeps each calendar's visibility and
   * sync state, and forgets that provider's calendars (and their events) that no longer exist.
   * Other providers' calendars are left alone.
   */
  setCalendars(list: RemoteCalendar[], provider: string = ICLOUD): void {
    const upsert = this.db.prepare(
      'INSERT INTO calendars (id, name, color, read_only, position, provider) VALUES (?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color, ' +
        'read_only = excluded.read_only, position = excluded.position, provider = excluded.provider',
    )
    const ids = new Set(list.map((c) => c.id))
    const gone = (
      this.db.prepare('SELECT id FROM calendars WHERE provider = ?').all(provider) as { id: string }[]
    ).filter((c) => !ids.has(c.id))
    this.transaction(() => {
      list.forEach((c, i) => upsert.run(c.id, c.name, c.color ?? null, c.readOnly ? 1 : 0, i, provider))
      for (const c of gone) this.dropCalendar(c.id)
    })
  }

  feeds(): StoredFeed[] {
    const rows = this.db.prepare('SELECT * FROM feeds ORDER BY added, id').all() as {
      id: string
      kind: FeedKind
      name: string
      color: string | null
      secret: string | null
      host: string | null
      ics: string | null
    }[]
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      color: r.color ?? undefined,
      secret: r.secret ?? undefined,
      host: r.host ?? undefined,
      ics: r.ics ?? undefined,
    }))
  }

  feedCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM feeds').get() as { n: number }).n
  }

  addFeed(feed: StoredFeed): void {
    this.db
      .prepare(
        'INSERT INTO feeds (id, kind, name, color, secret, host, ics, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        feed.id,
        feed.kind,
        feed.name,
        feed.color ?? null,
        feed.secret ?? null,
        feed.host ?? null,
        feed.ics ?? null,
        Date.now(),
      )
  }

  /** Forget a subscription or imported file, with its calendar and events. False if there's no such feed. */
  removeFeed(id: string): boolean {
    let removed = false
    this.transaction(() => {
      removed = Number(this.db.prepare('DELETE FROM feeds WHERE id = ?').run(id).changes) > 0
      if (removed) this.dropCalendar(id)
    })
    return removed
  }

  /** Forget one provider's calendars and events, e.g. iCloud's when the account is disconnected. */
  clearProvider(provider: string): void {
    const ids = this.db.prepare('SELECT id FROM calendars WHERE provider = ?').all(provider) as {
      id: string
    }[]
    this.transaction(() => ids.forEach((c) => this.dropCalendar(c.id)))
  }

  private dropCalendar(id: string): void {
    this.db.prepare('DELETE FROM events WHERE calendar_id = ?').run(id)
    this.db.prepare('DELETE FROM resources WHERE calendar_id = ?').run(id)
    this.db.prepare('DELETE FROM calendars WHERE id = ?').run(id)
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

  /**
   * Replace every cached occurrence of a calendar with a fresh fetch of `window`. CalDAV
   * calendars also pass the resources the events came from, so they can be changed later.
   */
  replaceEvents(
    calendarId: string,
    events: CalendarEvent[],
    window: DateRange,
    version?: string,
    resources?: CalendarResource[],
  ): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE calendar_id = ?').run(calendarId)
      this.insertEvents(calendarId, events)
      if (resources) {
        this.db.prepare('DELETE FROM resources WHERE calendar_id = ?').run(calendarId)
        this.insertResources(calendarId, resources)
      }
      this.db
        .prepare('UPDATE calendars SET version = ?, synced_from = ?, synced_to = ? WHERE id = ?')
        .run(version ?? null, window.start.getTime(), window.end.getTime(), calendarId)
    })
  }

  /** The calendars with a cached event `uid` (normally one), in list order. */
  calendarsWithEvent(uid: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT c.id FROM calendars c WHERE EXISTS (SELECT 1 FROM events e WHERE e.calendar_id = c.id AND e.uid = ?) ' +
          'OR EXISTS (SELECT 1 FROM resources r WHERE r.calendar_id = c.id AND r.uid = ?) ' +
          `ORDER BY c.provider = '${FEEDS}', c.position`,
      )
      .all(uid, uid) as { id: string }[]
    return rows.map((r) => r.id)
  }

  /** The cached CalDAV resources holding event `uid` (normally one). */
  resources(calendarId: string, uid: string): CalendarResource[] {
    const rows = this.db
      .prepare('SELECT href, uid, etag, ics FROM resources WHERE calendar_id = ? AND uid = ? ORDER BY href')
      .all(calendarId, uid) as { href: string; uid: string; etag: string | null; ics: string }[]
    return rows.map((r) => ({ href: r.href, uid: r.uid, etag: r.etag ?? undefined, ics: r.ics }))
  }

  /**
   * After a change Ordo made: the resource at `href` is now `resource` (or gone, with null), and
   * event `uid`'s cached occurrences are now `events`.
   */
  replaceResource(
    calendarId: string,
    uid: string,
    href: string,
    resource: CalendarResource | null,
    events: CalendarEvent[],
  ): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM resources WHERE calendar_id = ? AND href = ?').run(calendarId, href)
      if (resource) this.insertResources(calendarId, [resource])
      this.db.prepare('DELETE FROM events WHERE calendar_id = ? AND uid = ?').run(calendarId, uid)
      this.insertEvents(calendarId, events)
    })
  }

  private insertEvents(calendarId: string, events: CalendarEvent[]): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO events (calendar_id, uid, recurrence_id, title, start, end, all_day, location, notes) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
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
  }

  private insertResources(calendarId: string, resources: CalendarResource[]): void {
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO resources (calendar_id, href, uid, etag, ics) VALUES (?, ?, ?, ?, ?)',
    )
    for (const r of resources) insert.run(calendarId, r.href, r.uid, r.etag ?? null, r.ics)
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

  /** Forget everything: every calendar, event, subscription and note. */
  clear(): void {
    this.db.exec(
      'DELETE FROM events; DELETE FROM resources; DELETE FROM calendars; DELETE FROM meta; DELETE FROM feeds;',
    )
    this.setMeta('schema', SCHEMA_VERSION)
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
