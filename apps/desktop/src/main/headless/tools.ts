import { z } from 'zod'
import { CHANGE_COMMANDS, commandFrom, MAX_EVENT_DAYS, UsageError, type CommandName } from './args'
import { gate, runCommand, type CommandResult, type OrdoServices } from './commands'
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

/**
 * Exactly what a change tool would do, for the assistant's confirmation card. Ordo builds it from
 * its own data (a dry-run plan, the history, the file itself), never from the model's words.
 */
export interface ChangePreview {
  /** One line, e.g. "Import 26 transactions into Monzo". */
  title: string
  /** One fact per line. */
  details: string[]
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
  /** For the model: what it does and when to use it. No front-end specifics. */
  description: string
  /** Results carry text from emails, statements or calendars. */
  untrusted: boolean
  /** Arguments, as a zod shape (MCP turns it into JSON Schema; the assistant validates strictly). */
  input: S
  /** The headless command behind it, if any. Change gate messages use its name. */
  command?: CommandName
  /**
   * Change tools: words in the user's own message that show they asked for this kind of change.
   * Without them, the confirmation card warns that the request may have come from data.
   */
  intent?: RegExp
  /**
   * Arguments that name a file on this computer. They must be absolute local paths (never UNC or
   * device paths), the assistant accepts them only when the user typed them, and previews must not
   * touch them: the file is read only after the user confirms.
   */
  localPaths?: readonly (keyof S & string)[]
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

function cleanupArgs(a: { senders: string[]; unsubscribe: boolean; trash: boolean }) {
  return { sender: a.senders, 'no-unsubscribe': !a.unsubscribe, 'no-trash': !a.trash }
}

const aiProviderLine = (services: OrdoServices, what: string): { line: string; blocked?: string } => {
  const ai = services.ai.settings()
  if (ai.provider === 'none') return { line: '', blocked: 'Choose a model in Settings → AI first.' }
  const cloud = ai.provider === 'claude-cli' || ai.provider === 'codex-cli'
  const vendor = ai.provider === 'claude-cli' ? 'Anthropic' : 'OpenAI'
  return {
    line: cloud
      ? `${what} go to ${vendor} under your own account.`
      : `${what} go to the model on this computer.`,
  }
}

export const TOOLS: readonly OrdoTool[] = [
  tool({
    name: 'ordo_status',
    kind: 'read',
    label: 'Checking Ordo',
    command: 'status',
    description:
      'Ordo’s state: whether an iCloud account is connected (its email only, never the password), ' +
      'last scan, the AI provider, counts, and whether another Ordo process is busy writing.',
    untrusted: false,
    input: {},
    run: viaCommand('status', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_senders',
    kind: 'read',
    label: 'Reading your senders',
    command: 'senders',
    description:
      'Senders in the cached inbox, most emails first, with category and unsubscribe method. ' +
      'protected: true marks people the user has written to; Ordo never clears them. ' +
      'Run ordo_scan first to refresh.',
    untrusted: true,
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
    command: 'cleanup plan',
    description:
      'Dry run of a clean-up: exactly which emails Ordo would move to Trash and how it would unsubscribe, ' +
      'with the same checks as the app (people are refused, plain http links and unsubscribe emails to ' +
      'another domain need the app). Changes nothing.',
    untrusted: true,
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
    command: 'history',
    description: 'Past clean-ups, newest first, with what was moved and whether it can be undone.',
    untrusted: true,
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
    command: 'calendar events',
    description:
      `Cached events from the user’s visible calendars between two days (inclusive, at most ${MAX_EVENT_DAYS} days). ` +
      'Run ordo_calendar_sync first to refresh.',
    untrusted: true,
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
    name: 'ordo_bills',
    kind: 'read',
    label: 'Reading your bills',
    command: 'money bills',
    description:
      'Bills and subscriptions from Ordo Money, with amounts in pence (GBP), cadence, next due date and splits.',
    untrusted: true,
    input: {},
    run: viaCommand('money bills', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_transactions',
    kind: 'read',
    label: 'Reading transactions',
    command: 'money transactions',
    description: 'Bank transactions imported into Ordo Money, newest first, amounts in pence (GBP).',
    untrusted: true,
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
    command: 'money balances',
    description: 'Who owes whom for shared bills, in pence (GBP).',
    untrusted: true,
    input: {},
    run: viaCommand('money balances', () => ({ input: {} })),
  }),

  tool({
    name: 'ordo_scan',
    kind: 'refresh',
    label: 'Scanning your inbox',
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
    command: 'cleanup run',
    intent:
      /\b(?:unsubscribe (?:me )?from|clean (?:up|out)|clear (?:out|up|away)|(?:move|send|put) .{0,80}\bto (?:the )?trash|trash (?:them|those|these|it|all)|get rid of)\b/i,
    description:
      'Unsubscribe from the given senders and move their cached inbox emails to Trash (nothing is deleted; ' +
      'ordo_undo puts them back). Call ordo_cleanup_plan first and show the user the plan. People are refused.',
    untrusted: true,
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
        return { title: 'Clear senders', details: [], notes: [], blocked: 'No iCloud account is connected.' }
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
        if (m.kind === 'one-click') return 'unsubscribe in one click'
        if (m.kind === 'link') return 'open the unsubscribe page in your browser'
        return `send an unsubscribe email to ${s.mailto?.to ?? 'the sender'}`
      }
      return {
        title: parts.length
          ? `${parts.join(' and ').replace(/^./, (c) => c.toUpperCase())}`
          : 'Nothing to clear',
        details: senders.map((s) =>
          [
            s.name ? `${s.name} <${s.address}>` : s.address,
            [s.trash && `${plural(s.count, 'email')} to Trash`, how(s)].filter(Boolean).join(', '),
          ].join(': '),
        ),
        notes: [
          ...rejected.map((x) => `Left out ${x.address}: ${x.reason}.`),
          'Emails go to Trash, not deleted. You can undo the move from Mail → History; unsubscribes can’t be undone.',
        ],
        ...(senders.length === 0 && { blocked: 'None of these senders can be cleared.' }),
      }
    },
  }),

  tool({
    name: 'ordo_undo',
    kind: 'change',
    label: 'Undoing a clean-up',
    command: 'undo',
    intent: /\b(?:undo|restore|revert|(?:put|bring|move) .{0,60}\bback)\b/i,
    description:
      'Move a clean-up’s emails from Trash back to the inbox (unsubscribes can’t be undone). Ids come from ordo_history.',
    untrusted: false,
    input: { id: z.number().int().positive() },
    run: viaCommand('undo', (a: { id: number }) => ({ input: { id: a.id } })),
    async preview(services, a) {
      const title = `Undo clean-up ${a.id}`
      if (!services.account().connected)
        return { title, details: [], notes: [], blocked: 'No iCloud account is connected.' }
      const c = services.cleanup.history().find((h) => h.id === a.id)
      if (!c) return { title, details: [], notes: [], blocked: `There’s no clean-up ${a.id}.` }
      const when = c.at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
      return {
        title: `Move ${plural(c.moved, 'email')} back to the inbox`,
        details: [
          `From the clean-up on ${when}`,
          ...c.senders.map(
            (s) => `${s.name ? `${s.name} <${s.address}>` : s.address}: ${plural(s.moved, 'email')}`,
          ),
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
    command: 'money import',
    intent: /\bimport\b/i,
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
      return {
        title: 'Import a bank statement',
        details: [`File: ${a.path}`, `Account: ${a.account ?? 'named from the file'}`],
        notes: [
          'Ordo opens the file only after you confirm: a regular .csv file under 5 MB. Transactions you’ve already imported are skipped, and you can remove the account in Finances.',
        ],
      }
    },
  }),

  tool({
    name: 'ordo_money_sort',
    kind: 'change',
    label: 'Sorting merchants with AI',
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
      const sent = aiProviderLine(services, 'Merchant names, descriptions without numbers and rough amounts')
      return {
        title: 'Sort the merchants in Other with AI',
        details: [sent.line].filter(Boolean),
        notes: ['Categories can be changed back on Finances. Bill matches only appear in Bills to review.'],
        ...((sent.blocked && { blocked: sent.blocked }) ||
          (!services.ai.settings().money && { blocked: 'Turn on AI for Money in Settings → AI first.' })),
      }
    },
  }),

  tool({
    name: 'ordo_ai_sort',
    kind: 'change',
    label: 'Sorting senders with AI',
    command: 'ai sort',
    intent: /\b(?:sort|categori[sz]e)\b.{0,40}\b(?:senders?|e?mails?|inbox)\b/i,
    description:
      'Ask the model chosen in Ordo’s Settings → AI to sort the senders in Other. Sender names and subject lines go to ' +
      'that model; a cloud provider is only used if the user agreed to it in Ordo.',
    untrusted: false,
    input: {},
    run: viaCommand('ai sort', () => ({ input: {} })),
    async preview(services) {
      const sent = aiProviderLine(services, 'Sender names, addresses and subject lines')
      return {
        title: 'Sort the senders in Other with AI',
        details: [sent.line].filter(Boolean),
        notes: ['People you’ve written to are never sent or changed.'],
        ...(sent.blocked && { blocked: sent.blocked }),
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
  const parsed = z.object(t.input).safeParse(rawArgs ?? {})
  if (!parsed.success || !t.preview)
    return {
      title: t.label,
      details: [],
      notes: [],
      blocked: 'Ordo couldn’t work out what this would change.',
    }
  try {
    return await t.preview(services, parsed.data)
  } catch {
    return {
      title: t.label,
      details: [],
      notes: [],
      blocked: 'Ordo couldn’t work out what this would change.',
    }
  }
}
