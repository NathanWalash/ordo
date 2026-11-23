import { z } from 'zod'

/**
 * Headless command-line parsing. Pure: no Electron, no disk, so it is unit-tested directly.
 *
 *   Ordo --headless <command> [options]
 *   Ordo --headless --mcp [--allow-changes]
 */

export class UsageError extends Error {
  override name = 'UsageError'
}

/** The arguments after `--headless`, or null when this isn't a headless launch. */
export function headlessArgs(argv: readonly string[]): string[] | null {
  const i = argv.indexOf('--headless')
  if (i === -1) return null
  const rest = argv.slice(i + 1)
  // `pnpm ordo -- status` passes the `--` through.
  return rest[0] === '--' ? rest.slice(1) : rest
}

const CATEGORY_NAMES = [
  'promotions',
  'newsletters',
  'notifications',
  'receipts',
  'people',
  'uncategorised',
] as const

/**
 * A whole number written in plain digits. `z.coerce` used Number(), so `1e3` and `0x10` were
 * read as 1000 and 16: a mistyped `undo` id could reach a different clean-up.
 */
const digits = (schema: z.ZodNumber) =>
  z.preprocess((v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v), schema)

const limit = (fallback: number, max: number) =>
  digits(
    z
      .number({ error: '--limit must be a number' })
      .int('--limit must be a whole number')
      .min(1, '--limit must be at least 1')
      .max(max, `--limit can be at most ${max}`),
  ).default(fallback)

const isoDay = (flag: string) =>
  z
    .string({ error: `${flag} is required (YYYY-MM-DD)` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${flag} must be a date like 2026-11-17`)
    .refine((d) => {
      const [y, m, day] = d.split('-').map(Number) as [number, number, number]
      const date = new Date(y, m - 1, day)
      return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === day
    }, `${flag} isn't a real date`)

/** A board, column, label or card, by name or id. */
const ref = (flag: string, required = `${flag} needs a value`) =>
  z.string({ error: required }).trim().min(1, required).max(300, `${flag} is too long`)

const address = z.string().trim().min(3, 'Give a sender address').max(320, 'That address is too long')

const mailboxPath = z
  .string()
  .min(1, '--mailbox needs a mailbox path, as `mail mailboxes` lists it')
  .max(1000, '--mailbox is too long')
  // eslint-disable-next-line no-control-regex -- control characters are what's refused
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), '--mailbox is not a mailbox path')
const mailbox = mailboxPath.default('INBOX')
/** Which mail account: its label, address or id, as `mail accounts` lists it. */
const mailAccount = z
  .string()
  .trim()
  .min(1, '--account needs an account: its name or address, as `status` lists it')
  .max(320, '--account is too long')
  // eslint-disable-next-line no-control-regex -- control characters are what's refused
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), '--account is not an account')
  .optional()
/** The most messages one mail change acts on. */
export const MAIL_CHANGE_MAX = 20
/** Message uids, as positional arguments: `mail move 41 42 --to archive`. */
const uids = (command: string) =>
  z
    .array(
      digits(
        z
          .number({ error: 'A uid is a whole number, from `mail list`' })
          .int('A uid is a whole number, from `mail list`')
          .positive('A uid is a whole number, from `mail list`')
          .max(4_294_967_295, 'That uid is too big'),
      ),
      { error: `${command} needs at least one message uid (from \`mail list\`)` },
    )
    .min(1, `${command} needs at least one message uid (from \`mail list\`)`)
    .max(MAIL_CHANGE_MAX, `At most ${MAIL_CHANGE_MAX} messages at a time`)
    .refine((u) => new Set(u).size === u.length, 'The same uid is given twice')
/** A day (`2026-11-20`, an all-day event) or a time (`2026-11-20T09:30`). */
const when = (flag: string) =>
  z
    .string({ error: `${flag} is required (YYYY-MM-DD or YYYY-MM-DDTHH:MM)` })
    .regex(
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/,
      `${flag} must be a day like 2026-11-20, or a time like 2026-11-20T09:30`,
    )

const REPEATS = ['daily', 'weekly', 'monthly', 'yearly'] as const

/** Minutes before the start, or `none`. */
const alert = z.union([z.number(), z.string()]).transform((v, ctx) => {
  if (v === 'none') return null
  const n = Number(v)
  if (typeof v === 'string' && !/^-?\d+$/.test(v.trim()))
    ctx.addIssue({ code: 'custom', message: '--alert is minutes before the start, like 15, or none' })
  else if (!Number.isInteger(n) || n < -10_080 || n > 40_320)
    ctx.addIssue({ code: 'custom', message: '--alert must be between -10080 and 40320 minutes, or none' })
  return n
})

/** The fields of an event, for `calendar add` and `calendar edit`. */
const eventFields = {
  title: z.string().max(500, '--title is too long').optional(),
  start: when('--start').optional(),
  end: when('--end').optional(),
  'time-zone': z.string().trim().min(1).max(64).optional(),
  location: z.string().max(1000, '--location is too long').optional(),
  notes: z.string().max(10_000, '--notes is too long').optional(),
  until: isoDay('--until').optional(),
  count: z.coerce
    .number({ error: '--count must be a number' })
    .int('--count must be a whole number')
    .min(1, '--count must be at least 1')
    .max(1000, '--count can be at most 1000')
    .optional(),
  alert: alert.optional(),
}

/** Which event: its UID, and for one occurrence of a repeating event, that occurrence's id. */
const eventChoice = {
  uid: z.string({ error: 'Name the event with --uid (from `calendar events --json`)' }).min(1).max(1024),
  occurrence: z.string().min(1).max(40).optional(),
  all: z.boolean().default(false),
  calendar: z.string().trim().min(1).max(2048).optional(),
  confirm: z.boolean().default(false),
}

/** The longest calendar range one command can ask for, like the app's own Calendar. */
export const MAX_EVENT_DAYS = 400

const senderChoice = {
  sender: z
    .array(address, { error: 'Name at least one --sender <address>' })
    .min(1, 'Name at least one --sender <address>')
    .max(100, 'At most 100 senders at a time'),
  'no-unsubscribe': z.boolean().default(false),
  'no-trash': z.boolean().default(false),
}

/** Every command, its positional arguments and the flags it accepts. */
const COMMANDS = {
  status: { args: [], flags: z.object({}) },
  scan: { args: [], flags: z.object({}) },
  senders: {
    args: [],
    flags: z.object({
      // The app calls the uncategorised group "Other".
      category: z
        .string()
        .transform((c) => (c.toLowerCase() === 'other' ? 'uncategorised' : c.toLowerCase()))
        .pipe(z.enum(CATEGORY_NAMES, { error: `--category must be one of ${CATEGORY_NAMES.join(', ')}` }))
        .optional(),
      limit: limit(50, 5000),
    }),
  },
  'cleanup plan': { args: [], flags: z.object({ ...senderChoice, account: mailAccount }) },
  'cleanup run': {
    args: [],
    flags: z.object({ ...senderChoice, account: mailAccount, confirm: z.boolean().default(false) }),
  },
  history: { args: [], flags: z.object({ limit: limit(10, 500) }) },
  undo: {
    args: ['id'],
    flags: z.object({
      id: digits(z.number({ error: 'undo needs a clean-up id from `history`' }).int().positive()),
      confirm: z.boolean().default(false),
    }),
  },
  'mail mailboxes': { args: [], flags: z.object({ account: mailAccount }) },
  'mail sync': { args: [], flags: z.object({ mailbox, account: mailAccount }) },
  'mail list': {
    args: [],
    flags: z.object({
      mailbox,
      account: mailAccount,
      unread: z.boolean().default(false),
      limit: limit(25, 500),
    }),
  },
  'mail search': {
    args: ['query'],
    flags: z.object({
      query: z
        .string({ error: 'mail search needs something to look for' })
        .trim()
        .min(1, 'mail search needs something to look for')
        .max(200, 'Search for at most 200 characters'),
      mailbox: mailboxPath.optional(),
      account: mailAccount,
      server: z.boolean().default(false),
      limit: limit(25, 200),
    }),
  },
  'mail read': {
    args: ['uid'],
    flags: z.object({
      uid: z.coerce
        .number({ error: 'mail read needs a message uid from `mail list`' })
        .int('The uid is a whole number')
        .positive('The uid is a whole number'),
      mailbox,
      account: mailAccount,
    }),
  },
  'mail move': {
    args: [],
    rest: 'uids',
    flags: z.object({
      uids: uids('mail move'),
      mailbox,
      account: mailAccount,
      to: z
        .string({ error: 'mail move needs --to archive, bin, junk, inbox or a folder from `mail mailboxes`' })
        .trim()
        .min(1, 'mail move needs --to archive, bin, junk, inbox or a folder from `mail mailboxes`')
        .max(1000, '--to is too long')
        // eslint-disable-next-line no-control-regex -- control characters are what's refused
        .refine((p) => !/[\u0000-\u001f\u007f]/.test(p), '--to is not a folder'),
      confirm: z.boolean().default(false),
    }),
  },
  'mail flag': {
    args: [],
    rest: 'uids',
    flags: z.object({
      uids: uids('mail flag'),
      mailbox,
      account: mailAccount,
      unflag: z.boolean().default(false),
      confirm: z.boolean().default(false),
    }),
  },
  'mail mark': {
    args: [],
    rest: 'uids',
    flags: z
      .object({
        uids: uids('mail mark'),
        mailbox,
        account: mailAccount,
        read: z.boolean().default(false),
        unread: z.boolean().default(false),
        confirm: z.boolean().default(false),
      })
      .refine((f) => f.read !== f.unread, 'mail mark needs --read or --unread'),
  },
  'mail undo': {
    args: ['id'],
    flags: z.object({
      id: digits(
        z.number({ error: 'The undo id is a whole number, from `mail move`' }).int().positive(),
      ).optional(),
      confirm: z.boolean().default(false),
    }),
  },
  'calendar sync': { args: [], flags: z.object({}) },
  'calendar events': {
    args: [],
    flags: z
      .object({ from: isoDay('--from'), to: isoDay('--to'), limit: limit(100, 5000) })
      .refine((r) => r.from <= r.to, '--to must be on or after --from')
      .refine(
        (r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < MAX_EVENT_DAYS,
        `Ask for at most ${MAX_EVENT_DAYS} days at a time`,
      ),
  },
  'calendar list': { args: [], flags: z.object({}) },
  'calendar add': {
    args: [],
    flags: z.object({
      ...eventFields,
      calendar: z
        .string({ error: 'Choose a calendar with --calendar <name> (see `calendar list`)' })
        .trim()
        .min(1)
        .max(2048),
      title: z.string({ error: 'Give the event a --title' }).max(500, '--title is too long'),
      start: when('--start'),
      repeat: z.enum(REPEATS, { error: `--repeat must be one of ${REPEATS.join(', ')}` }).optional(),
      confirm: z.boolean().default(false),
    }),
  },
  'calendar edit': {
    args: [],
    flags: z.object({
      ...eventFields,
      ...eventChoice,
      repeat: z
        .enum([...REPEATS, 'none'], { error: `--repeat must be one of ${REPEATS.join(', ')} or none` })
        .optional(),
    }),
  },
  'calendar delete': { args: [], flags: z.object(eventChoice) },
  'money bills': { args: [], flags: z.object({}) },
  'money transactions': {
    args: [],
    flags: z.object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, '--month must look like 2026-11')
        .optional(),
      account: z.string().trim().min(1).max(60, '--account is too long').optional(),
      limit: limit(100, 5000),
    }),
  },
  'money balances': { args: [], flags: z.object({}) },
  'money import': {
    args: ['file'],
    flags: z.object({
      file: z.string({ error: 'money import needs a .csv file' }).min(1).max(4096),
      account: z.string().trim().min(1).max(60, '--account is too long').optional(),
      confirm: z.boolean().default(false),
    }),
  },
  'money sort': { args: [], flags: z.object({ confirm: z.boolean().default(false) }) },
  'money knows': { args: [], flags: z.object({}) },
  'money questions': { args: [], flags: z.object({}) },
  'money loose-ends': { args: [], flags: z.object({}) },
  'money events': { args: [], flags: z.object({}) },
  'money compare': {
    args: [],
    flags: z.object({
      category: z.string().trim().min(1).max(40, '--category is too long').optional(),
      account: z.string().trim().min(1).max(60, '--account is too long').optional(),
    }),
  },
  'money answer': {
    args: ['question'],
    flags: z.object({
      question: z
        .string({ error: 'money answer needs a question id from `money questions`' })
        .min(1)
        .max(400),
      answer: z.string({ error: 'money answer needs --answer <id>' }).min(1).max(40),
      confirm: z.boolean().default(false),
    }),
  },
  'money forget': {
    args: ['fact'],
    flags: z.object({
      fact: z.string({ error: 'money forget needs a fact id from `money knows`' }).min(1).max(100),
      confirm: z.boolean().default(false),
    }),
  },
  'ai status': { args: [], flags: z.object({}) },
  'ai sort': { args: [], flags: z.object({ confirm: z.boolean().default(false) }) },
  'boards list': { args: [], flags: z.object({}) },
  'boards cards': {
    args: [],
    flags: z.object({
      board: ref('--board').optional(),
      column: ref('--column').optional(),
      label: z.array(ref('--label')).max(20, 'At most 20 labels').optional(),
      archived: z.boolean().default(false),
      limit: limit(100, 5000),
    }),
  },
  'boards add-card': {
    args: [],
    flags: z.object({
      board: ref('--board', 'boards add-card needs --board <name>'),
      column: ref('--column').optional(),
      title: z
        .string({ error: 'boards add-card needs --title <text>' })
        .trim()
        .min(1, 'boards add-card needs --title <text>')
        .max(300, '--title is too long'),
      notes: z.string().max(20_000, '--notes is too long').optional(),
      start: isoDay('--start').optional(),
      due: isoDay('--due').optional(),
      label: z.array(ref('--label')).max(20, 'At most 20 labels').optional(),
      confirm: z.boolean().default(false),
    }),
  },
  'boards move-card': {
    args: ['card'],
    flags: z.object({
      card: ref('boards move-card needs a card id or title', 'boards move-card needs a card id or title'),
      board: ref('--board').optional(),
      column: ref('--column').optional(),
      position: z.coerce
        .number({ error: '--position must be a number' })
        .int('--position must be a whole number')
        .min(1, '--position starts at 1 (the top)')
        .max(100_000)
        .optional(),
      confirm: z.boolean().default(false),
    }),
  },
} as const

type Specs = typeof COMMANDS
export type CommandName = keyof Specs
/** A schema's output without the index signature zod gives an empty object. */
type Options<S extends z.ZodType> = {
  [P in keyof z.output<S> as string extends P ? never : P]: z.output<S>[P]
}
export type Command = {
  [K in CommandName]: { name: K } & Options<Specs[K]['flags']>
}[CommandName]

export const COMMAND_NAMES = Object.keys(COMMANDS) as CommandName[]

/** Commands that change your mailbox or data: they need `--allow-changes` and `--confirm`. */
export const CHANGE_COMMANDS: ReadonlySet<CommandName> = new Set([
  'cleanup run',
  'undo',
  'money import',
  'money sort',
  'money answer',
  'money forget',
  'ai sort',
  'boards add-card',
  'boards move-card',
  'calendar add',
  'calendar edit',
  'calendar delete',
  'mail move',
  'mail flag',
  'mail mark',
  'mail undo',
])

const GROUPS = new Set(['cleanup', 'mail', 'calendar', 'money', 'ai', 'boards'])

/** How each flag is written: a switch, a value, or a value that may repeat. */
const FLAG_KINDS: Record<string, 'switch' | 'value' | 'list'> = {
  json: 'switch',
  'allow-changes': 'switch',
  mcp: 'switch',
  help: 'switch',
  confirm: 'switch',
  'no-unsubscribe': 'switch',
  'no-trash': 'switch',
  all: 'switch',
  category: 'value',
  calendar: 'value',
  title: 'value',
  start: 'value',
  end: 'value',
  'time-zone': 'value',
  location: 'value',
  notes: 'value',
  repeat: 'value',
  until: 'value',
  count: 'value',
  alert: 'value',
  uid: 'value',
  occurrence: 'value',
  limit: 'value',
  from: 'value',
  to: 'value',
  month: 'value',
  account: 'value',
  answer: 'value',
  sender: 'list',
  mailbox: 'value',
  unread: 'switch',
  read: 'switch',
  unflag: 'switch',
  server: 'switch',
  board: 'value',
  column: 'value',
  due: 'value',
  position: 'value',
  label: 'list',
  archived: 'switch',
}
const GLOBAL_FLAGS = new Set(['json', 'allow-changes', 'help'])
/** Flags that may be set to nothing (`--location=`), to clear a field. */
const CLEARABLE = new Set(['location', 'notes'])

export type Invocation =
  | { kind: 'help'; json: boolean; topic?: string }
  | { kind: 'mcp'; allowChanges: boolean }
  | { kind: 'command'; command: Command; json: boolean; allowChanges: boolean }

interface Tokens {
  positionals: string[]
  flags: Map<string, string | string[] | true>
}

function tokenize(args: readonly string[]): Tokens {
  const positionals: string[] = []
  const flags = new Map<string, string | string[] | true>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    // Everything after `--` is an argument, even if it starts with a dash (a file name).
    if (arg === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (arg === '-h') {
      flags.set('help', true)
      continue
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg))
        throw new UsageError(`Unknown option ${arg}`)
      positionals.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    const kind = FLAG_KINDS[name]
    if (!kind) throw new UsageError(`Unknown option --${name}`)
    if (kind === 'switch') {
      if (eq !== -1) throw new UsageError(`--${name} doesn't take a value`)
      flags.set(name, true)
      continue
    }
    let value: string | undefined
    if (eq !== -1) value = arg.slice(eq + 1)
    else if (i + 1 < args.length && !args[i + 1]!.startsWith('--')) value = args[++i]
    if (value === undefined || (value === '' && !CLEARABLE.has(name)))
      throw new UsageError(`--${name} needs a value`)
    if (kind === 'list') {
      const prev = flags.get(name)
      flags.set(name, [...(Array.isArray(prev) ? prev : []), value])
    } else {
      if (flags.has(name)) throw new UsageError(`--${name} is given twice`)
      flags.set(name, value)
    }
  }
  return { positionals, flags }
}

/** Parse the arguments after `--headless`. Throws UsageError for anything it doesn't understand. */
export function parseInvocation(args: readonly string[]): Invocation {
  const { positionals, flags } = tokenize(args)
  const json = flags.get('json') === true
  const allowChanges = flags.get('allow-changes') === true

  if (flags.get('mcp') === true) {
    const extra = [...flags.keys()].filter((f) => f !== 'mcp' && f !== 'allow-changes')
    if (positionals.length || extra.length)
      throw new UsageError('--mcp runs the MCP server on stdio and takes only --allow-changes')
    return { kind: 'mcp', allowChanges }
  }

  const [first, second] = positionals
  if (!first || first === 'help' || flags.get('help') === true) {
    const topic = first === 'help' ? positionals.slice(1).join(' ') : positionals.join(' ')
    // Help for something that isn't a command is still an unknown command.
    const asked = first === 'help' ? positionals[1] : first
    if (asked && !GROUPS.has(asked) && !(asked in COMMANDS))
      throw new UsageError(`Unknown command: ${asked}. See \`help\`.`)
    return { kind: 'help', json, ...(topic && { topic }) }
  }

  const name = GROUPS.has(first) ? `${first} ${second ?? ''}`.trim() : first
  if (!(name in COMMANDS)) {
    if (GROUPS.has(first))
      throw new UsageError(
        second
          ? `Unknown command: ${name}. See \`help ${first}\`.`
          : `\`${first}\` needs a subcommand. See \`help ${first}\`.`,
      )
    throw new UsageError(`Unknown command: ${first}. See \`help\`.`)
  }
  const spec = COMMANDS[name as CommandName] as {
    args: readonly string[]
    /** Takes any number of trailing arguments, as a list under this name. */
    rest?: string
    flags: z.ZodObject
  }
  const rest = positionals.slice(GROUPS.has(first) ? 2 : 1)
  if (!spec.rest && rest.length > spec.args.length)
    throw new UsageError(`Unexpected argument: ${rest[spec.args.length]}`)

  const input: Record<string, unknown> = {}
  const allowed = new Set(Object.keys(spec.flags.shape))
  for (const [flag, value] of flags) {
    if (GLOBAL_FLAGS.has(flag)) continue
    if (!allowed.has(flag) || spec.args.includes(flag) || flag === spec.rest)
      throw new UsageError(`${name} doesn't take --${flag}`)
    input[flag] = value
  }
  spec.args.forEach((arg, i) => {
    if (rest[i] !== undefined) input[arg] = rest[i]
  })
  // The rest of the arguments, as a list (`mail move 41 42 --to archive`).
  if (spec.rest && rest.length > spec.args.length) input[spec.rest] = rest.slice(spec.args.length)

  return { kind: 'command', command: commandFrom(name as CommandName, input), json, allowChanges }
}

/**
 * Validate a command's options (flag names as keys) with the same rules the CLI uses.
 * The MCP server builds its commands through this too. Throws UsageError.
 */
export function commandFrom(name: CommandName, input: Record<string, unknown>): Command {
  const parsed = COMMANDS[name].flags.safeParse(input)
  if (!parsed.success) throw new UsageError(parsed.error.issues[0]?.message ?? 'Invalid arguments')
  return { name, ...parsed.data } as Command
}
