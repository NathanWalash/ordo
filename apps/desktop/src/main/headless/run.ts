import { app, crashReporter } from 'electron'
import { closeMail } from '../mail'
import { closeMailClient } from '../mail-client'
import { closeCalendar } from '../calendar'
import { closeMoney } from '../money'
import { closeBoards } from '../boards'
import { initAi } from '../ai'
import { releaseWriteLock, setWriteOwner } from '../writes'
import { parseInvocation, UsageError, type Invocation } from './args'
import { runCli, usageError, type CliIo } from './cli'
import { serveMcp } from './mcp'
import { mainServices } from './services'

/** Write to stdout and wait until it has been handed to the OS, so nothing is lost on exit. */
function writeOut(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!text) return resolve()
    process.stdout.once('error', () => resolve()) // the reader went away (EPIPE)
    process.stdout.write(text, () => resolve())
  })
}

/** Close the databases, drop the write lock and exit. */
function quit(code: number): void {
  closeMail()
  closeMailClient()
  closeCalendar()
  closeMoney()
  closeBoards()
  releaseWriteLock()
  if (process.env['ORDO_TEST_CRASH_DUMPS'])
    process.stderr.write(
      `TEMP metrics ${Math.round(performance.now())}ms ${JSON.stringify(app.getAppMetrics().map((m) => [m.type, m.name ?? '', m.serviceName ?? '', m.creationTime]))}\n`,
    )
  app.exit(code)
}

/**
 * Run Ordo without a window: one CLI command, or the MCP server on stdio. No window, no Dock
 * icon, no IPC handlers. Exits with the command's exit code (see `exitCodeFor`).
 *
 * `setup` applies the same start-up overrides as the app (test-only, unpackaged builds).
 */
export async function runHeadless(args: string[], setup: () => void): Promise<void> {
  // stdout carries the output (or MCP messages) only: anything else that logs goes to stderr.
  for (const level of ['log', 'info', 'debug', 'warn'] as const) console[level] = console.error
  if (process.platform === 'darwin') app.dock?.hide()
  // Nothing is drawn. Without this, Linux with no display logs a page of GPU errors to stderr.
  app.disableHardwareAcceleration()
  // TEMPORARY (fix/windows-headless-crash): keep minidumps of a crash for the CI to analyse.
  const dumps = !app.isPackaged ? process.env['ORDO_TEST_CRASH_DUMPS'] : undefined
  if (dumps) {
    app.setPath('crashDumps', dumps)
    crashReporter.start({ uploadToServer: false })
  }

  // Electron shows a dialog for an uncaught error in the main process: never in headless mode.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    quit(1)
  })
  process.stdout.on('error', () => {})

  const json = args.includes('--json')
  const pending: string[] = []
  const io: CliIo = {
    out: (text) => void pending.push(text),
    err: (text) => void process.stderr.write(text),
    errIsTTY: process.stderr.isTTY === true,
  }

  let code = 0
  try {
    let invocation: Invocation
    try {
      invocation = parseInvocation(args)
    } catch (err) {
      if (!(err instanceof UsageError)) throw err
      invocation = { kind: 'help', json }
      code = usageError(io, json, err.message)
    }
    if (code === 0) {
      await app.whenReady() // safeStorage (the saved password) needs the app to be ready
      setup()
      setWriteOwner(invocation.kind === 'mcp' ? 'mcp' : 'headless')
      initAi()
      const services = mainServices()
      if (invocation.kind === 'mcp')
        await serveMcp(services, {
          allowChanges: invocation.allowChanges,
          log: (line) => process.stderr.write(`${line}\n`),
        })
      else code = await runCli(invocation, services, io)
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    if (json)
      pending.push(
        `${JSON.stringify({ error: { code: 'internal', message: 'Something went wrong inside Ordo.' } })}\n`,
      )
    code = 1
  }

  await writeOut(pending.join(''))
  quit(code)
}
