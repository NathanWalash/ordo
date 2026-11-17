import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AiError,
  type CompleteRequest,
  type CompleteResult,
  type DetectResult,
  type ModelProvider,
} from '../types'
import { CommandResolver, runProcess, type RunResult } from './process'

const DEFAULT_TIMEOUT_MS = 180_000
const STATUS_TIMEOUT_MS = 15_000

export interface CliProviderOptions {
  resolver?: CommandResolver
  /** Use this executable instead of looking the command up on PATH. */
  command?: string
}

const sharedResolver = new CommandResolver()

/** Run in an empty, throwaway folder so the CLI can't see (or pick up settings from) any project. */
async function inScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ordo-ai-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The last few lines of a CLI's error output, for an error message. */
function tail(r: RunResult): string {
  const text = (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).slice(-3).join(' ')
  return text.slice(0, 300) || `exit code ${r.code}`
}

/** Prompts in argv must stay on one line for Windows .cmd shims. */
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

abstract class CliProvider implements ModelProvider {
  abstract readonly id: 'claude-cli' | 'codex-cli'
  abstract readonly label: string
  readonly kind = 'cloud' as const
  protected abstract readonly commandName: string
  protected readonly resolver: CommandResolver

  constructor(protected readonly opts: CliProviderOptions = {}) {
    this.resolver = opts.resolver ?? sharedResolver
  }

  abstract detect(): Promise<DetectResult>
  abstract listModels(): Promise<string[]>
  abstract complete(req: CompleteRequest): Promise<CompleteResult>

  protected async bin(): Promise<string | null> {
    return this.opts.command ?? (await this.resolver.resolve(this.commandName))
  }

  protected async run(args: string[], extra: Partial<Parameters<typeof runProcess>[1]> = {}) {
    const bin = await this.bin()
    if (!bin) throw new AiError('unavailable', `${this.label} isn't installed.`)
    return runProcess(bin, { what: this.label, args, env: await this.resolver.env(), ...extra })
  }
}

const ClaudeEnvelope = z.object({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
})

/**
 * Claude Code in print mode (`claude -p`), using the user's own Claude login.
 *
 * Flags (checked against `claude --help`, v2.1): `--output-format json` gives one result envelope;
 * `--tools ""` turns every built-in tool off; `--strict-mcp-config` with no `--mcp-config` loads no
 * MCP servers; `--system-prompt` replaces Claude Code's own; `--json-schema` asks for structured
 * output, returned as `structured_output`. The prompt goes in on stdin, never in argv.
 */
export class ClaudeCliProvider extends CliProvider {
  readonly id = 'claude-cli' as const
  readonly label = 'Claude Code'
  protected readonly commandName = 'claude'

  async detect(): Promise<DetectResult> {
    if (!(await this.bin()))
      return { available: false, state: 'not-installed', detail: 'Not installed. Install Claude Code first.' }
    try {
      const r = await this.run(['auth', 'status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS })
      const status = z.object({ loggedIn: z.boolean() }).safeParse(JSON.parse(r.stdout))
      if (status.success && !status.data.loggedIn)
        return {
          available: false,
          state: 'signed-out',
          detail: 'Not signed in. Run `claude` in Terminal and sign in.',
        }
      if (status.success) return { available: true, state: 'ready', detail: 'Installed · signed in' }
    } catch {
      // Older versions have no `auth status`; a real request will tell.
    }
    return { available: true, state: 'ready', detail: 'Installed' }
  }

  async listModels(): Promise<string[]> {
    // Claude Code takes aliases for the latest model in each family.
    return ['haiku', 'sonnet', 'opus']
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--system-prompt',
      oneLine(req.system),
      ...(req.model ? ['--model', req.model] : []),
      ...(req.schema ? ['--json-schema', JSON.stringify(req.schema)] : []),
    ]
    const r = await inScratchDir((cwd) =>
      this.run(args, {
        cwd,
        input: req.prompt,
        signal: req.signal,
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }),
    )
    let envelope: z.infer<typeof ClaudeEnvelope> | null = null
    try {
      const parsed = ClaudeEnvelope.safeParse(JSON.parse(r.stdout))
      if (parsed.success) envelope = parsed.data
    } catch {
      // Not JSON: fall through to the exit code.
    }
    if (!envelope) {
      if (r.code !== 0) throw new AiError('failed', `Claude Code failed: ${tail(r)}`)
      throw new AiError('bad-response', "Claude Code's reply wasn't in the expected format.")
    }
    if (envelope.is_error || envelope.subtype !== 'success')
      throw new AiError('failed', `Claude Code failed: ${envelope.result?.slice(0, 300) || envelope.subtype}`)
    const json = envelope.structured_output
    const text = envelope.result ?? (json === undefined ? '' : JSON.stringify(json))
    return json === undefined ? { text } : { text, json }
  }
}

/**
 * OpenAI Codex CLI (`codex exec`), using the user's own ChatGPT login.
 *
 * Flags (checked against `codex exec --help`, v0.146): `--sandbox read-only` so it can't change
 * anything; `-C` an empty scratch folder; `--skip-git-repo-check` because that folder isn't a repo;
 * `--ephemeral` keeps no session; `--ignore-user-config` skips the user's MCP servers and profiles
 * (sign-in still works); `--output-schema` takes a JSON Schema file; `-o` writes the final message
 * to a file. The prompt goes in on stdin (`-`). Codex has no system prompt flag, so the
 * instructions lead the prompt.
 */
export class CodexCliProvider extends CliProvider {
  readonly id = 'codex-cli' as const
  readonly label = 'Codex'
  protected readonly commandName = 'codex'

  async detect(): Promise<DetectResult> {
    if (!(await this.bin()))
      return {
        available: false,
        state: 'not-installed',
        detail: 'Not installed. Install the Codex CLI first.',
      }
    try {
      const r = await this.run(['login', 'status'], { timeoutMs: STATUS_TIMEOUT_MS })
      const said = `${r.stdout}\n${r.stderr}`
      if (r.code === 0 && /logged in/i.test(said) && !/not logged in/i.test(said))
        return { available: true, state: 'ready', detail: 'Installed · signed in' }
      return {
        available: false,
        state: 'signed-out',
        detail: 'Not signed in. Run `codex login` in Terminal.',
      }
    } catch (err) {
      return { available: false, state: 'error', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  async listModels(): Promise<string[]> {
    // Codex has no command to list models; `default` uses whatever the account defaults to.
    return ['default']
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    return inScratchDir(async (dir) => {
      const out = join(dir, 'reply.txt')
      const schemaFile = join(dir, 'schema.json')
      if (req.schema) await writeFile(schemaFile, JSON.stringify(req.schema))
      const args = [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        '--color',
        'never',
        '-C',
        dir,
        ...(req.model && req.model !== 'default' ? ['-m', req.model] : []),
        ...(req.schema ? ['--output-schema', schemaFile] : []),
        '-o',
        out,
        '-',
      ]
      const r = await this.run(args, {
        cwd: dir,
        input: `${req.system}\n\n${req.prompt}`,
        signal: req.signal,
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      })
      if (r.code !== 0) throw new AiError('failed', `Codex failed: ${tail(r)}`)
      const text = (await readFile(out, 'utf8').catch(() => r.stdout)).trim()
      if (!text) throw new AiError('bad-response', 'Codex returned an empty reply.')
      return { text }
    })
  }
}
