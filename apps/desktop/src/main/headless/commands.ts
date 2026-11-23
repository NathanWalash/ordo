import type {
  AccountStatus,
  BoardSummary,
  BoardsResult,
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
  AnswerInput,
  CompareInput,
  ImportOutcome,
  ComposeInput,
  LastMove,
  MemoryResult,
  MemoryView,
  MailboxInfo,
  MailMoveInput,
  MailOutcome,
  MailRefreshProgress,
  MessageContent,
  MessageListQuery,
  MessageSummary,
  MoneyAiOutcome,
  MonthComparison,
  MoneyAiProgress,
  MoneyOverview,
  ScanOutcome,
  ScanProgress,
  SearchQueryInput,
  ServerSearchInput,
  SetFlagsInput,
  TransactionPage,
  TransactionQuery,
  UndoOutcome,
} from '@ordo/shared'
import { bodyText, type CleanupPlan, type PlannedSender } from '@ordo/mail-core'
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
  /**
   * The mail client. Headless mode and MCP can read, and with --allow-changes plus confirm, move,
   * flag, mark and save drafts. They can never send: `send` exists only in the app's assistant.
   */
  mail: {
    mailboxes(): MailboxInfo[]
    refresh(
      input: { mailbox: string },
      onProgress?: (p: MailRefreshProgress) => void,
    ): Promise<MailOutcome<{ added: number; removed: number; changed: number }>>
    messages(query: MessageListQuery): { total: number; messages: MessageSummary[] }
    search(query: SearchQueryInput): MessageSummary[]
    searchServer(query: ServerSearchInput): Promise<MailOutcome<{ messages: MessageSummary[] }>>
    open(ref: { mailbox: string; uid: number }): Promise<MailOutcome<{ message: MessageContent }>>
    /** One message's headers from the cache, or null. No network. */
    cached(ref: { mailbox: string; uid: number }): MessageSummary | null
    setFlags(input: SetFlagsInput): Promise<MailOutcome>
    move(input: MailMoveInput): Promise<MailOutcome<{ moved: number; undoId: number | null }>>
    /** The newest move that can still be undone in this process, or null. */
    lastMove(): LastMove | null
    undoMove(undoId: number): Promise<MailOutcome<{ restored: number }>>
    saveDraft(
      input: ComposeInput,
    ): Promise<MailOutcome<{ draft: { mailbox: string; uid: number } | null; attachments: unknown[] }>>
    /** Only in the app's assistant, after the user confirmed the card. Never in headless or MCP. */
    send?(input: ComposeInput): Promise<MailOutcome<{ warning?: string }>>
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
    /** What Ordo has learned: facts, questions, loose ends, events. */
    memory(): Promise<MemoryView>
    answer(input: AnswerInput): Promise<MemoryResult>
    forget(id: string): Promise<MemoryResult>
    compare(input: CompareInput): Promise<MonthComparison>
  }
  ai: {
    settings(): AiSettings
    status(): Promise<AiProviderStatus[]>
    sort(onProgress?: (p: AiSortProgress) => void): Promise<AiSortOutcome>
  }
  boards: {
    list(): BoardSummary[]
    /** Cards by board, column and label names (or ids). */
    cards(query: {
      board?: string
      column?: string
      labels?: string[]
      archived?: boolean
    }): BoardsResult<BoardCardRow[]>
    addCard(input: {
      board: string
      column?: string
      title: string
      notes?: string
      start?: string
      due?: string
      labels?: string[]
    }): Promise<BoardsResult<BoardCardRow>>
    /** `position` 1 is the top of the column; without it the card goes to the end. */
    moveCard(input: {
      card: string
      board?: string
      column?: string
      position?: number
    }): Promise<BoardsResult<BoardCardRow>>
    /**
     * Look names up without changing anything, for a change's preview: the board, the column (or the
     * card's own column), the card and labels, as Ordo has them.
     */
    resolve(query: { board?: string; column?: string; card?: string; labels?: string[] }): BoardsResult<{
      board: string
      column: string | null
      card: BoardCardRow | null
      labels: string[]
    }>
  }
  /** Who holds the write lock right now, if anyone. */
  lockHolder(): LockHolder | null
}

/** A card as headless mode shows it: board, column, label and field names rather than ids. */
export interface BoardCardRow {
  id: string
  title: string
  board: string | null
  column: string | null
  start: string | null
  due: string | null
  labels: string[]
  checklist: { done: number; total: number }
  links: number
  fields: Record<string, string>
  archived: boolean
}

/** Progress for long-running commands; the CLI prints it to stderr. */
export interface Progress {
  scan?: (p: ScanProgress) => void
  mail?: (p: MailRefreshProgress) => void
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
  fail(
    r.error === 'not-found' || r.error === 'limit'
      ? 'invalid'
      : r.error && KNOWN_CODES.has(r.error)
        ? (r.error as ErrorCode)
        : 'failed',
    r.message,
  )

/** A mail read that didn't work: a message or folder that's gone is `not_found`. */
const fromMail = (r: { error?: string; message: string }): CommandResult =>
  r.error === 'not-found' ? fail('not_found', r.message) : fromService(r)

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

export type EventFlags = {
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
    if (repeat.custom && !f.repeat)
      return 'This event repeats in a way Ordo can’t edit from here. Give --repeat to replace its rule, or change it in Calendar.'
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
export function pickCalendar(
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
export function pickEvent(
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
const NO_CALENDARS = fail(
  'not_connected',
  'No calendars are connected. Open Ordo and connect iCloud or a Google account, or add a calendar by link.',
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

/** Characters of a message's text `mail read` returns. */
const MAIL_TEXT_MAX = 100_000

const address = (a: { address: string; name?: string }) => ({ address: a.address, name: a.name ?? null })

export function messageRow(m: MessageSummary) {
  return {
    mailbox: m.mailbox,
    uid: m.uid,
    date: iso(m.date),
    from: address(m.from),
    to: m.to.map(address),
    subject: m.subject,
    unread: !m.seen,
    flagged: m.flagged,
    answered: m.answered,
    attachments: m.hasAttachments,
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

// ---- Mail changes ------------------------------------------------------------------------------

type MoveTo = 'archive' | 'trash' | 'inbox' | 'junk' | { folder: string }

/** Words for the special folders, as people say them. */
const ROLE_WORDS: Record<string, 'archive' | 'trash' | 'inbox' | 'junk'> = {
  archive: 'archive',
  bin: 'trash',
  trash: 'trash',
  deleted: 'trash',
  junk: 'junk',
  spam: 'junk',
  inbox: 'inbox',
}
const ROLE_NAMES = { archive: 'Archive', trash: 'Bin', inbox: 'Inbox', junk: 'Junk' } as const

/**
 * Where a move goes: Archive, Bin, Junk or Inbox by name, or one of the folders the server listed
 * (by path, or by name when only one folder has it). Never Drafts. The mail client checks again.
 */
export function moveTarget(
  services: OrdoServices,
  to: string,
): { ok: true; to: MoveTo; path: string; name: string } | { ok: false; code: ErrorCode; message: string } {
  const boxes = services.mail.mailboxes()
  const word = ROLE_WORDS[to.trim().toLowerCase()]
  if (word) {
    const path = word === 'inbox' ? 'INBOX' : boxes.find((b) => b.role === word)?.path
    if (!path)
      return { ok: false, code: 'unavailable', message: `This account has no ${ROLE_NAMES[word]} mailbox.` }
    return { ok: true, to: word, path, name: ROLE_NAMES[word] }
  }
  const lower = to.toLowerCase()
  const byName = boxes.filter((b) => b.name.toLowerCase() === lower || b.path.toLowerCase() === lower)
  const box = boxes.find((b) => b.path === to) ?? (byName.length === 1 ? byName[0] : undefined)
  if (!box)
    return {
      ok: false,
      code: 'not_found',
      message: `There’s no folder called “${to.slice(0, 80)}”. Use archive, bin, junk, inbox or a folder from \`mail mailboxes\`.`,
    }
  if (box.role === 'drafts')
    return { ok: false, code: 'invalid', message: 'Messages can’t be moved into Drafts.' }
  const role = box.role && box.role in ROLE_NAMES ? (box.role as keyof typeof ROLE_NAMES) : null
  return { ok: true, to: { folder: box.path }, path: box.path, name: role ? ROLE_NAMES[role] : box.name }
}

/**
 * The messages a change acts on, from Ordo's cache. A change only touches messages Ordo has seen,
 * so what a preview shows is what changes.
 */
export function cachedMessages(
  services: OrdoServices,
  mailbox: string,
  uids: readonly number[],
): { ok: true; messages: MessageSummary[] } | { ok: false; code: ErrorCode; message: string } {
  const messages: MessageSummary[] = []
  for (const uid of uids) {
    const m = services.mail.cached({ mailbox, uid })
    if (!m)
      return {
        ok: false,
        code: 'not_found',
        message: `Ordo doesn’t have message ${uid} in ${mailbox.slice(0, 80)}. Check for new mail, then use a uid from the message list.`,
      }
    messages.push(m)
  }
  return { ok: true, messages }
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
  // Google calendars and ones added by link or file work without an iCloud account.
  const hasCalendars = () => {
    const s = services.calendar.status()
    return connected() || s.subscriptions > 0 || (s.google ?? 0) > 0
  }
  const needsIcloud = (calendarId: string) => {
    const cal = services.calendar.calendars().find((c) => c.id === calendarId)
    return (cal?.source ?? 'icloud') === 'icloud' && !connected()
  }

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
            calendar.connected || calendar.subscriptions > 0 || (calendar.google ?? 0) > 0
              ? {
                  connected: calendar.connected,
                  lastSync: calendar.lastSync,
                  calendars: services.calendar.calendars().length,
                  subscriptions: calendar.subscriptions,
                  ...(calendar.google ? { googleAccounts: calendar.google } : {}),
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

    case 'mail mailboxes': {
      if (!connected()) return NOT_CONNECTED
      const boxes = services.mail.mailboxes()
      return {
        ok: true,
        data: {
          mailboxes: boxes.map((m) => ({
            path: m.path,
            name: m.name,
            role: m.role,
            messages: m.total,
            unread: m.unread,
          })),
        },
      }
    }

    case 'mail sync': {
      if (!connected()) return NOT_CONNECTED
      const r = await services.mail.refresh({ mailbox: command.mailbox }, options.progress?.mail)
      if (!r.ok) return fromMail(r)
      return {
        ok: true,
        data: { mailbox: command.mailbox, added: r.added, removed: r.removed, changed: r.changed },
      }
    }

    case 'mail list': {
      if (!connected()) return NOT_CONNECTED
      const r = services.mail.messages({
        mailbox: command.mailbox,
        limit: command.limit,
        offset,
        unread: command.unread || undefined,
      })
      return {
        ok: true,
        data: {
          mailbox: command.mailbox,
          total: r.total,
          offset,
          shown: r.messages.length,
          messages: r.messages.map(messageRow),
        },
      }
    }

    case 'mail search': {
      if (!connected()) return NOT_CONNECTED
      if (command.server) {
        const mailbox = command.mailbox ?? 'INBOX'
        const r = await services.mail.searchServer({ query: command.query, mailbox, limit: command.limit })
        if (!r.ok) return fromMail(r)
        return {
          ok: true,
          data: { query: command.query, where: 'server', mailbox, messages: r.messages.map(messageRow) },
        }
      }
      const found = services.mail.search({
        query: command.query,
        mailbox: command.mailbox,
        limit: command.limit,
      })
      return {
        ok: true,
        data: {
          query: command.query,
          where: 'cache',
          mailbox: command.mailbox ?? null,
          messages: found.map(messageRow),
        },
      }
    }

    case 'mail read': {
      if (!connected()) return NOT_CONNECTED
      const r = await services.mail.open({ mailbox: command.mailbox, uid: command.uid })
      if (!r.ok) return fromMail(r)
      const m = r.message
      const text = bodyText(m, { links: true })
      return {
        ok: true,
        data: {
          mailbox: m.mailbox,
          uid: m.uid,
          date: iso(m.date),
          from: m.from ? address(m.from) : null,
          to: m.to.map(address),
          cc: m.cc.map(address),
          replyTo: m.replyTo.map(address),
          subject: m.subject,
          messageId: m.messageId,
          unread: !m.seen,
          flagged: m.flagged,
          // The plain-text body, or the HTML as text with link addresses: never HTML.
          text: text.slice(0, MAIL_TEXT_MAX),
          truncated: m.truncated || text.length > MAIL_TEXT_MAX,
          attachments: m.attachments
            .filter((a) => !a.inline)
            .map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
        },
      }
    }

    case 'mail move': {
      if (!connected()) return NOT_CONNECTED
      const target = moveTarget(services, command.to)
      if (!target.ok) return fail(target.code, target.message)
      const found = cachedMessages(services, command.mailbox, command.uids)
      if (!found.ok) return fail(found.code, found.message)
      const r = await services.mail.move({ mailbox: command.mailbox, uids: command.uids, to: target.to })
      if (!r.ok) return fromMail(r)
      return {
        ok: true,
        data: { mailbox: command.mailbox, to: target.path, moved: r.moved, undoId: r.undoId },
      }
    }

    case 'mail flag':
    case 'mail mark': {
      if (!connected()) return NOT_CONNECTED
      const found = cachedMessages(services, command.mailbox, command.uids)
      if (!found.ok) return fail(found.code, found.message)
      const flags = command.name === 'mail flag' ? { flagged: !command.unflag } : { seen: command.read }
      const r = await services.mail.setFlags({ mailbox: command.mailbox, uids: command.uids, ...flags })
      if (!r.ok) return fromMail(r)
      return {
        ok: true,
        data: {
          mailbox: command.mailbox,
          uids: command.uids,
          ...(command.name === 'mail flag' ? { flagged: !command.unflag } : { read: command.read }),
        },
      }
    }

    case 'mail undo': {
      if (!connected()) return NOT_CONNECTED
      const last = services.mail.lastMove()
      const id = command.id ?? last?.undoId
      if (id === undefined)
        return fail(
          'not_found',
          'There’s no move to undo. A move can only be undone in the Ordo session that made it.',
        )
      const r = await services.mail.undoMove(id)
      if (!r.ok) return fromMail(r)
      return { ok: true, data: { undoId: id, restored: r.restored } }
    }

    case 'calendar sync': {
      if (!hasCalendars()) return NO_CALENDARS
      const r = await services.calendar.sync(options.progress?.calendar)
      if (!r.ok) return fromMail(r)
      const { ok: _ok, ...rest } = r
      return { ok: true, data: rest }
    }

    case 'calendar events': {
      if (!hasCalendars()) return NO_CALENDARS
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
            // For `calendar edit` and `calendar delete`.
            uid: e.uid,
            occurrence: e.recurrenceId ?? null,
          })),
        },
      }
    }

    case 'calendar list': {
      if (!hasCalendars()) return NO_CALENDARS
      return {
        ok: true,
        data: {
          calendars: services.calendar.calendars().map((c) => ({
            id: c.id,
            name: c.name,
            source: c.source ?? 'icloud',
            ...(c.account && { account: c.account }),
            readOnly: c.readOnly,
            visible: c.visible,
          })),
        },
      }
    }

    case 'calendar add': {
      if (!hasCalendars()) return NO_CALENDARS
      const picked = pickCalendar(services, command.calendar)
      if (!picked.ok) return picked.result
      // An iCloud calendar needs the iCloud account; a Google calendar's account is checked as it's changed.
      if (needsIcloud(picked.calendar.id)) return NOT_CONNECTED
      if (picked.calendar.readOnly)
        return fail('read_only', `“${picked.calendar.name}” is read-only, so events can’t be added to it.`)
      const draft = draftFromFlags(null, command, localZone())
      if (typeof draft === 'string') return fail('usage', draft)
      const r = await services.calendar.createEvent({ calendarId: picked.calendar.id, draft })
      if (!r.ok) return fromChange(r)
      return { ok: true, data: { uid: r.uid, calendar: picked.calendar.name, event: eventView(draft) } }
    }

    case 'calendar edit': {
      if (!hasCalendars()) return NO_CALENDARS
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
      if (needsIcloud(picked.ref.calendarId)) return NOT_CONNECTED
      const draft = draftFromFlags(picked.details.draft, command, localZone())
      if (typeof draft === 'string') return fail('usage', draft)
      const r = await services.calendar.updateEvent({ ref: picked.ref, draft, scope: picked.scope })
      if (!r.ok) return fromChange(r)
      return { ok: true, data: { uid: r.uid, scope: picked.scope, event: eventView(draft) } }
    }

    case 'calendar delete': {
      if (!hasCalendars()) return NO_CALENDARS
      const picked = pickEvent(services, command)
      if (!picked.ok) return picked.result
      if (needsIcloud(picked.ref.calendarId)) return NOT_CONNECTED
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

    case 'money knows': {
      const m = await services.money.memory()
      return {
        ok: true,
        data: {
          facts: m.facts.map((f) => ({
            id: f.id,
            kind: f.kind,
            summary: f.summary,
            source: f.source,
            learned: f.createdAt,
          })),
          accounts: m.caveats.map((c) => ({ account: c.account, dates: c.dates, note: c.text })),
        },
      }
    }

    case 'money questions': {
      const m = await services.money.memory()
      return {
        ok: true,
        data: {
          questions: m.questions.map((q) => ({
            id: q.id,
            kind: q.kind,
            text: q.text,
            confidence: q.confidence ?? null,
            answers: q.answers,
          })),
        },
      }
    }

    case 'money loose-ends': {
      const m = await services.money.memory()
      return {
        ok: true,
        data: {
          currency: 'GBP',
          held: m.held.map((h) => ({
            from: h.from,
            for: h.forPerson,
            what: h.what || null,
            receivedPence: h.received,
            passedOnPence: h.passedOn,
            holdingPence: h.holding,
            lastIn: h.lastIn ?? null,
            lastOut: h.lastOut ?? null,
          })),
          owed: [
            ...m.owed.map((o) => ({
              person: o.person,
              amountPence: o.amount,
              outstandingPence: o.outstanding,
              note: o.note || null,
              from: 'you told Ordo',
            })),
            ...m.billsOwed.map((o) => ({
              person: o.person,
              amountPence: o.amount,
              outstandingPence: o.amount,
              note: null,
              from: 'shared bills',
            })),
          ],
        },
      }
    }

    case 'money events': {
      const m = await services.money.memory()
      return {
        ok: true,
        data: {
          currency: 'GBP',
          events: m.events.map((e) => ({
            id: e.id,
            name: e.name,
            from: e.from ?? null,
            to: e.to ?? null,
            paidOutPence: e.paidOut,
            paidBackPence: e.paidBack,
            netPence: e.net,
            byCategory: e.byCategory.map((c) => ({ category: c.category, amountPence: c.amount })),
          })),
        },
      }
    }

    case 'money compare': {
      const c = await services.money.compare({ category: command.category, account: command.account })
      const side = (p: MonthComparison['thisMonth']) => ({
        from: p.from,
        to: p.to,
        spentPence: p.spent,
        paidBackPence: p.paidBack,
        netPence: p.net,
      })
      return {
        ok: true,
        data: {
          currency: 'GBP',
          category: c.category,
          account: c.account,
          thisMonth: side(c.thisMonth),
          lastMonth: side(c.lastMonth),
          differencePence: c.difference,
          caveats: c.caveats,
        },
      }
    }

    case 'money answer': {
      const r = await services.money.answer({ questionId: command.question, answerId: command.answer })
      if (!r.ok) return fromService(r)
      return { ok: true, data: { question: command.question, answer: command.answer, saved: r.facts ?? 0 } }
    }

    case 'money forget': {
      const r = await services.money.forget(command.fact)
      if (!r.ok) return fromService(r)
      return { ok: true, data: { forgotten: command.fact } }
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

    case 'boards list':
      return {
        ok: true,
        data: {
          boards: services.boards
            .list()
            .map((b) => ({ id: b.id, name: b.name, cards: b.cards, overdue: b.overdue })),
        },
      }

    case 'boards cards': {
      const r = services.boards.cards({
        board: command.board,
        column: command.column,
        labels: command.label,
        archived: command.archived,
      })
      if (!r.ok) return fromService(r)
      const p = page(r.value, command.limit, offset)
      return {
        ok: true,
        data: {
          board: command.board ?? null,
          column: command.column ?? null,
          total: p.total,
          offset: p.offset,
          shown: p.shown,
          cards: p.items,
        },
      }
    }

    case 'boards add-card': {
      const r = await services.boards.addCard({
        board: command.board,
        column: command.column,
        title: command.title,
        notes: command.notes,
        start: command.start,
        due: command.due,
        labels: command.label,
      })
      return r.ok ? { ok: true, data: { card: r.value } } : fromService(r)
    }

    case 'boards move-card': {
      const r = await services.boards.moveCard({
        card: command.card,
        board: command.board,
        column: command.column,
        position: command.position,
      })
      return r.ok ? { ok: true, data: { card: r.value } } : fromService(r)
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
