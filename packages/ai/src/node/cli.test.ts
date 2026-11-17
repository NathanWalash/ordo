import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCliProvider, CODEX_DISABLED_FEATURES, CodexCliProvider } from './cli'
import { makeFakeClis } from './fake-cli'
import { CommandResolver } from './process'

// The fake CLIs are `#!/usr/bin/env node` scripts; Windows needs .cmd shims, which aren't covered here.
const posix = process.platform !== 'win32'

describe.skipIf(!posix)('CLI providers (fake CLIs on PATH)', () => {
  const fake = makeFakeClis()
  const logged = () =>
    JSON.parse(readFileSync(fake.log, 'utf8')) as {
      name: string
      args: string[]
      stdin: string
      cwd: string
      files: string[]
      schema?: string
    }
  const schema = { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] }

  beforeEach(() => {
    vi.stubEnv('FAKE_LOG', fake.log)
    vi.stubEnv('FAKE_MODE', 'ok')
    rmSync(fake.log, { force: true })
  })
  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(fake.dir, { recursive: true, force: true })
  })

  describe('ClaudeCliProvider', () => {
    const claude = new ClaudeCliProvider({ resolver: fake.resolver })

    it('detects an installed, signed-in CLI', async () => {
      expect(await claude.detect()).toEqual({
        available: true,
        state: 'ready',
        detail: 'Installed · signed in',
      })
      expect(logged().args).toEqual(['auth', 'status', '--json'])
    })

    it('reports a signed-out CLI', async () => {
      vi.stubEnv('FAKE_MODE', 'signed-out')
      expect(await claude.detect()).toMatchObject({ available: false, state: 'signed-out' })
    })

    it('reports not installed when the command is missing', async () => {
      const none = new ClaudeCliProvider({
        resolver: new CommandResolver({ shell: null, pathEnv: '', fallbackDirs: [] }),
      })
      expect(await none.detect()).toMatchObject({ available: false, state: 'not-installed' })
      await expect(none.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({ code: 'unavailable' })
    })

    it('sends the prompt on stdin with tools off, and reads the structured output', async () => {
      const res = await claude.complete({
        system: 'Sort senders.\nOnly JSON.',
        prompt: 'secret subject line',
        model: 'haiku',
        schema,
      })
      expect(res).toEqual({ text: '{"word":"yes"}', json: { word: 'yes' } })
      const call = logged()
      expect(call.stdin).toBe('secret subject line')
      expect(call.args.join(' ')).not.toContain('secret')
      expect(call.args).toEqual([
        '-p',
        '--output-format',
        'json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--permission-mode',
        'dontAsk',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--system-prompt',
        'Sort senders. Only JSON.',
        '--model',
        'haiku',
        '--json-schema',
        JSON.stringify(schema),
      ])
      expect(call.args.some((a) => /dangerously|bypass|--add-dir|--allowedTools/i.test(a))).toBe(false)
      // Runs in an empty throwaway folder that is removed afterwards.
      expect(call.cwd).toMatch(/ordo-ai-/)
      expect(call.files).toEqual([])
      expect(existsSync(call.cwd)).toBe(false)
    })

    it('falls back to the result text without a schema', async () => {
      expect(await claude.complete({ system: 's', prompt: 'p' })).toEqual({ text: '{"word":"yes"}' })
      expect(logged().args).not.toContain('--model')
    })

    it('turns an error envelope into a failure with its message', async () => {
      vi.stubEnv('FAKE_MODE', 'is-error')
      await expect(claude.complete({ system: 's', prompt: 'p' })).rejects.toThrow(
        'Claude Code failed: Not logged in · Please run /login',
      )
    })

    it("reports a crash with the CLI's error line only, never other output", async () => {
      vi.stubEnv('FAKE_MODE', 'crash')
      await expect(claude.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({
        message: 'Claude Code failed: Error: something broke',
      })
    })

    it('rejects output that is not an envelope', async () => {
      vi.stubEnv('FAKE_MODE', 'not-json')
      await expect(claude.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({
        code: 'bad-response',
      })
    })

    it('kills the CLI when it runs past the timeout', async () => {
      vi.stubEnv('FAKE_MODE', 'hang')
      const started = Date.now()
      await expect(claude.complete({ system: 's', prompt: 'p', timeoutMs: 300 })).rejects.toMatchObject({
        code: 'timeout',
      })
      expect(Date.now() - started).toBeLessThan(3_000)
    })

    it('stops when the caller aborts', async () => {
      vi.stubEnv('FAKE_MODE', 'hang')
      const c = new AbortController()
      setTimeout(() => c.abort(), 200)
      await expect(claude.complete({ system: 's', prompt: 'p', signal: c.signal })).rejects.toMatchObject({
        code: 'aborted',
      })
    })
  })

  describe('CodexCliProvider', () => {
    const codex = new CodexCliProvider({ resolver: fake.resolver })

    it('detects an installed, signed-in CLI', async () => {
      expect(await codex.detect()).toEqual({
        available: true,
        state: 'ready',
        detail: 'Installed · signed in',
      })
    })

    it('reports a signed-out CLI', async () => {
      vi.stubEnv('FAKE_MODE', 'signed-out')
      expect(await codex.detect()).toMatchObject({ available: false, state: 'signed-out' })
    })

    it('runs exec read-only in a scratch folder, with the prompt on stdin and the schema in a file', async () => {
      const res = await codex.complete({ system: 'Sort senders.', prompt: 'secret subject', schema })
      expect(res).toEqual({ text: '{"word":"no"}' })
      const call = logged()
      expect(call.stdin).toBe('Sort senders.\n\nsecret subject')
      expect(call.args.join(' ')).not.toContain('secret')
      expect(JSON.parse(call.schema!)).toEqual(schema)
      const dir = call.args[call.args.indexOf('-C') + 1]!
      expect(call.args).toEqual([
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-user-config',
        ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
        '-c',
        'web_search="disabled"',
        '--color',
        'never',
        '-C',
        dir,
        '--output-schema',
        `${dir}/schema.json`,
        '-o',
        `${dir}/reply.txt`,
        '-',
      ])
      expect(call.args.some((a) => /dangerously|bypass|--add-dir|full-access/i.test(a))).toBe(false)
      expect(call.args).toEqual(
        expect.arrayContaining(['--disable', 'shell_tool', '--disable', 'unified_exec']),
      )
      // The scratch folder is the working root and holds nothing but the schema.
      expect(call.cwd.endsWith(basename(dir))).toBe(true)
      expect(call.files).toEqual(['schema.json'])
      expect(existsSync(dir)).toBe(false)
    })

    it('passes a chosen model but not "default"', async () => {
      await codex.complete({ system: 's', prompt: 'p', model: 'gpt-5.5' })
      expect(logged().args).toContain('-m')
      await codex.complete({ system: 's', prompt: 'p', model: 'default' })
      expect(logged().args).not.toContain('-m')
    })

    it('reports a failed run', async () => {
      vi.stubEnv('FAKE_MODE', 'crash')
      // Codex prints its transcript to stderr; only the error line is used.
      await expect(codex.complete({ system: 's', prompt: 'p' })).rejects.toMatchObject({
        message: 'Codex failed: Error: unexpected argument',
      })
    })
  })
})
