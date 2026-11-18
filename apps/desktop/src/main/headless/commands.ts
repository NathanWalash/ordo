import type {
  AccountStatus,
  AiProviderStatus,
  AiSettings,
  AiSortOutcome,
  AiSortProgress,
  CalendarChangeOutcome,
  CalendarEvent,
  CalendarListItem,
  CreateEventInput,
  DeleteEventInput,
  EventDetails,
  EventDraft,
  EventRef,
  UpdateEventInput,
  CalendarStatus,
  CalendarSyncOutcome,
  CalendarSyncProgress,
  CategorisedSender,
  CleanupOutcome,
  CleanupProgress,
  CleanupRequest,
  CleanupSummary,
  ImportOutcome,
  MoneyAiOutcome,
  MoneyAiProgress,
  MoneyOverview,
  ScanOutcome,
  ScanProgress,
  TransactionPage,
  TransactionQuery,
  UndoOutcome,
} from '@ordo/shared'
import type { CleanupPlan, PlannedSender } from '@ordo/mail-core'
import { localZone } from '@ordo/calendar-core'
import type { LockHolder } from '../lock'
import { CHANGE_COMMANDS, type Command } from './args'

/**
 * Everything headless mode can do, as plain functions. In the app these are the very functions
 * the IPC handlers call (see `services.ts`), so every check (People, the SSRF guard, mailto limits,
 * cloud-AI consent, the write lock) applies here too. Tests pass fakes.
 */
export interface OrdoServices {
  version: string
  account(): AccountStatus
  scan(onProgress?: (p: ScanProgress) => void): Promise<ScanOutcome>
  senders(): Promise<(CategorisedSender & { sortedBy?: 'rules' | 'ai'; confidence?: number })[]>
  cleanup: {
    plan(
      request: CleanupRequest,
    ): { ok: true; plan: CleanupPlan } | { ok: false; error: string; message: string }
    run(request: CleanupRequest, onProgress?: (p: CleanupProgress) => void): Promise<CleanupOutcome>
    history(): CleanupSummary[]
    undo(id: number): Promise<UndoOutcome>
  }
  calendar: {
    status(): CalendarStatus
    sync(onProgress?: (p: CalendarSyncProgress) => void): Promise<CalendarSyncOutcome>
    calendars(): CalendarListItem[]
    events(range: { start: Date; end: Date }): CalendarEvent[]
    /** The calendars with a cached event of this UID. */
    locate(uid: string): string[]
    details(ref: EventRef): EventDetails | null
    createEvent(input: CreateEventInput): Promise<CalendarChangeOutcome>
    updateEvent(input: UpdateEventInput): Promise<CalendarChangeOutcome>
    deleteEvent(input: DeleteEventInput): Promise<CalendarChangeOutcome>
  }
  money: {
    overview(): Promise<MoneyOverview>
    transactions(query: TransactionQuery): Promise<TransactionPage>
    importFile(path: string, accountName?: string): Promise<ImportOutcome>
    counts(): { transactions: number; accounts: number; bills: number }
    /** Sort with AI: categories for merchants in Other, then bill matching. Needs AI for Money on. */
    aiSort(onProgress?: (p: MoneyAiProgress) => void): Promise<MoneyAiOutcome>
  }
  ai: {
    settings(): AiSettings
    status(): Promise<AiProviderStatus[]>
    sort(onProgress?: (p: AiSortProgress) => void): Promise<AiSortOutcome>
  }
  /** Who holds the write lock right now, if anyone. */
  lockHolder(): LockHolder | null
}

/** Progress for long-running commands; the CLI prints it to stderr. */
export interface Progress {
  scan?: (p: ScanProgress) => void
  cleanup?: (p: CleanupProgress) => void
  calendar?: (p: CalendarSyncProgress) => void
  ai?: (p: AiSortProgress) => void
  money?: (p: MoneyAiProgress) => void
}

export type ErrorCode =
  | 'usage'
  | 'changes_not_allowed'
  | 'confirm_required'
  | 'not_connected'
  | 'locked'
  | 'busy'
  | 'auth'
  | 'network'
  | 'invalid'
  | 'unavailable'
  | 'conflict'
  | 'not_found'
  | 'read_only'
  | 'failed'
  | 'unknown'
  | 'internal'

export type CommandResult = { ok: true; data: unknown } | { ok: false; code: ErrorCode; message: string }

/**
 * Exit codes: 0 done, 1 the command ran and failed (not connected, network, refused by Ordo's
 * own checks), 2 bad arguments, 3 a change without --allow-changes or --confirm, 4 another
 * Ordo process is writing.
 */
export function exitCodeFor(result: CommandResult): number {
  if (result.ok) return 0
  switch (result.code) {
    case 'usage':
      return 2
    case 'changes_not_allowed':
    case 'confirm_required':
      return 3
    case 'locked':
      return 4
    default:
      return 1
  }
}

const fail = (code: ErrorCode, message: string): CommandResult => ({ ok: false, code, message })
const KNOWN_CODES = new Set<string>([
  'locked',
  'busy',
  'auth',
  'network',
  'invalid',
  'unavailable',
  'unknown',
])
const fromService = (r: { error?: string; message: string }): CommandResult =>
  fail(r.error && KNOWN_CODES.has(r.error) ? (r.error as ErrorCode) : 'failed', r.message)

/** A calendar change that didn't happen, as a headless error code. */
function fromChange(r: Extract<CalendarChangeOutcome, { ok: false }>): CommandResult {
  const codes: Record<string, ErrorCode> = {
    conflict: 'conflict',
    'not-found': 'not_found',
    'read-only': 'read_only',
    invitation: 'read_only',
    'not-connected': 'not_connected',
    locked: 'locked',
    auth: 'auth',
    network: 'network',
    invalid: 'invalid',
  }
  return fail(codes[r.error] ?? 'failed', r.message)
}

// ---- Calendar changes --------------------------------------------------------------------------

type EventFlags = {
  title?: string
  start?: string
  end?: string
  'time-zone'?: string
  location?: string
  notes?: string
  repeat?: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'none'
  until?: string
  count?: number
  alert?: number | null
}

const isDay = (s: string) => s.length === 10
const pad2 = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DDTHH:MM` plus some minutes, on the clock face. */
function plusMinutes(t: string, minutes: number): string {
  const [d, hm] = t.split('T') as [string, string]
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const [h, mi] = hm.split(':').map(Number) as [number, number]
  const x = new Date(Date.UTC(y, m - 1, day, h, mi + minutes))
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}T${pad2(x.getUTCHours())}:${pad2(x.getUTCMinutes())}`
}
const minutesBetween = (a: string, b: string) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60_000
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
const plusDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10)

/**
 * The draft after applying the flags to `base` (an existing event), or a new one. A day for
 * --start makes it all-day; a time makes it timed. Without --end, it keeps its length (an hour,
 * or one day, when new).
 */
export function draftFromFlags(
  base: EventDraft | null,
  f: EventFlags,
  localZone: string,
): EventDraft | string {
  const start = f.start ?? base?.start
  if (!start) return 'Give the event a --start'
  const allDay = isDay(start)
  let end = f.end
  if (end && isDay(end) !== allDay)
    return allDay ? '--end must be a day too, like --start' : '--end must be a time too, like --start'
  if (!end) {
    if (base && base.allDay === allDay && f.start)
      end = allDay
        ? plusDays(start, daysBetween(base.start, base.end))
        : plusMinutes(start, minutesBetween(base.start, base.end))
    else if (base && base.allDay === allDay) end = base.end
    else end = allDay ? start : plusMinutes(start, 60)
  }
  let repeat = base?.repeat ?? null
  if (f.repeat === 'none') repeat = null
  else if (f.repeat) repeat = { frequency: f.repeat }
  if (f.until !== undefined || f.count !== undefined) {
    if (!repeat) return '--until and --count need --repeat'
    if (f.until !== undefined && f.count !== undefined) return 'Use --until or --count, not both'
    repeat = {
      frequency: repeat.frequency,
      ...(f.until !== undefined ? { until: f.until } : { count: f.count }),
    }
  } else if (f.repeat && f.repeat !== 'none' && base?.repeat && f.repeat === base.repeat.frequency)
    repeat = base.repeat
  return {
    title: f.title ?? base?.title ?? '',
    allDay,
    start,
    end,
    timeZone: allDay ? null : (f['time-zone'] ?? (base && !base.allDay ? base.timeZone : localZone)),
    location: f.location ?? base?.location ?? '',
    notes: f.notes ?? base?.notes ?? '',
    repeat,
    alert: f.alert !== undefined ? f.alert : (base?.alert ?? null),
  }
}

/** A calendar named on the command line, by id or (ignoring case) by name. */
function pickCalendar(
  services: OrdoServices,
  name: string,
): { ok: true; calendar: CalendarListItem } | { ok: false; result: CommandResult } {
  const all = services.calendar.calendars()
  const byId = all.find((c) => c.id === name)
  if (byId) return { ok: true, calendar: byId }
  const named = all.filter((c) => c.name.toLowerCase() === name.toLowerCase())
  if (named.length === 1) return { ok: true, calendar: named[0]! }
  return {
    ok: false,
    result: named.length
      ? fail('usage', `More than one calendar is called “${name}”. Use its id from \`calendar list --json\`.`)
      : fail('not_found', `There’s no calendar called “${name}”. See \`calendar list\`.`),
  }
}

/** The event a change names, with its details and scope, or why it can't be changed. */
function pickEvent(
  services: OrdoServices,
  c: { uid: string; occurrence?: string; all: boolean; calendar?: string },
):
  | { ok: true; ref: EventRef; details: EventDetails; scope: 'this' | 'all' }
  | { ok: false; result: CommandResult } {
  let calendarId: string
  if (c.calendar) {
    const picked = pickCalendar(services, c.calendar)
    if (!picked.ok) return picked
    calendarId = picked.calendar.id
  } else {
    const found = services.calendar.locate(c.uid)
    if (found.length > 1)
      return {
        ok: false,
        result: fail('usage', 'That event is in more than one calendar. Say which with --calendar.'),
      }
    if (!found.length)
      return {
        ok: false,
        result: fail(
          'not_found',
          'No event has that UID. Run `calendar sync`, then `calendar events --json`.',
        ),
      }
    calendarId = found[0]!
  }
  const ref: EventRef = { calendarId, uid: c.uid, ...(c.occurrence && { recurrenceId: c.occurrence }) }
  const details = services.calendar.details(ref)
  if (!details) {
    const cal = services.calendar.calendars().find((x) => x.id === calendarId)
    return {
      ok: false,
      result: cal?.readOnly
        ? fail('read_only', `“${cal.name}” is read-only, so its events can’t be changed.`)
        : fail('not_found', 'That event wasn’t found. Run `calendar sync` and try again.'),
    }
  }
  if (!details.editable)
    return { ok: false, result: fail('read_only', details.reason ?? 'That event can’t be changed.') }
  if (c.occurrence && !details.recurring)
    return { ok: false, result: fail('usage', 'That event doesn’t repeat: leave out --occurrence.') }
  if (details.recurring && !c.occurrence && !c.all)
    return {
      ok: false,
      result: fail(
        'usage',
        'That event repeats. Add --occurrence <id> (from `calendar events --json`) for one occurrence, or --all for every one.',
      ),
    }
  return { ok: true, ref, details, scope: c.occurrence && !c.all ? 'this' : 'all' }
}

function eventView(d: EventDraft) {
  return {
    title: d.title,
    allDay: d.allDay,
    start: d.start,
    end: d.end,
    timeZone: d.timeZone,
    location: d.location || null,
    repeat: d.repeat,
    alert: d.alert,
  }
}

const NOT_CONNECTED = fail(
  'not_connected',
  'No iCloud account is connected. Open Ordo and connect one in Mail first.',
)

/**
 * The safety gate for changes, the same for the CLI and MCP: the process must have been started
 * with --allow-changes, and the call itself must confirm.
 */
export function gate(name: string, allowChanges: boolean, confirm: boolean): CommandResult | null {
  if (!allowChanges)
    return fail(
      'changes_not_allowed',
      `${name} changes your data, so Ordo only runs it when started with --allow-changes. Nothing was changed.`,
    )
  if (!confirm)
    return fail(
      'confirm_required',
      `${name} changes your data. Add --confirm to go ahead. Nothing was changed.`,
    )
  return null
}

// Output shapes. Kept small: agents read these.

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

export function senderRow(s: CategorisedSender & { sortedBy?: 'rules' | 'ai'; confidence?: number }) {
  return {
    address: s.address,
    name: s.name ?? null,
    category: s.category,
    emails: s.count,
    unread: s.unread,
    lastSeen: iso(s.lastSeen),
    unsubscribe: s.unsubscribe.kind,
    // People are never touched by bulk actions.
    protected: s.category === 'people',
    ...(s.sortedBy === 'ai' && { sortedBy: 'ai', confidence: s.confidence ?? null }),
  }
}

export function plannedRow(s: PlannedSender) {
  const m = s.unsubscribe
  let unsubscribe: Record<string, unknown> | null = null
  if (m?.kind === 'one-click') unsubscribe = { kind: 'one-click', url: m.url }
  else if (m?.kind === 'link') unsubscribe = { kind: 'link', url: m.url, opensBrowser: true }
  else if (m?.kind === 'mailto' && s.mailto)
    unsubscribe = { kind: 'mailto', to: s.mailto.to, subject: s.mailto.subject }
  return {
    address: s.address,
    name: s.name ?? null,
    category: s.category,
    emails: s.count,
    trash: s.trash,
    unsubscribe,
  }
}

export function planView(plan: CleanupPlan) {
  const senders = plan.senders.map(plannedRow)
  return {
    senders,
    rejected: plan.rejected,
    summary: {
      senders: senders.length,
      emailsToTrash: plan.senders.filter((s) => s.trash).reduce((n, s) => n + s.count, 0),
      unsubscribes: plan.senders.filter((s) => s.unsubscribe).length,
    },
  }
}

export function cleanupView(c: CleanupSummary) {
  return {
    id: c.id,
    at: iso(c.at),
    moved: c.moved,
    canUndo: c.canUndo,
    undoneAt: iso(c.undoneAt),
    restored: c.restored,
    error: c.error,
    senders: c.senders.map((s) => ({
      address: s.address,
      name: s.name ?? null,
      moved: s.moved,
      unsubscribe: s.unsubscribe ? { method: s.unsubscribe.method, status: s.unsubscribe.status } : null,
    })),
  }
}

/** A local day `YYYY-MM-DD` as local midnight. */
function day(d: string): Date {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, dd)
}

const page = <T>(all: T[], limit: number, offset = 0) => ({
  total: all.length,
  offset,
  shown: Math.max(0, Math.min(limit, all.length - offset)),
  items: all.slice(offset, offset + limit),
})

function cleanupRequest(c: {
  sender: string[]
  'no-unsubscribe': boolean
  'no-trash': boolean
}): CleanupRequest {
  return {
    senders: c.sender.map((address) => ({
      address,
      unsubscribe: !c['no-unsubscribe'],
      trash: !c['no-trash'],
    })),
  }
}

/** Run one command against the services. Never throws for expected failures. */
export async function runCommand(
  services: OrdoServices,
  command: Command,
  options: { allowChanges: boolean; progress?: Progress; offset?: number },
): Promise<CommandResult> {
  if (CHANGE_COMMANDS.has(command.name)) {
    const blocked = gate(command.name, options.allowChanges, 'confirm' in command && command.confirm === true)
    if (blocked) return blocked
  }
  const offset = options.offset ?? 0
  const connected = () => services.account().connected
  // Calendars added by link or file work without an iCloud account.
  const hasCalendars = () => connected() || services.calendar.status().subscriptions > 0

  switch (command.name) {
    case 'status': {
      const account = services.account()
      const calendar = services.calendar.status()
      const ai = services.ai.settings()
      const holder = services.lockHolder()
      return {
        ok: true,
        data: {
          version: services.version,
          account: account.connected
            ? {
                connected: true,
                email: account.email,
                lastScan: account.lastScan,
                messages: account.messageCount,
              }
            : { connected: false },
          calendar:
            calendar.connected || calendar.subscriptions > 0
              ? {
                  connected: calendar.connected,
                  lastSync: calendar.lastSync,
                  calendars: services.calendar.calendars().length,
                  subscriptions: calendar.subscriptions,
                }
              : { connected: false },
          ai: {
            provider: ai.provider,
            model: ai.model,
            sortSenders: ai.sortSenders,
            money: ai.money,
            cloudConsent: ai.cloudConsent,
          },
          counts: {
            senders: account.connected ? (await services.senders()).length : 0,
            cleanups: account.connected ? services.cleanup.history().length : 0,
            ...services.money.counts(),
          },
          writeLock: holder ? { owner: holder.owner, task: holder.task, since: holder.since } : null,
        },
      }
    }

    case 'scan': {
      if (!connected()) return NOT_CONNECTED
      const r = await services.scan(options.progress?.scan)
      return r.ok
        ? { ok: true, data: { added: r.added, total: r.total, stopped: r.stopped } }
        : fromService(r)
    }

    case 'senders': {
      if (!connected()) return NOT_CONNECTED
      const all = (await services.senders()).filter(
        (s) => !command.category || s.category === command.category,
      )
      const p = page(all, command.limit, offset)
      return {
        ok: true,
        data: { total: p.total, offset: p.offset, shown: p.shown, senders: p.items.map(senderRow) },
      }
    }

    case 'cleanup plan': {
      if (!connected()) return NOT_CONNECTED
      const r = services.cleanup.plan(cleanupRequest(command))
      return r.ok ? { ok: true, data: planView(r.plan) } : fromService(r)
    }

    case 'cleanup run': {
      if (!connected()) return NOT_CONNECTED
      const r = await services.cleanup.run(cleanupRequest(command), options.progress?.cleanup)
      return r.ok
        ? { ok: true, data: { cleanup: cleanupView(r.cleanup), rejected: r.rejected } }
        : fromService(r)
    }

    case 'history': {
      if (!connected()) return NOT_CONNECTED
      const p = page(services.cleanup.history(), command.limit, offset)
      return {
        ok: true,
        data: { total: p.total, offset: p.offset, shown: p.shown, cleanups: p.items.map(cleanupView) },
      }
    }

    case 'undo': {
      if (!connected()) return NOT_CONNECTED
      const r = await services.cleanup.undo(command.id)
      return r.ok
        ? {
            ok: true,
            data: { id: command.id, restored: r.restored, missing: r.missing, reason: r.reason ?? null },
          }
        : fromService(r)
    }

    case 'calendar sync': {
      if (!hasCalendars()) return NOT_CONNECTED
      const r = await services.calendar.sync(options.progress?.calendar)
      if (!r.ok) return fromService(r)
      const { ok: _ok, ...rest } = r
      return { ok: true, data: rest }
    }

    case 'calendar events': {
      if (!hasCalendars()) return NOT_CONNECTED
      const start = day(command.from)
      const end = day(command.to)
      end.setDate(end.getDate() + 1) // --to is inclusive
      const names = new Map(services.calendar.calendars().map((c) => [c.id, c.name]))
      const all = services.calendar
        .events({ start, end })
        .sort((a, b) => a.start.getTime() - b.start.getTime())
      const p = page(all, command.limit, offset)
      return {
        ok: true,
        data: {
          from: command.from,
          to: command.to,
          total: p.total,
          offset: p.offset,
          shown: p.shown,
          events: p.items.map((e) => ({
            title: e.title,
            start: iso(e.start),
            end: iso(e.end),
            allDay: e.allDay,
            calendar: names.get(e.calendarId) ?? null,
            location: e.location ?? null,
            // For `calendar edit` and `calendar delete`.
            uid: e.uid,
            occurrence: e.recurrenceId ?? null,
          })),
        },
      }
    }

    case 'calendar list': {
      if (!hasCalendars()) return NOT_CONNECTED
      return {
        ok: true,
        data: {
          calendars: services.calendar.calendars().map((c) => ({
            id: c.id,
            name: c.name,
            source: c.source ?? 'icloud',
            readOnly: c.readOnly,
            visible: c.visible,
          })),
        },
      }
    }

    case 'calendar add': {
      if (!connected()) return NOT_CONNECTED
      const picked = pickCalendar(services, command.calendar)
      if (!picked.ok) return picked.result
      if (picked.calendar.readOnly)
        return fail('read_only', `“${picked.calendar.name}” is read-only, so events can’t be added to it.`)
      const draft = draftFromFlags(null, command, localZone())
      if (typeof draft === 'string') return fail('usage', draft)
      const r = await services.calendar.createEvent({ calendarId: picked.calendar.id, draft })
      if (!r.ok) return fromChange(r)
      return { ok: true, data: { uid: r.uid, calendar: picked.calendar.name, event: eventView(draft) } }
    }

    case 'calendar edit': {
      if (!connected()) return NOT_CONNECTED
      const fields: (keyof EventFlags)[] = [
        'title',
        'start',
        'end',
        'time-zone',
        'location',
        'notes',
        'repeat',
        'until',
        'count',
        'alert',
      ]
      if (!fields.some((f) => command[f] !== undefined))
        return fail('usage', 'Say what to change, e.g. --title, --start, --end, --location or --repeat.')
      const picked = pickEvent(services, command)
      if (!picked.ok) return picked.result
      const draft = draftFromFlags(picked.details.draft, command, localZone())
      if (typeof draft === 'string') return fail('usage', draft)
      const r = await services.calendar.updateEvent({ ref: picked.ref, draft, scope: picked.scope })
      if (!r.ok) return fromChange(r)
      return { ok: true, data: { uid: r.uid, scope: picked.scope, event: eventView(draft) } }
    }

    case 'calendar delete': {
      if (!connected()) return NOT_CONNECTED
      const picked = pickEvent(services, command)
      if (!picked.ok) return picked.result
      const r = await services.calendar.deleteEvent({ ref: picked.ref, scope: picked.scope })
      if (!r.ok) return fromChange(r)
      return {
        ok: true,
        data: {
          uid: r.uid,
          scope: picked.scope,
          title: picked.details.draft.title,
          ...(picked.scope === 'this' && { occurrence: picked.ref.recurrenceId }),
        },
      }
    }

    case 'money bills': {
      const o = await services.money.overview()
      const people = new Map(o.people.map((p) => [p.id, p.name]))
      return {
        ok: true,
        data: {
          currency: 'GBP',
          monthlyTotalPence: o.monthlyTotal,
          bills: o.bills.map((b) => ({
            name: b.name,
            amountPence: b.amount,
            cadence: b.cadence,
            nextDue: b.nextDue,
            status: b.status,
            source: b.source,
            lastPaid: b.lastPaid ?? null,
            trialEnding: b.trialEnding ?? null,
            ...(b.shares && {
              split: b.shares.map((s) => ({
                person: people.get(s.personId) ?? s.personId,
                amountPence: s.amount,
              })),
            }),
          })),
          toReview: o.review.map((d) => ({
            name: d.name,
            amountPence: d.amount,
            cadence: d.cadence,
            nextDue: d.nextDue,
            source: d.source,
          })),
        },
      }
    }

    case 'money transactions': {
      const t = await services.money.transactions({ month: command.month, account: command.account })
      // Newest first, like the app.
      const all = [...t.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      const p = page(all, command.limit, offset)
      return {
        ok: true,
        data: {
          currency: 'GBP',
          month: command.month ?? null,
          account: command.account ?? null,
          accounts: t.accounts,
          summary: { moneyInPence: t.summary.moneyIn, moneyOutPence: t.summary.moneyOut },
          total: p.total,
          offset: p.offset,
          shown: p.shown,
          transactions: p.items.map((x) => ({
            date: x.date,
            account: x.accountName,
            description: x.description,
            merchant: x.merchant ?? null,
            category: x.category ?? null,
            // Who chose the category when it wasn't the bank or the rules.
            ...(x.categorisedBy === 'ai' && { categorisedBy: 'ai', confidence: x.confidence ?? null }),
            ...(x.categorisedBy === 'you' && { categorisedBy: 'you' }),
            amountPence: x.amount,
          })),
        },
      }
    }

    case 'money balances': {
      const o = await services.money.overview()
      const people = new Map(o.people.map((p) => [p.id, p.name]))
      return {
        ok: true,
        data: {
          currency: 'GBP',
          people: o.people.map((p) => p.name),
          debts: o.debts.map((d) => ({
            from: people.get(d.from) ?? d.from,
            to: people.get(d.to) ?? d.to,
            amountPence: d.amount,
          })),
        },
      }
    }

    case 'money import': {
      const r = await services.money.importFile(command.file, command.account)
      if (!r.ok) return fromService(r)
      return { ok: true, data: { account: r.accountName, added: r.added, duplicates: r.duplicates } }
    }

    case 'money sort': {
      const r = await services.money.aiSort(options.progress?.money)
      if (!r.ok) return fromService({ error: r.error, message: r.message })
      return {
        ok: true,
        data: {
          merchants: r.merchants,
          checked: r.checked,
          changed: r.changed,
          cached: r.cached,
          failed: r.failed,
          billPairs: r.billPairs,
          billsMatched: r.billsMatched,
          errors: r.errors,
        },
      }
    }

    case 'ai status': {
      const providers = await services.ai.status()
      return {
        ok: true,
        data: {
          settings: services.ai.settings(),
          providers: providers.map((p) => ({
            id: p.id,
            label: p.label,
            kind: p.kind,
            available: p.available,
            detail: p.detail,
            models: p.models.length,
            recommended: p.recommended,
          })),
        },
      }
    }

    case 'ai sort': {
      if (!connected()) return NOT_CONNECTED
      const r = await services.ai.sort(options.progress?.ai)
      if (!r.ok) return fromService({ error: r.error, message: r.message })
      return {
        ok: true,
        data: {
          checked: r.checked,
          changed: r.changed,
          cached: r.cached,
          failed: r.failed,
          errors: r.errors,
        },
      }
    }
  }
}
