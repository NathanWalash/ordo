import { z } from 'zod'
import { CHANGE_COMMANDS, commandFrom, MAX_EVENT_DAYS, UsageError, type CommandName } from './args'
import {
  draftFromFlags,
  gate,
  pickCalendar,
  pickEvent,
  runCommand,
  type CommandResult,
  type EventFlags,
  type OrdoServices,
} from './commands'
import { checkDraft, localZone, type EventDraft } from '@ordo/calendar-core'
import { clean } from './format'
import { pathProblem } from '../paths'

/**
 * Ordo's tool registry: every tool an agent can call, in one list. The MCP server (`mcp.ts`) and
 * the in-app assistant (`../assistant`) both read it, and both run tools through `runTool`, so a
 * tool added here appears in both with the same checks. See docs/assistant.md, "Adding a tool".
 *
 * Kinds:
 * - `read` changes nothing.
 * - `refresh` fetches into Ordo's local cache (scan, calendar sync) and changes nothing on a server.
 * - `change` changes the user's mailbox or data. It runs only when the caller allows changes and the
 *   user confirmed: `--allow-changes` plus `confirm: true` in MCP, the confirmation card in the app.
 */
export type ToolKind = 'read' | 'refresh' | 'change'

/** One line of a preview; `title` holds the full text when `text` is shortened. */
export type PreviewDetail = string | { text: string; title: string }

/**
 * Exactly what a change tool would do, for the assistant's confirmation card. Ordo builds it from
 * its own data (a dry-run plan, the history), never from the model's words.
 */
export interface ChangePreview {
  /** One line, e.g. "Import a bank statement". */
  title: string
  /** One fact per line. */
  details: PreviewDetail[]
  /** What to know before confirming, e.g. what can't be undone. */
  notes: string[]
  /** Set when the change can't go ahead as asked; the card then only offers Cancel. */
  blocked?: string
}

export interface RunContext {
  /** The front end allows changes at all (`--allow-changes`; always true in the app's assistant). */
  allowChanges: boolean
  /** The user confirmed this call. */
  confirm: boolean
}

export interface OrdoTool<S extends z.ZodRawShape = z.ZodRawShape> {
  /** Stable name, used by MCP clients and models: `ordo_<noun>`. */
  name: string
  kind: ToolKind
  /** What the assistant shows while the tool runs, e.g. "Reading your bills". */
  label: string
  /** What it shows when it's done, from the result's numbers only, e.g. "Read 2 bills". */
  done(data: unknown): string
  /** For the model: what it does and when to use it. No front-end specifics. */
  description: string
  /** Results carry text from emails, statements or calendars. */
  untrusted: boolean
  /** For untrusted tools: what the assistant read, as the card names it ("your transactions"). */
  reads?: string
  /** Arguments, as a zod shape (MCP turns it into JSON Schema; the assistant validates strictly). */
  input: S
  /** The headless command behind it, if any. Change gate messages use its name. */
  command?: CommandName
  /**
   * Change tools: an explicit phrase in the user's own message that asks for this kind of change.
   * Without it, the confirmation card warns that the request may have come from data.
   */
  intent?: RegExp
  /**
   * Change tools: the values the user must have written themselves (sender addresses, a clean-up
   * id) for the card to say "You asked for this".
   */
  named?(args: z.output<z.ZodObject<S>>): string[]
  /**
   * Arguments that name a file on this computer. They must be absolute local paths (never UNC or
   * device paths), the assistant accepts them only when the user typed them, and previews must not
   * touch them: the file is read only after the user confirms.
   */
  localPaths?: readonly (keyof S & string)[]
  /** The assistant must have run this tool, with the same arguments, earlier in the question. */
  after?: string
  /** Shown when the preview changed between the card and Confirm. */
  staleMessage?: string
  /** Run it. Only ever call this through `runTool`, which validates and gates. */
  run(services: OrdoServices, args: z.output<z.ZodObject<S>>, ctx: RunContext): Promise<CommandResult>
  /** Change tools: what would happen, without doing it, and without touching any `localPaths`. */
  preview?(services: OrdoServices, args: z.output<z.ZodObject<S>>): Promise<ChangePreview>
}

/** Keep each tool's argument types while storing them in one list. */
function tool<S extends z.ZodRawShape>(t: OrdoTool<S>): OrdoTool {
  return t as unknown as OrdoTool
}

/**
 * Run a tool through a headless command, with the CLI's validation. The command's own gate
 * applies too, so a change can't slip through even if `runTool` were bypassed.
 */
function viaCommand<A>(
  name: CommandName,
  map: (args: A) => { input: Record<string, unknown>; offset?: number },
) {
  return async (services: OrdoServices, args: A, ctx: RunContext): Promise<CommandResult> => {
    const { input, offset } = map(args)
    const command = commandFrom(name, CHANGE_COMMANDS.has(name) ? { ...input, confirm: ctx.confirm } : input)
    return runCommand(services, command, { allowChanges: ctx.allowChanges, offset })
  }
}

// Shared argument shapes.

const limit = (fallback: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(fallback)
    .describe(`How many to return (default ${fallback}, max ${max})`)
const offset = z.number().int().min(0).max(1_000_000).default(0).describe('How many to skip, for paging')
const senderList = z
  .array(z.string().min(3).max(320))
  .min(1)
  .max(100)
  .describe('Sender email addresses, as listed by ordo_senders')
const category = z
  .enum(['promotions', 'newsletters', 'notifications', 'receipts', 'people', 'uncategorised'])
  .optional()
  .describe('Only senders in this category ("uncategorised" is Other in the app)')

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

/** A number from a result, or 0. Done labels only ever use numbers, never result text. */
function num(data: unknown, ...path: string[]): number {
  let v: unknown = data
  for (const key of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined
  if (Array.isArray(v)) return v.length
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function cleanupArgs(a: { senders: string[]; unsubscribe: boolean; trash: boolean }) {
  return { sender: a.senders, 'no-unsubscribe': !a.unsubscribe, 'no-trash': !a.trash }
}

/** A sender on a card: the address first, so a long display name can't hide it. */
export function senderLine(address: string, name?: string | null): string {
  const n = clean(name ?? '', 60).trim()
  return n ? `${address} (“${n}”)` : address
}

/** The host of a URL, or null. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

/** Who answers an AI sort, as the card says it. */
function modelLine(services: OrdoServices, what: string): { line: string; blocked?: string } {
  const ai = services.ai.settings()
  if (ai.provider === 'none') return { line: '', blocked: 'Choose a model in Settings → AI first.' }
  const model = ai.model?.split('/').at(-1) ?? 'the model you chose'
  if (ai.provider === 'claude-cli' || ai.provider === 'codex-cli') {
    const vendor = ai.provider === 'claude-cli' ? 'Anthropic' : 'OpenAI'
    return {
      line: `Ordo asks ${model} at ${vendor}, under your account, to pick a category for each ${what} in Other.`,
    }
  }
  return { line: `Ordo asks ${model} on this computer to pick a category for each ${what} in Other.` }
}

/** "/Users/me/Downloads/monzo.csv" → { file: "monzo.csv", folder: "/Users/me/Downloads", short: "…/me/Downloads" }. */
function splitPath(path: string) {
  const parts = path.split(/[\\/]/)
  const file = parts.pop() ?? path
  const folder = path.slice(0, Math.max(0, path.length - file.length - 1)) || path.slice(0, 1)
  const kept = parts.filter(Boolean)
  const short = kept.length > 2 ? `…/${kept.slice(-2).join('/')}` : folder
  return { file, folder, short }
}

// ---- Calendar events -------------------------------------------------------------------------

const when = 'A day YYYY-MM-DD (all-day event) or a local time YYYY-MM-DDTHH:MM in timeZone'
const eventFields = {
  title: z.string().max(500).optional().describe('Title'),
  start: z.string().max(16).optional().describe(`Start: ${when}`),
  end: z
    .string()
    .max(16)
    .optional()
    .describe('End, in the same form as start (all-day: the last day). Default: an hour, or one day'),
  timeZone: z
    .string()
    .max(64)
    .optional()
    .describe('IANA zone such as Europe/London (default: this computer’s)'),
  location: z.string().max(1000).optional(),
  notes: z.string().max(10_000).optional(),
  until: z.string().max(10).optional().describe('Last day a repeat can happen, YYYY-MM-DD'),
  count: z.number().int().min(1).max(1000).optional().describe('Or how many times it happens in all'),
  alert: z
    .number()
    .int()
    .min(-10_080)
    .max(40_320)
    .nullable()
    .optional()
    .describe('Alert this many minutes before the start; null for none'),
}
type EventArgs = {
  title?: string
  start?: string
  end?: string
  timeZone?: string
  location?: string
  notes?: string
  until?: string
  count?: number
  alert?: number | null
  repeat?: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'none'
}
/** The tool's arguments as the CLI's flags. */
const eventFlags = (a: EventArgs) => ({
  title: a.title,
  start: a.start,
  end: a.end,
  'time-zone': a.timeZone,
  location: a.location,
  notes: a.notes,
  until: a.until,
  count: a.count,
  alert: a.alert === null ? 'none' : a.alert,
  repeat: a.repeat,
})
const whichEvent = {
  uid: z.string().min(1).max(1024).describe('The event’s uid, from ordo_calendar_events'),
  occurrence: z
    .string()
    .max(40)
    .optional()
    .describe('For one occurrence of a repeating event: its occurrence id, from ordo_calendar_events'),
  all: z.boolean().default(false).describe('For a repeating event: change every occurrence'),
  calendar: z.string().max(2048).optional().describe('Calendar name or id, if the uid is in more than one'),
}
type WhichArgs = { uid: string; occurrence?: string; all: boolean; calendar?: string }

/** "Friday 20 November 2026, 09:00 – 10:00 (London time)", from a draft's own fields. */
function whenLine(d: EventDraft): string {
  const day = (s: string) => {
    const [y, m, dd] = s.slice(0, 10).split('-').map(Number) as [number, number, number]
    return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-GB', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
  }
  if (d.allDay)
    return d.start === d.end ? `${day(d.start)}, all day` : `${day(d.start)} to ${day(d.end)}, all day`
  const time = (s: string) => s.slice(11, 16)
  const zone = d.timeZone ? ` (${clean(d.timeZone.split('/').pop()!.replace(/_/g, ' '), 40)} time)` : ''
  return d.start.slice(0, 10) === d.end.slice(0, 10)
    ? `${day(d.start)}, ${time(d.start)} – ${time(d.end)}${zone}`
    : `${day(d.start)} ${time(d.start)} to ${day(d.end)} ${time(d.end)}${zone}`
}

const repeatLine = (d: EventDraft) =>
  !d.repeat
    ? 'Doesn’t repeat'
    : d.repeat.custom
      ? 'Repeats as set in another app'
      : `Repeats ${d.repeat.frequency}${d.repeat.until ? ` until ${d.repeat.until}` : d.repeat.count ? `, ${plural(d.repeat.count, 'time')}` : ''}`
const alertLine = (d: EventDraft) => (d.alert === null ? 'No alert' : `Alert ${d.alert} minutes before`)

const PERMANENT = 'This deletes it from iCloud and all your devices. You can’t undo this.'
const blockedCard = (title: string, blocked: string): ChangePreview => ({
  title,
  details: [],
  notes: [],
  blocked,
})
const failure = (r: CommandResult) => (r.ok ? 'Ordo couldn’t work out what this would change.' : r.message)
const NO_ICLOUD = 'No iCloud account is connected. Connect one in Mail first.'

export const TOOLS: readonly OrdoTool[] = [
  tool({
    name: 'ordo_status',
    kind: 'read',
    label: 'Checking Ordo',
    done: () => 'Checked Ordo',
    command: 'status',
    description:
      'Ordo’s state: whether an iCloud account is connected (its email only, never the password), ' +
      'last scan, the AI provider, counts, and whether another Ordo process is busy writing.',
    untrusted: false,
    reads: 'Ordo’s status',
    input: {},
    run: viaCommand('status', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_senders',
    kind: 'read',
    label: 'Reading your senders',
    done: (d) => `Read ${plural(num(d, 'total'), 'sender')}`,
    command: 'senders',
    description:
      'Senders in the cached inbox, most emails first, with category and unsubscribe method. ' +
      'protected: true marks people the user has written to; Ordo never clears them. ' +
      'Run ordo_scan first to refresh.',
    untrusted: true,
    reads: 'your senders',
    input: { category, limit: limit(25, 200), offset },
    run: viaCommand('senders', (a: { category?: string; limit: number; offset: number }) => ({
      input: { category: a.category, limit: a.limit },
      offset: a.offset,
    })),
  }),

  tool({
    name: 'ordo_cleanup_plan',
    kind: 'read',
    label: 'Planning a clean-up',
    done: (d) => `Planned a clean-up of ${plural(num(d, 'summary', 'senders'), 'sender')}`,
    command: 'cleanup plan',
    description:
      'Dry run of a clean-up: exactly which emails Ordo would move to Trash and how it would unsubscribe, ' +
      'with the same checks as the app (people are refused, plain http links and unsubscribe emails to ' +
      'another domain need the app). Changes nothing.',
    untrusted: true,
    reads: 'a clean-up plan',
    input: {
      senders: senderList,
      unsubscribe: z.boolean().default(true).describe('Unsubscribe where the sender offers a way'),
      trash: z.boolean().default(true).describe('Move their cached inbox emails to Trash'),
    },
    run: viaCommand('cleanup plan', (a: { senders: string[]; unsubscribe: boolean; trash: boolean }) => ({
      input: cleanupArgs(a),
    })),
  }),

  tool({
    name: 'ordo_history',
    kind: 'read',
    label: 'Reading clean-up history',
    done: (d) => `Read ${plural(num(d, 'total'), 'clean-up')}`,
    command: 'history',
    description: 'Past clean-ups, newest first, with what was moved and whether it can be undone.',
    untrusted: true,
    reads: 'your clean-up history',
    input: { limit: limit(10, 50), offset },
    run: viaCommand('history', (a: { limit: number; offset: number }) => ({
      input: { limit: a.limit },
      offset: a.offset,
    })),
  }),

  tool({
    name: 'ordo_calendar_events',
    kind: 'read',
    label: 'Reading your calendar',
    done: (d) => `Read ${plural(num(d, 'total'), 'event')}`,
    command: 'calendar events',
    description:
      `Cached events from the user’s visible calendars between two days (inclusive, at most ${MAX_EVENT_DAYS} days). ` +
      'Run ordo_calendar_sync first to refresh.',
    untrusted: true,
    reads: 'your calendar',
    input: {
      from: z.string().describe('First day, YYYY-MM-DD'),
      to: z.string().describe('Last day, YYYY-MM-DD'),
      limit: limit(50, 200),
      offset,
    },
    run: viaCommand('calendar events', (a: { from: string; to: string; limit: number; offset: number }) => ({
      input: { from: a.from, to: a.to, limit: a.limit },
      offset: a.offset,
    })),
  }),

  tool({
    name: 'ordo_calendar_list',
    kind: 'read',
    label: 'Reading your calendars',
    done: (d) => `Read ${plural(num(d, 'calendars'), 'calendar')}`,
    command: 'calendar list',
    description:
      'The user’s calendars: id, name, where each comes from (iCloud, a link or a file) and whether it is ' +
      'read-only. Only writable iCloud calendars take new or changed events.',
    untrusted: true,
    reads: 'your calendars',
    input: {},
    run: viaCommand('calendar list', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_bills',
    kind: 'read',
    label: 'Reading your bills',
    done: (d) => `Read ${plural(num(d, 'bills'), 'bill')}`,
    command: 'money bills',
    description:
      'Bills and subscriptions from Ordo Money, with amounts in pence (GBP), cadence, next due date and splits.',
    untrusted: true,
    reads: 'your bills',
    input: {},
    run: viaCommand('money bills', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_transactions',
    kind: 'read',
    label: 'Reading transactions',
    done: (d) => `Read ${plural(num(d, 'total'), 'transaction')}`,
    command: 'money transactions',
    description: 'Bank transactions imported into Ordo Money, newest first, amounts in pence (GBP).',
    untrusted: true,
    reads: 'your transactions',
    input: {
      month: z.string().optional().describe('Only this month, YYYY-MM'),
      account: z.string().max(60).optional().describe('Only this account, by name'),
      limit: limit(50, 200),
      offset,
    },
    run: viaCommand(
      'money transactions',
      (a: { month?: string; account?: string; limit: number; offset: number }) => ({
        input: { month: a.month, account: a.account, limit: a.limit },
        offset: a.offset,
      }),
    ),
  }),

  tool({
    name: 'ordo_balances',
    kind: 'read',
    label: 'Reading balances',
    done: (d) => `Read ${plural(num(d, 'debts'), 'balance')}`,
    command: 'money balances',
    description: 'Who owes whom for shared bills, in pence (GBP).',
    untrusted: true,
    reads: 'your balances',
    input: {},
    run: viaCommand('money balances', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_scan',
    kind: 'refresh',
    label: 'Scanning your inbox',
    done: (d) => `Scanned your inbox: ${plural(num(d, 'added'), 'new email')}`,
    command: 'scan',
    description:
      'Fetch new inbox headers from iCloud into Ordo’s local cache. Reads headers only; changes nothing in the mailbox. ' +
      'Fails with code "locked" if the Ordo app or another agent is writing.',
    untrusted: false,
    input: {},
    run: viaCommand('scan', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_calendar_sync',
    kind: 'refresh',
    label: 'Syncing calendars',
    done: () => 'Synced your calendars',
    command: 'calendar sync',
    description:
      'Fetch changed calendars into Ordo’s local cache. Changes nothing on the server. ' +
      'Fails with code "locked" if the Ordo app or another agent is writing.',
    untrusted: false,
    input: {},
    run: viaCommand('calendar sync', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_cleanup_run',
    kind: 'change',
    label: 'Clearing senders',
    done: (d) => `Cleared ${plural(num(d, 'cleanup', 'senders'), 'sender')}`,
    command: 'cleanup run',
    intent:
      /\b(?:unsubscribe (?:me )?from|clean (?:up|out)|clear (?:out|up|away)|(?:move|send|put) .{0,80}\bto (?:the )?trash|trash (?:them|those|these|it|all)|get rid of)\b/i,
    named: (a: { senders: string[] }) => a.senders,
    after: 'ordo_cleanup_plan',
    staleMessage: 'Your mail changed since this was shown. Ask again.',
    description:
      'Unsubscribe from the given senders and move their cached inbox emails to Trash (nothing is deleted; ' +
      'ordo_undo puts them back). Call ordo_cleanup_plan with the same arguments first and show the user the ' +
      'plan. People are refused.',
    untrusted: true,
    reads: 'a clean-up',
    input: {
      senders: senderList,
      unsubscribe: z.boolean().default(true),
      trash: z.boolean().default(true),
    },
    run: viaCommand('cleanup run', (a: { senders: string[]; unsubscribe: boolean; trash: boolean }) => ({
      input: cleanupArgs(a),
    })),
    async preview(services, a) {
      if (!services.account().connected)
        return {
          title: 'Clear senders',
          details: [],
          notes: [],
          blocked: 'No iCloud account is connected. Connect one in Mail first.',
        }
      const r = services.cleanup.plan({
        senders: a.senders.map((address) => ({ address, unsubscribe: a.unsubscribe, trash: a.trash })),
      })
      if (!r.ok) return { title: 'Clear senders', details: [], notes: [], blocked: r.message }
      const { senders, rejected } = r.plan
      const emails = senders.filter((s) => s.trash).reduce((n, s) => n + s.count, 0)
      const unsubs = senders.filter((s) => s.unsubscribe).length
      const parts = [
        emails > 0 && `move ${plural(emails, 'email')} to Trash`,
        unsubs > 0 && `unsubscribe from ${plural(unsubs, 'sender')}`,
      ].filter(Boolean)
      const how = (s: (typeof senders)[number]) => {
        const m = s.unsubscribe
        if (!m) return null
        if (m.kind === 'one-click') {
          const host = hostOf(m.url)
          return `unsubscribe in one click${host ? ` at ${host}` : ''}`
        }
        if (m.kind === 'link') {
          const host = hostOf(m.url)
          return `open the unsubscribe page${host ? ` at ${host}` : ''} in your browser`
        }
        return `send an unsubscribe email to ${s.mailto?.to ?? 'the sender'}`
      }
      return {
        title: parts.length ? parts.join(' and ').replace(/^./, (c) => c.toUpperCase()) : 'Nothing to clear',
        details: senders.map((s) =>
          [
            senderLine(s.address, s.name),
            [s.trash && `${plural(s.count, 'email')} to Trash`, how(s)].filter(Boolean).join(', '),
          ].join(': '),
        ),
        notes: [
          ...rejected.map((x) => `Left out ${x.address}: ${x.reason}.`),
          'Emails are moved to Trash, not deleted. You can undo the move from Mail → History. Unsubscribes can’t be undone.',
        ],
        ...(senders.length === 0 && { blocked: 'None of these senders can be cleared.' }),
      }
    },
  }),

  tool({
    name: 'ordo_undo',
    kind: 'change',
    label: 'Undoing a clean-up',
    done: (d) => `Restored ${plural(num(d, 'restored'), 'email')}`,
    command: 'undo',
    intent: /\b(?:undo|restore|revert|(?:put|bring|move) .{0,60}\bback)\b/i,
    named: (a: { id: number }) => [String(a.id)],
    description:
      'Move a clean-up’s emails from Trash back to the inbox (unsubscribes can’t be undone). Ids come from ordo_history.',
    untrusted: false,
    input: { id: z.number().int().positive() },
    run: viaCommand('undo', (a: { id: number }) => ({ input: { id: a.id } })),
    async preview(services, a) {
      const title = `Undo clean-up ${a.id}`
      if (!services.account().connected)
        return {
          title,
          details: [],
          notes: [],
          blocked: 'No iCloud account is connected. Connect one in Mail first.',
        }
      const c = services.cleanup.history().find((h) => h.id === a.id)
      if (!c) return { title, details: [], notes: [], blocked: `There’s no clean-up ${a.id}.` }
      const when = c.at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
      return {
        title: `Move ${plural(c.moved, 'email')} back to the inbox`,
        details: [
          `From the clean-up on ${when}`,
          ...c.senders.map((s) => `${senderLine(s.address, s.name)}: ${plural(s.moved, 'email')}`),
        ],
        notes: ['Unsubscribes can’t be undone.'],
        ...(!c.canUndo && { blocked: 'This clean-up can’t be undone.' }),
        ...(c.undoneAt && { blocked: 'This clean-up was already undone.' }),
      }
    },
  }),

  tool({
    name: 'ordo_import_statement',
    kind: 'change',
    label: 'Importing a statement',
    done: (d) => `Added ${plural(num(d, 'added'), 'transaction')}`,
    command: 'money import',
    intent: /\bimport\b/i,
    named: (a: { path: string }) => [a.path],
    description:
      'Import a bank statement into Ordo Money from a path on this computer: a regular .csv file under 5 MB. ' +
      'Transactions already imported are skipped.',
    untrusted: false,
    input: {
      path: z
        .string()
        .min(1)
        .max(4096)
        .refine((p) => pathProblem(p, { requireAbsolute: true }) === null, {
          message: 'Give the full local path to the .csv file (not a network path)',
        })
        .describe('Full path to the .csv file on this computer'),
      account: z.string().max(60).optional().describe('Account name (default: from the file)'),
    },
    localPaths: ['path'],
    run: viaCommand('money import', (a: { path: string; account?: string }) => ({
      input: { file: a.path, account: a.account },
    })),
    // Nothing here reads the file: a model chose the path, so it's only opened after Confirm.
    async preview(_services, a) {
      const { file, folder, short } = splitPath(a.path)
      return {
        title: 'Import a bank statement',
        details: [
          { text: `File: ${file}`, title: a.path },
          { text: `Folder: ${short}`, title: folder },
          `Account: ${a.account ?? 'taken from the statement'}`,
        ],
        notes: [
          'Ordo reads the file only after you confirm. Transactions already imported are skipped, and you can remove the account later in Finances.',
        ],
      }
    },
  }),

  tool({
    name: 'ordo_money_sort',
    kind: 'change',
    label: 'Sorting spending with AI',
    done: (d) => `Sorted spending: ${plural(num(d, 'changed'), 'merchant')} changed`,
    command: 'money sort',
    intent:
      /\b(?:sort|categori[sz]e)\b.{0,40}\b(?:merchants?|transactions?|spending|payments?|money|finances)\b/i,
    description:
      'Ask the model chosen in Ordo’s Settings → AI to categorise the merchants left in Other and to match ' +
      'bank payments to email senders the rules couldn’t. Needs AI for Money turned on in Ordo. Only merchant ' +
      'names, a description without numbers and a rough amount go to that model, never balances, accounts or ' +
      'dates; a cloud provider is only used if the user agreed to it in Ordo. Matches only become bills to ' +
      'review in the app.',
    untrusted: false,
    input: {},
    run: viaCommand('money sort', () => ({ input: {} })),
    async preview(services) {
      const who = modelLine(services, 'merchant')
      return {
        title: 'Sort spending left in Other',
        details: [who.line].filter(Boolean),
        notes: [
          'It sees merchant names, descriptions with every number removed and rough amounts, never balances, accounts or dates.',
          'Bill matches it suggests only appear in Bills for you to review.',
          'You can change any category back from the menu on its row in Finances.',
        ],
        ...((who.blocked && { blocked: who.blocked }) ||
          (!services.ai.settings().money && { blocked: 'Turn on AI for Money in Settings → AI first.' })),
      }
    },
  }),

  tool({
    name: 'ordo_ai_sort',
    kind: 'change',
    label: 'Sorting senders with AI',
    done: (d) => `Sorted senders: ${plural(num(d, 'changed'), 'sender')} changed`,
    command: 'ai sort',
    intent: /\b(?:sort|categori[sz]e)\b.{0,40}\b(?:senders?|e?mails?|inbox)\b/i,
    description:
      'Ask the model chosen in Ordo’s Settings → AI to sort the senders in Other. Sender names and subject lines go to ' +
      'that model; a cloud provider is only used if the user agreed to it in Ordo.',
    untrusted: false,
    input: {},
    run: viaCommand('ai sort', () => ({ input: {} })),
    async preview(services) {
      const who = modelLine(services, 'sender')
      return {
        title: 'Sort senders left in Other',
        details: [who.line].filter(Boolean),
        notes: [
          'It sees sender names, addresses and up to five recent subject lines, never message bodies. People you’ve written to are never sent or changed.',
          'Senders it sorts show a sparkle with its confidence in Unclutter.',
        ],
        ...((who.blocked && { blocked: who.blocked }) ||
          (!services.account().connected && {
            blocked: 'No iCloud account is connected. Connect one in Mail first.',
          })),
      }
    },
  }),

  tool({
    name: 'ordo_calendar_add',
    kind: 'change',
    label: 'Adding an event',
    done: () => 'Added an event',
    command: 'calendar add',
    intent:
      /\b(?:add|create|schedule|book|put|set up|make)\b.{0,80}\b(?:events?|meetings?|appointments?|calendar|diary|reminders?|calls?)\b/i,
    named: (a: { title: string }) => [a.title.trim()].filter(Boolean),
    description:
      'Add an event to one of the user’s writable iCloud calendars (see ordo_calendar_list). Optionally ' +
      'repeating daily, weekly, monthly or yearly, until a day or for a number of times.',
    untrusted: true,
    reads: 'your calendar',
    input: {
      calendar: z.string().min(1).max(2048).describe('Calendar name or id, from ordo_calendar_list'),
      ...eventFields,
      title: z.string().max(500).describe('Title'),
      start: z.string().max(16).describe(`Start: ${when}`),
      repeat: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
    },
    run: viaCommand('calendar add', (a: EventArgs & { calendar: string }) => ({
      input: { ...eventFlags(a), calendar: a.calendar },
    })),
    async preview(services, a) {
      const title = 'Add an event'
      if (!services.account().connected) return blockedCard(title, NO_ICLOUD)
      const picked = pickCalendar(services, a.calendar)
      if (!picked.ok) return blockedCard(title, failure(picked.result))
      const cal = picked.calendar
      if (cal.readOnly)
        return blockedCard(title, `“${clean(cal.name, 60)}” is read-only, so events can’t be added to it.`)
      const draft = draftFromFlags(null, eventFlags(a) as EventFlags, localZone())
      if (typeof draft === 'string') return blockedCard(title, draft)
      const problem = checkDraft(draft)
      if (problem) return blockedCard(title, problem)
      return {
        title: `Add “${clean(draft.title || 'New Event', 80)}” to ${clean(cal.name, 60)}`,
        details: [
          whenLine(draft),
          repeatLine(draft),
          alertLine(draft),
          ...(draft.location ? [`Location: ${clean(draft.location, 120)}`] : []),
        ],
        notes: [
          'It’s added to iCloud, so it shows on the user’s other devices too. It can be deleted from Calendar.',
        ],
      }
    },
  }),

  tool({
    name: 'ordo_calendar_edit',
    kind: 'change',
    label: 'Changing an event',
    done: () => 'Changed an event',
    command: 'calendar edit',
    intent: /\b(?:move|reschedule|change|rename|edit|update|push|shift|postpone|bring forward|make it)\b/i,
    named: (a: WhichArgs) => [a.uid],
    description:
      'Change an event on a writable iCloud calendar. Give only the fields to change. For a repeating event, ' +
      'give occurrence to change just that one (“this event only”), or all: true for every occurrence; the ' +
      'series then moves by as much as that occurrence moved. If the event was changed elsewhere since Ordo ' +
      'last synced, nothing is overwritten and the result is the error code "conflict".',
    untrusted: true,
    reads: 'your calendar',
    input: {
      ...whichEvent,
      ...eventFields,
      repeat: z.enum(['daily', 'weekly', 'monthly', 'yearly', 'none']).optional(),
    },
    run: viaCommand('calendar edit', (a: EventArgs & WhichArgs) => ({
      input: { ...eventFlags(a), uid: a.uid, occurrence: a.occurrence, all: a.all, calendar: a.calendar },
    })),
    async preview(services, a) {
      const title = 'Change an event'
      if (!services.account().connected) return blockedCard(title, NO_ICLOUD)
      const flags = eventFlags(a) as EventFlags
      if (Object.values(flags).every((v) => v === undefined))
        return blockedCard(title, 'Nothing would change: no fields were given.')
      const picked = pickEvent(services, a)
      if (!picked.ok) return blockedCard(title, failure(picked.result))
      const before = picked.details.draft
      const after = draftFromFlags(before, flags, localZone())
      if (typeof after === 'string') return blockedCard(title, after)
      const problem = checkDraft(after)
      if (problem) return blockedCard(title, problem)
      const changes: PreviewDetail[] = []
      const diff = (label: string, x: string, y: string) => {
        if (x !== y) changes.push(`${label}: ${x} → ${y}`)
      }
      diff('Title', clean(before.title, 80), clean(after.title, 80))
      diff('When', whenLine(before), whenLine(after))
      diff('Location', clean(before.location || 'none', 80), clean(after.location || 'none', 80))
      if (before.notes !== after.notes) changes.push('Notes changed')
      diff('Repeat', repeatLine(before), repeatLine(after))
      diff('Alert', alertLine(before), alertLine(after))
      const cal = services.calendar.calendars().find((c) => c.id === picked.ref.calendarId)
      const series = picked.details.recurring
      return {
        title: `Change “${clean(before.title || 'New Event', 80)}”${cal ? ` in ${clean(cal.name, 60)}` : ''}`,
        details: [
          series
            ? picked.scope === 'this'
              ? `Only the occurrence on ${whenLine(before)}`
              : 'Every event in the series'
            : whenLine(before),
          ...changes,
        ],
        notes: ['If it was changed on another device since Ordo last synced, nothing is overwritten.'],
        ...(changes.length === 0 && { blocked: 'Nothing would change.' }),
      }
    },
  }),

  tool({
    name: 'ordo_calendar_delete',
    kind: 'change',
    label: 'Deleting an event',
    done: () => 'Deleted an event',
    command: 'calendar delete',
    intent: /\b(?:delete|remove|cancel|drop|clear)\b/i,
    named: (a: WhichArgs) => [a.uid],
    description:
      'Delete an event from a writable iCloud calendar. For a repeating event, give occurrence to delete just ' +
      'that one, or all: true to delete the whole series. This can’t be undone in Ordo.',
    untrusted: true,
    reads: 'your calendar',
    input: whichEvent,
    run: viaCommand('calendar delete', (a: WhichArgs) => ({
      input: { uid: a.uid, occurrence: a.occurrence, all: a.all, calendar: a.calendar },
    })),
    async preview(services, a) {
      const title = 'Delete an event'
      if (!services.account().connected) return blockedCard(title, NO_ICLOUD)
      const picked = pickEvent(services, a)
      if (!picked.ok) return blockedCard(title, failure(picked.result))
      const d = picked.details.draft
      const name = clean(d.title || 'New Event', 80)
      const cal = services.calendar.calendars().find((c) => c.id === picked.ref.calendarId)
      const one = picked.details.recurring && picked.scope === 'this'
      return {
        title: one
          ? `Delete one occurrence of “${name}”`
          : picked.details.recurring
            ? `Delete every event in the series “${name}”`
            : `Delete “${name}”`,
        details: [
          whenLine(d),
          ...(cal ? [`Calendar: ${clean(cal.name, 60)}`] : []),
          ...(d.location ? [`Location: ${clean(d.location, 120)}`] : []),
        ],
        notes: [PERMANENT],
      }
    },
  }),
]

export const toolByName = (name: string): OrdoTool | undefined => TOOLS.find((t) => t.name === name)

/** The arguments a tool accepts, rejecting unknown keys (the assistant checks model output with it). */
export const strictArgs = (t: OrdoTool) => z.object(t.input).strict()

/**
 * Validate, gate and run one tool. Never throws for expected failures: bad arguments come back as
 * `usage`, a change without permission as `changes_not_allowed` or `confirm_required`, anything
 * unexpected as `internal` (the detail goes to stderr only).
 */
export async function runTool(
  services: OrdoServices,
  t: OrdoTool,
  rawArgs: unknown,
  ctx: RunContext,
): Promise<CommandResult> {
  const parsed = z.object(t.input).safeParse(rawArgs ?? {})
  if (!parsed.success)
    return {
      ok: false,
      code: 'usage',
      message: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; '),
    }
  if (t.kind === 'change') {
    const blocked = gate(t.command ?? t.name, ctx.allowChanges, ctx.confirm)
    if (blocked) return blocked
  }
  try {
    return await t.run(services, parsed.data, ctx)
  } catch (err) {
    if (err instanceof UsageError) return { ok: false, code: 'usage', message: err.message }
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    return { ok: false, code: 'internal', message: 'Something went wrong inside Ordo.' }
  }
}

/** A change tool's preview, with its arguments checked first. */
export async function previewTool(
  services: OrdoServices,
  t: OrdoTool,
  rawArgs: unknown,
): Promise<ChangePreview> {
  const failed = {
    title: t.label,
    details: [],
    notes: [],
    blocked: 'Ordo couldn’t work out what this would change.',
  }
  const parsed = z.object(t.input).safeParse(rawArgs ?? {})
  if (!parsed.success || !t.preview) return failed
  try {
    return await t.preview(services, parsed.data)
  } catch {
    return failed
  }
}
