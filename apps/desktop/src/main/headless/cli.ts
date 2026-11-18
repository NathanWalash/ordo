import { COMMAND_NAMES, CHANGE_COMMANDS, type Invocation } from './args'
import { exitCodeFor, runCommand, type CommandResult, type OrdoServices, type Progress } from './commands'
import { formatHuman, formatJson, HELP } from './format'

export interface CliIo {
  /** The command's output. With --json, exactly one JSON document. */
  out(text: string): void
  /** Progress, warnings and human-readable errors. */
  err(text: string): void
  /** Whether stderr is a terminal, to redraw progress on one line. */
  errIsTTY: boolean
}

/** Progress on stderr: redrawn in place on a terminal, a few lines otherwise. */
function progressPrinter(io: CliIo) {
  let shown = ''
  let open = false
  const show = (label: string, done: number, total: number) => {
    const bucket = total > 0 ? Math.floor((done / total) * 4) : 0
    const key = io.errIsTTY ? `${label} ${done}/${total}` : `${label} ${bucket}`
    if (key === shown) return
    shown = key
    const text = total > 0 ? `${label}: ${done} of ${total}` : `${label}…`
    if (io.errIsTTY) {
      io.err(`\r\u001b[2K${text}`)
      open = true
    } else io.err(`${text}\n`)
  }
  const progress: Progress = {
    scan: (p) =>
      show(
        p.phase === 'sent' ? 'Checking sent mail' : p.phase === 'done' ? 'Done' : 'Scanning inbox',
        p.checked,
        p.total,
      ),
    cleanup: (p) =>
      show(
        p.phase === 'unsubscribe' ? 'Unsubscribing' : p.phase === 'move' ? 'Moving to Trash' : 'Done',
        p.done,
        p.total,
      ),
    mail: (p) => show(`Checking ${p.mailbox}`, p.checked, p.total),
    calendar: (p) => show('Syncing calendars', p.done, p.total),
    ai: (p) => show('Sorting senders', p.done, p.total),
    money: (p) => show(p.phase === 'bills' ? 'Matching bills' : 'Sorting merchants', p.done, p.total),
  }
  return {
    progress,
    end: () => {
      if (open) io.err('\n')
      open = false
    },
  }
}

function print(io: CliIo, json: boolean, name: (typeof COMMAND_NAMES)[number], result: CommandResult) {
  if (json) io.out(`${formatJson(result)}\n`)
  else if (result.ok) io.out(`${formatHuman(name, result)}\n`)
  else io.err(`${formatHuman(name, result)}\n`)
}

/** Print a usage error and return its exit code. */
export function usageError(io: CliIo, json: boolean, message: string): number {
  const result: CommandResult = { ok: false, code: 'usage', message }
  if (json) io.out(`${formatJson(result)}\n`)
  else io.err(`Error: ${message}\nRun with --help to see the commands.\n`)
  return exitCodeFor(result)
}

/** Run a parsed CLI invocation (not --mcp). Returns the exit code. */
export async function runCli(
  invocation: Exclude<Invocation, { kind: 'mcp' }>,
  services: OrdoServices,
  io: CliIo,
): Promise<number> {
  if (invocation.kind === 'help') {
    if (invocation.json)
      io.out(
        `${JSON.stringify(
          {
            usage: 'ordo --headless <command> [options]',
            commands: COMMAND_NAMES.map((name) => ({ name, changes: CHANGE_COMMANDS.has(name) })),
            help: HELP,
          },
          null,
          2,
        )}\n`,
      )
    else io.out(`${HELP}\n`)
    return 0
  }

  const { command, json, allowChanges } = invocation
  const printer = progressPrinter(io)
  let result: CommandResult
  try {
    result = await runCommand(services, command, { allowChanges, progress: printer.progress })
  } catch (err) {
    // Unexpected: don't echo internals (paths, stack) to stdout; the detail goes to stderr.
    io.err(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    result = { ok: false, code: 'internal', message: 'Something went wrong inside Ordo.' }
  } finally {
    printer.end()
  }
  print(io, json, command.name, result)
  return exitCodeFor(result)
}
