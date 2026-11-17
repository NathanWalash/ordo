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

const limit = (fallback: number, max: number) =>
  z.coerce
    .number({ error: '--limit must be a number' })
    .int('--limit must be a whole number')
    .min(1, '--limit must be at least 1')
    .max(max, `--limit can be at most ${max}`)
    .default(fallback)

const isoDay = (flag: string) =>
  z
    .string({ error: `${flag} is required (YYYY-MM-DD)` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${flag} must be a date like 2026-11-17`)
    .refine((d) => {
      const [y, m, day] = d.split('-').map(Number) as [number, number, number]
      const date = new Date(y, m - 1, day)
      return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === day
    }, `${flag} isn't a real date`)

const address = z.string().trim().min(3, 'Give a sender address').max(320, 'That address is too long')

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
  'cleanup plan': { args: [], flags: z.object(senderChoice) },
  'cleanup run': { args: [], flags: z.object({ ...senderChoice, confirm: z.boolean().default(false) }) },
  history: { args: [], flags: z.object({ limit: limit(10, 500) }) },
  undo: {
    args: ['id'],
    flags: z.object({
      id: z.coerce.number({ error: 'undo needs a clean-up id from `history`' }).int().positive(),
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
  'ai status': { args: [], flags: z.object({}) },
  'ai sort': { args: [], flags: z.object({ confirm: z.boolean().default(false) }) },
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
  'ai sort',
])

const GROUPS = new Set(['cleanup', 'calendar', 'money', 'ai'])

/** How each flag is written: a switch, a value, or a value that may repeat. */
const FLAG_KINDS: Record<string, 'switch' | 'value' | 'list'> = {
  json: 'switch',
  'allow-changes': 'switch',
  mcp: 'switch',
  help: 'switch',
  confirm: 'switch',
  'no-unsubscribe': 'switch',
  'no-trash': 'switch',
  category: 'value',
  limit: 'value',
  from: 'value',
  to: 'value',
  month: 'value',
  account: 'value',
  sender: 'list',
}
const GLOBAL_FLAGS = new Set(['json', 'allow-changes', 'help'])

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
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`)
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
  const spec = COMMANDS[name as CommandName]
  const rest = positionals.slice(GROUPS.has(first) ? 2 : 1)
  if (rest.length > spec.args.length) throw new UsageError(`Unexpected argument: ${rest[spec.args.length]}`)

  const input: Record<string, unknown> = {}
  const allowed = new Set(Object.keys(spec.flags.shape))
  for (const [flag, value] of flags) {
    if (GLOBAL_FLAGS.has(flag)) continue
    if (!allowed.has(flag) || (spec.args as readonly string[]).includes(flag))
      throw new UsageError(`${name} doesn't take --${flag}`)
    input[flag] = value
  }
  spec.args.forEach((arg, i) => {
    if (rest[i] !== undefined) input[arg] = rest[i]
  })

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
