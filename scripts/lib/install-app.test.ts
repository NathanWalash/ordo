import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLE_ID,
  builderArgs,
  builtAppPath,
  builtAppProblem,
  destinationProblem,
  expandHome,
  macOutputDir,
  parseArgs,
  preflight,
  swapInApp,
  swapPaths,
} from './install-app.mjs'

describe('parseArgs', () => {
  it('has safe defaults', () => {
    expect(parseArgs([])).toEqual({
      allowBranch: false,
      allowDirty: false,
      pull: true,
      dest: null,
      keepPrevious: false,
      open: true,
      help: false,
      errors: [],
    })
  })

  it('reads every flag, and --dest either way', () => {
    const o = parseArgs([
      '--',
      '--allow-branch',
      '--allow-dirty',
      '--no-pull',
      '--keep-previous',
      '--no-open',
    ])
    expect(o).toMatchObject({
      allowBranch: true,
      allowDirty: true,
      pull: false,
      keepPrevious: true,
      open: false,
    })
    expect(parseArgs(['--dest', '/Users/me/Applications']).dest).toBe('/Users/me/Applications')
    expect(parseArgs(['--dest=~/Applications']).dest).toBe('~/Applications')
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('reports unknown options and a missing --dest value', () => {
    expect(parseArgs(['--force']).errors).toEqual(['Unknown option --force'])
    expect(parseArgs(['--dest']).errors).toEqual(['--dest needs a folder.'])
    expect(parseArgs(['--dest', '--no-pull']).errors).toEqual(['--dest needs a folder.'])
  })
})

describe('preflight', () => {
  const flags = { allowBranch: false, allowDirty: false, pull: true }
  const base = { platform: 'darwin', arch: 'arm64', branch: 'main', dirty: false, flags }

  it('pulls a clean main with no warnings', () => {
    expect(preflight(base)).toEqual({ errors: [], warnings: [], pull: true })
  })

  it('refuses another branch unless allowed, and then does not pull it', () => {
    expect(preflight({ ...base, branch: 'feat/x' }).errors.join()).toMatch(/--allow-branch/)
    const allowed = preflight({ ...base, branch: 'feat/x', flags: { ...flags, allowBranch: true } })
    expect(allowed.errors).toEqual([])
    expect(allowed.pull).toBe(false)
    expect(allowed.warnings.join('\n')).toMatch(/Building "feat\/x"/)
  })

  it('refuses uncommitted changes unless allowed, and then does not pull', () => {
    expect(preflight({ ...base, dirty: true }).errors.join()).toMatch(/--allow-dirty/)
    const allowed = preflight({ ...base, dirty: true, flags: { ...flags, allowDirty: true } })
    expect(allowed.errors).toEqual([])
    expect(allowed.pull).toBe(false)
    expect(allowed.warnings.join('\n')).toMatch(/uncommitted/)
  })

  it('honours --no-pull without a warning', () => {
    expect(preflight({ ...base, flags: { ...flags, pull: false } })).toEqual({
      errors: [],
      warnings: [],
      pull: false,
    })
  })

  it('refuses unsupported platforms and processors', () => {
    expect(preflight({ ...base, platform: 'freebsd' }).errors).toHaveLength(1)
    expect(preflight({ ...base, arch: 'ia32' }).errors).toHaveLength(1)
  })
})

describe('build paths', () => {
  it('builds unpacked for this platform and arch only, never publishing', () => {
    expect(builderArgs('darwin', 'arm64')).toEqual(['--dir', '--publish', 'never', '--mac', '--arm64'])
    expect(builderArgs('win32', 'x64')).toEqual(['--dir', '--publish', 'never', '--win', '--x64'])
    expect(() => builderArgs('aix', 'x64')).toThrow()
    expect(() => builderArgs('darwin', 'ia32')).toThrow()
  })

  it('knows where electron-builder puts the unpacked app', () => {
    expect(macOutputDir('arm64')).toBe('mac-arm64')
    expect(macOutputDir('x64')).toBe('mac')
    expect(macOutputDir('ppc')).toBeNull()
    expect(builtAppPath('/r', '0.2.0', 'darwin', 'arm64')).toBe(join('/r', '0.2.0', 'mac-arm64', 'Ordo.app'))
    expect(builtAppPath('/r', '0.2.0', 'darwin', 'x64')).toBe(join('/r', '0.2.0', 'mac', 'Ordo.app'))
    expect(builtAppPath('/r', '0.2.0', 'win32', 'x64')).toBe(join('/r', '0.2.0', 'win-unpacked'))
    expect(builtAppPath('/r', '0.2.0', 'linux', 'x64')).toBe(join('/r', '0.2.0', 'linux-unpacked'))
    expect(builtAppPath('/r', '0.2.0', 'aix', 'x64')).toBeNull()
  })
})

describe('destinationProblem', () => {
  const home = '/Users/me'

  it('allows /Applications and ~/Applications', () => {
    expect(destinationProblem('/Applications', home)).toBeNull()
    expect(destinationProblem('/Applications/', home)).toBeNull()
    expect(destinationProblem('/Users/me/Applications', home)).toBeNull()
  })

  it('refuses relative paths and folders that are not Applications', () => {
    expect(destinationProblem('Applications', home)).toMatch(/full path/)
    expect(destinationProblem('/Users/me/Desktop', home)).toMatch(/Applications folder/)
    expect(destinationProblem('/', home)).toMatch(/Applications folder/)
  })

  it('never installs anywhere under ~/Library, where the profile lives', () => {
    expect(destinationProblem('/Users/me/Library/Application Support/Ordo/Applications', home)).toMatch(
      /Library/,
    )
    expect(destinationProblem('/Users/me/Library/Applications', home)).toMatch(/Library/)
    expect(destinationProblem('/Users/me/x/../Library/Applications', home)).toMatch(/Library/)
  })

  it('expands ~ for a --dest the shell left alone', () => {
    expect(expandHome('~/Applications', home)).toBe('/Users/me/Applications')
    expect(expandHome('~', home)).toBe(home)
    expect(expandHome('/Applications', home)).toBe('/Applications')
    expect(expandHome('~other/Applications', home)).toBe('~other/Applications')
  })
})

describe('builtAppProblem', () => {
  it('accepts the Ordo just built and refuses anything else', () => {
    expect(builtAppProblem({ bundleId: BUNDLE_ID, version: '0.2.0' }, '0.2.0')).toBeNull()
    expect(builtAppProblem({ bundleId: 'com.github.Electron', version: '0.2.0' }, '0.2.0')).toMatch(
      /identifier/,
    )
    expect(builtAppProblem({ bundleId: BUNDLE_ID, version: '0.1.0' }, '0.2.0')).toMatch(/version 0\.1\.0/)
    expect(builtAppProblem({ bundleId: null, version: null }, '0.2.0')).not.toBeNull()
  })
})

describe('swapInApp', () => {
  let dir: string
  let dest: string
  let built: string
  let profile: string

  /** A fake app bundle whose version file says which build it is. */
  const makeApp = (path: string, version: string) => {
    mkdirSync(join(path, 'Contents'), { recursive: true })
    writeFileSync(join(path, 'Contents', 'version'), version)
  }
  const versionAt = (path: string) => readFileSync(join(path, 'Contents', 'version'), 'utf8')
  const copy = (from: string, to: string) => cpSync(from, to, { recursive: true })
  const deps = () => ({ built, dest, copy, clearQuarantine: vi.fn(), verify: vi.fn() })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ordo-install-app-'))
    dest = join(dir, 'Applications')
    mkdirSync(dest)
    built = join(dir, 'release', 'mac-arm64', 'Ordo.app')
    makeApp(built, 'new')
    // Stands in for the profile: the swap must never touch anything outside the three app paths.
    profile = join(dir, 'Library', 'Application Support', 'Ordo')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'settings.json'), '{"theme":"dark"}')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('installs into an empty Applications folder', () => {
    const d = deps()
    expect(swapInApp(d)).toEqual({ target: join(dest, 'Ordo.app'), previous: null })
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('new')
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
    expect(versionAt(built)).toBe('new')
  })

  it('replaces the installed app and removes the previous one after success', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    swapInApp(deps())
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('new')
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
  })

  it('keeps the previous app when asked', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    const r = swapInApp({ ...deps(), keepPrevious: true })
    expect(r.previous).toBe(join(dest, 'Ordo.app.previous'))
    expect(versionAt(join(dest, 'Ordo.app.previous'))).toBe('old')
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('new')
  })

  it('clears quarantine and verifies only the new copy, before touching the installed app', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    const { staging } = swapPaths(dest)
    const d = deps()
    d.verify.mockImplementation((path: string) => {
      expect(path).toBe(staging)
      expect(versionAt(join(dest, 'Ordo.app'))).toBe('old')
    })
    swapInApp(d)
    expect(d.clearQuarantine).toHaveBeenCalledTimes(1)
    expect(d.clearQuarantine).toHaveBeenCalledWith(staging)
    expect(d.verify).toHaveBeenCalledTimes(1)
  })

  it('leaves the installed app alone when the new copy fails its check', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    const d = deps()
    d.verify.mockImplementation(() => {
      throw new Error('wrong version')
    })
    expect(() => swapInApp(d)).toThrow('wrong version')
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('old')
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
  })

  it('puts the previous app back if the new one can’t be moved into place', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    const rename = vi.fn(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    expect(() => swapInApp({ ...deps(), rename })).toThrow('EPERM')
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('old')
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
  })

  it('cleans up a leftover temp copy from an earlier run', () => {
    makeApp(swapPaths(dest).staging, 'half-copied')
    swapInApp(deps())
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('new')
  })

  it('recovers when an earlier run stopped with only Ordo.app.previous left', () => {
    makeApp(join(dest, 'Ordo.app.previous'), 'old')
    const d = deps()
    // The only copy of the old app must survive until the new one is in place.
    d.verify.mockImplementation(() => expect(existsSync(join(dest, 'Ordo.app.previous'))).toBe(true))
    swapInApp(d)
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('new')
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
  })

  it('recovers when an earlier run stopped with both Ordo.app and Ordo.app.previous', () => {
    makeApp(join(dest, 'Ordo.app'), 'mid')
    makeApp(join(dest, 'Ordo.app.previous'), 'old')
    swapInApp({ ...deps(), keepPrevious: true })
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('new')
    expect(versionAt(join(dest, 'Ordo.app.previous'))).toBe('mid')
  })

  it('is safe to run twice in a row', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    swapInApp(deps())
    swapInApp(deps())
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
    expect(versionAt(join(dest, 'Ordo.app'))).toBe('new')
  })

  it('fails clearly when there is no build, changing nothing', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    expect(() => swapInApp({ ...deps(), built: join(dir, 'missing.app') })).toThrow(/no built app/)
    expect(readdirSync(dest)).toEqual(['Ordo.app'])
  })

  it('never touches the profile folder', () => {
    makeApp(join(dest, 'Ordo.app'), 'old')
    swapInApp(deps())
    swapInApp({ ...deps(), keepPrevious: true })
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readdirSync(profile)).toEqual(['settings.json'])
  })
})
