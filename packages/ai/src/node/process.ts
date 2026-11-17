import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter as pathDelimiter, extname, join } from 'node:path'
import { deadline } from '../limit'
import { AiError } from '../types'

const MAX_OUTPUT = 10 * 1024 * 1024

export interface RunOptions {
  /** Shown in errors, e.g. "Claude Code". */
  what: string
  args: string[]
  /** Written to stdin, which is then closed. */
  input?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  timeoutMs?: number
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

// cmd.exe metacharacters, escaped with ^ (the approach cross-spawn uses).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** Quote one argument for a `.cmd`/`.bat` shim run through cmd.exe (which then hands it to node). */
export function quoteWindowsArg(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')
  a = `"${a}"`
  // Twice: once for this cmd.exe, once for the one the npm shim starts.
  return a.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

function spawnArgs(file: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = [file.replace(CMD_META, '^$1'), ...args.map(quoteWindowsArg)].join(' ')
    return {
      file: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    }
  }
  return { file, args, verbatim: false }
}

function kill(pid: number | undefined, child: { kill(sig?: NodeJS.Signals): boolean }) {
  if (process.platform === 'win32' && pid) {
    // Kill the whole tree: cmd.exe, the shim and the CLI it started.
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => {},
    )
    return
  }
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 3_000).unref()
}

/** Run a program to completion with a timeout and cancellation. Never uses a shell on macOS/Linux. */
export function runProcess(file: string, opts: RunOptions): Promise<RunResult> {
  const d = deadline(opts.signal, opts.timeoutMs)
  const s = spawnArgs(file, opts.args)
  return new Promise<RunResult>((resolve, reject) => {
    if (d.signal.aborted) return reject(d.signal.reason)
    const child = spawn(s.file, s.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: s.verbatim,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += c
    })
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += c
    })
    const onAbort = () => kill(child.pid, child)
    d.signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err: NodeJS.ErrnoException) => {
      d.signal.removeEventListener('abort', onAbort)
      reject(
        err.code === 'ENOENT'
          ? new AiError('unavailable', `${opts.what} isn't installed.`, { cause: err })
          : new AiError('failed', `Couldn't start ${opts.what}: ${err.message}`, { cause: err }),
      )
    })
    child.on('close', (code) => {
      d.signal.removeEventListener('abort', onAbort)
      if (d.signal.aborted) reject(d.signal.reason)
      else resolve({ code, stdout, stderr })
    })
    child.stdin.on('error', () => {}) // The program may exit without reading stdin.
    child.stdin.end(opts.input ?? '')
  })
    .catch((err: unknown) => {
      throw d.explain(err, opts.what)
    })
    .finally(() => d.dispose())
}

/** Find `name` in a PATH string, the way a shell would (PATHEXT on Windows). */
export function findOnPath(name: string, pathValue: string, platform = process.platform): string | null {
  const exts =
    platform === 'win32'
      ? // Try each PATHEXT entry as written and in lower case: npm installs `claude.cmd`, and
        // case-sensitive file systems (tests on Linux, some Windows dev setups) won't match `.CMD`.
        [
          ...new Set(
            (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
              .split(';')
              .filter(Boolean)
              .flatMap((e) => [e, e.toLowerCase()]),
          ),
        ]
      : ['']
  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    for (const ext of extname(name) ? [''] : exts) {
      const candidate = join(dir, name + ext)
      try {
        if (!statSync(candidate).isFile()) continue
        if (platform !== 'win32') accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here.
      }
    }
  }
  return null
}

const MARK = '__ORDO_PATH__'

export interface ResolverOptions {
  /** Login shell to ask for PATH. Defaults to $SHELL; null skips it. Ignored on Windows. */
  shell?: string | null
  /** PATH of this process. Defaults to process.env.PATH. */
  pathEnv?: string
  /** Folders CLIs are often installed to, searched last. */
  fallbackDirs?: string[]
}

function defaultFallbackDirs(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    return [join(home, '.local', 'bin'), ...(appData ? [join(appData, 'npm')] : [])]
  }
  return [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}

/**
 * Finds CLIs the way the user's terminal would. Apps opened from Finder or the Dock get a bare
 * PATH, so on macOS and Linux this asks the login shell for its PATH; on Windows it uses `where`.
 * Results are cached until `clear()`.
 */
export class CommandResolver {
  private pathPromise: Promise<string> | null = null
  private cache = new Map<string, Promise<string | null>>()

  constructor(private readonly opts: ResolverOptions = {}) {}

  /** The PATH to search and to give spawned CLIs, so `#!/usr/bin/env node` shims work too. */
  searchPath(): Promise<string> {
    return (this.pathPromise ??= this.computePath())
  }

  resolve(name: string): Promise<string | null> {
    let hit = this.cache.get(name)
    if (!hit) {
      hit = this.lookup(name)
      this.cache.set(name, hit)
    }
    return hit
  }

  /** Environment for a spawned CLI: this process's env with the full PATH. */
  async env(): Promise<NodeJS.ProcessEnv> {
    return { ...process.env, PATH: await this.searchPath() }
  }

  clear(): void {
    this.cache.clear()
    this.pathPromise = null
  }

  private async lookup(name: string): Promise<string | null> {
    if (process.platform === 'win32') {
      const r = await runProcess('where', { what: 'where', args: [name], timeoutMs: 5_000 }).catch(() => null)
      const exts = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
      const found = r?.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => exts.includes(extname(l).toLowerCase()))
      if (found) return found
    }
    return findOnPath(name, await this.searchPath())
  }

  private async computePath(): Promise<string> {
    const own = this.opts.pathEnv ?? process.env['PATH'] ?? ''
    const parts: string[] = []
    const shell = this.opts.shell === undefined ? process.env['SHELL'] : this.opts.shell
    if (process.platform !== 'win32' && shell) {
      const r = await runProcess(shell, {
        what: 'shell',
        // -i as well as -l: many people set PATH in .zshrc / .bashrc, which only interactive shells read.
        args: ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`],
        timeoutMs: 5_000,
      }).catch(() => null)
      const m = r && new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(r.stdout)
      if (m?.[1]) parts.push(m[1])
    }
    parts.push(own, ...(this.opts.fallbackDirs ?? defaultFallbackDirs()))
    const seen = new Set<string>()
    const dirs = parts
      .flatMap((p) => p.split(pathDelimiter))
      .filter((d) => d && !seen.has(d) && (seen.add(d), true))
    return dirs.join(pathDelimiter)
  }
}
