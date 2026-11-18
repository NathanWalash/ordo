import type {
  AccountStatus,
  AiProviderStatus,
  AiSettings,
  AiSortOutcome,
  AiSortProgress,
  CalendarEvent,
  CalendarListItem,
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
const pad = (n: number) => String(n).padStart(2, '0')
/**
 * The calendar day of an all-day event. They're stored at local midnight, so in UTC (and in
 * `toISOString`) one in London in summer starts at 23:00 the day before.
 */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

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
        data: {
          category: command.category ?? null,
          total: p.total,
          offset: p.offset,
          shown: p.shown,
          senders: p.items.map(senderRow),
        },
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
            // All-day events give dates (the end is the day after, as in iCalendar); timed ones instants.
            start: e.allDay ? localDay(e.start) : iso(e.start),
            end: e.allDay ? localDay(e.end) : iso(e.end),
            allDay: e.allDay,
            calendar: names.get(e.calendarId) ?? null,
            location: e.location ?? null,
          })),
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
