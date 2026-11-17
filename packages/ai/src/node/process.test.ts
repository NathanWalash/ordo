import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CommandResolver, findOnPath, quoteWindowsArg, runProcess } from './process'

const posix = process.platform !== 'win32'
const root = mkdtempSync(join(tmpdir(), 'ordo-path-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function exe(dir: string, name: string, body = '#!/bin/sh\necho hi\n', mode = 0o755) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, body)
  chmodSync(file, mode)
  return file
}

describe('findOnPath', () => {
  it.skipIf(!posix)('finds the first executable match in PATH order', () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    exe(a, 'tool', '', 0o644) // not executable: skipped
    const wanted = exe(b, 'tool')
    exe(join(root, 'c'), 'tool')
    expect(findOnPath('tool', `${a}:${b}:${join(root, 'c')}`, 'linux')).toBe(wanted)
    expect(findOnPath('missing', `${a}:${b}`, 'linux')).toBeNull()
    expect(findOnPath('tool', '', 'linux')).toBeNull()
  })

  it('tries PATHEXT extensions on Windows', () => {
    const dir = join(root, 'win')
    const cmd = exe(dir, 'claude.cmd', '@echo off')
    // Case-insensitive file systems may match an earlier PATHEXT spelling (.CMD).
    expect(findOnPath('claude', dir, 'win32')?.toLowerCase()).toBe(cmd.toLowerCase())
  })
})

describe.skipIf(!posix)('CommandResolver', () => {
  it("asks the login shell for PATH, so Finder-launched apps find the user's CLIs", async () => {
    const hidden = join(root, 'hidden-bin')
    const claude = exe(hidden, 'claude')
    // A stand-in login shell that prints a greeting, then the PATH between the markers.
    const shell = exe(
      join(root, 'shell'),
      'fake-sh',
      `#!/bin/sh\necho "Welcome!"\nPATH='${hidden}' /bin/sh -c "$2"\n`,
    )
    const r = new CommandResolver({ shell, pathEnv: '/usr/bin:/bin', fallbackDirs: [] })
    expect(await r.resolve('claude')).toBe(claude)
    expect(await r.searchPath()).toBe(`${hidden}:/usr/bin:/bin`)
    expect((await r.env())['PATH']).toBe(`${hidden}:/usr/bin:/bin`)
  })

  it('caches results until cleared', async () => {
    const dir = join(root, 'cache-bin')
    const r = new CommandResolver({ shell: null, pathEnv: dir, fallbackDirs: [] })
    expect(await r.resolve('codex')).toBeNull()
    const codex = exe(dir, 'codex')
    expect(await r.resolve('codex')).toBeNull()
    r.clear()
    expect(await r.resolve('codex')).toBe(codex)
  })

  it('falls back to common install folders and survives a broken shell', async () => {
    const fallback = join(root, 'fallback')
    const claude = exe(fallback, 'claude')
    const r = new CommandResolver({
      shell: join(root, 'no-such-shell'),
      pathEnv: '',
      fallbackDirs: [fallback],
    })
    expect(await r.resolve('claude')).toBe(claude)
  })
})

describe('quoteWindowsArg', () => {
  it('quotes and escapes for cmd.exe running an npm .cmd shim', () => {
    // Same escaping as cross-spawn: quote for the C runtime, then ^-escape twice for two cmd.exe passes.
    expect(quoteWindowsArg('plain')).toBe('^^^"plain^^^"')
    expect(quoteWindowsArg('')).toBe('^^^"^^^"')
    expect(quoteWindowsArg('a b')).toBe('^^^"a^^^ b^^^"')
    expect(quoteWindowsArg('{"a":1}')).toBe('^^^"{\\^^^"a\\^^^":1}^^^"')
    expect(quoteWindowsArg('x & del *')).toBe('^^^"x^^^ ^^^&^^^ del^^^ ^^^*^^^"')
    expect(quoteWindowsArg('C:\\dir\\')).toBe('^^^"C:\\dir\\\\^^^"')
  })
})

describe.skipIf(!posix)('runProcess', () => {
  it('pipes stdin and collects output and the exit code', async () => {
    const r = await runProcess('/bin/sh', {
      what: 'sh',
      args: ['-c', 'cat; echo err >&2; exit 3'],
      input: 'hello',
    })
    expect(r).toEqual({ code: 3, stdout: 'hello', stderr: 'err\n' })
  })

  it('reports a missing program as unavailable', async () => {
    await expect(runProcess(join(root, 'nope'), { what: 'Nope', args: [] })).rejects.toMatchObject({
      code: 'unavailable',
      message: "Nope isn't installed.",
    })
  })
})
