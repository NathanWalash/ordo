import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  cutRelease,
  nextVersion,
  parseVersion,
  releaseNotes,
  releaseProblems,
  setPackageVersion,
} from './release.mjs'

const CHANGELOG = `# Changelog

All notable changes to Ordo are recorded here.

## [Unreleased]

### Added

- Update notices.

### Fixed

- A crash.

## [0.1.0] - 2026-01-02

### Added

- First release.
`

describe('versions', () => {
  it('parses and compares', () => {
    expect(parseVersion('v1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: ['rc', '1'] })
    expect(parseVersion('1.2')).toBeNull()
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-beta.11', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0)
    expect(() => compareVersions('x', '1.0.0')).toThrow(/Not a version/)
  })

  it('bumps patch, minor and major', () => {
    expect(nextVersion('0.1.4', 'patch')).toBe('0.1.5')
    expect(nextVersion('0.1.4', 'minor')).toBe('0.2.0')
    expect(nextVersion('0.1.4', 'major')).toBe('1.0.0')
    expect(nextVersion('1.0.0-rc.1', 'patch')).toBe('1.0.1')
  })

  it('takes an explicit newer version, with or without v', () => {
    expect(nextVersion('0.1.0', '0.2.0')).toBe('0.2.0')
    expect(nextVersion('0.1.0', 'v0.1.1')).toBe('0.1.1')
    expect(nextVersion('0.1.0', '0.2.0-beta.1')).toBe('0.2.0-beta.1')
  })

  it('releases the current version as is only while it has no tag', () => {
    expect(nextVersion('0.1.0', '0.1.0', { unreleased: true })).toBe('0.1.0')
    expect(() => nextVersion('0.1.0', '0.1.0', { unreleased: false })).toThrow(/isn't newer/)
    expect(() => nextVersion('0.2.0', '0.1.0', { unreleased: true })).toThrow(/isn't newer/)
    expect(nextVersion('0.1.0', 'patch', { unreleased: true })).toBe('0.1.1')
  })

  it('refuses an older, equal or invalid version', () => {
    expect(() => nextVersion('0.2.0', '0.1.9')).toThrow(/isn't newer/)
    expect(() => nextVersion('0.2.0', '0.2.0')).toThrow(/isn't newer/)
    expect(() => nextVersion('0.2.0', '0.2.0-rc.1')).toThrow(/isn't newer/)
    expect(() => nextVersion('0.2.0', 'next')).toThrow(/Not a version/)
    expect(() => nextVersion('banana', 'patch')).toThrow(/invalid version/)
  })
})

describe('releaseNotes', () => {
  it('gives one version’s section without its heading', () => {
    expect(releaseNotes(CHANGELOG, '0.1.0')).toBe('### Added\n\n- First release.')
    expect(releaseNotes(CHANGELOG, 'v0.1.0')).toBe('### Added\n\n- First release.')
  })

  it('stops at the next version and at link definitions', () => {
    const cut = cutRelease(CHANGELOG, '0.2.0', '2026-11-30')
    expect(releaseNotes(cut, '0.2.0')).toBe('### Added\n\n- Update notices.\n\n### Fixed\n\n- A crash.')
    const withLinks = `${CHANGELOG}\n[0.1.0]: https://github.com/NathanWalash/ordo/releases/tag/v0.1.0\n`
    expect(releaseNotes(withLinks, '0.1.0')).toBe('### Added\n\n- First release.')
  })

  it('handles Windows line endings', () => {
    expect(releaseNotes(CHANGELOG.replace(/\n/g, '\r\n'), '0.1.0')).toBe('### Added\n\n- First release.')
  })

  it('gives null for a missing or empty section, and never matches a longer version', () => {
    expect(releaseNotes(CHANGELOG, '9.9.9')).toBeNull()
    expect(releaseNotes(CHANGELOG, '0.1')).toBeNull()
    expect(releaseNotes('## [0.1.0]\n\n## [0.0.1]\n- x\n', '0.1.0')).toBeNull()
    expect(releaseNotes('## [0.1.0] - 2026-01-01\n- ten\n', '0.1.0')).toBe('- ten')
    expect(releaseNotes('## [0.1.00]\n- x\n', '0.1.0')).toBeNull()
  })
})

describe('cutRelease', () => {
  it('moves Unreleased under the new version and leaves an empty Unreleased', () => {
    const out = cutRelease(CHANGELOG, '0.2.0', '2026-11-30')
    expect(out).toBe(`# Changelog

All notable changes to Ordo are recorded here.

## [Unreleased]

## [0.2.0] - 2026-11-30

### Added

- Update notices.

### Fixed

- A crash.

## [0.1.0] - 2026-01-02

### Added

- First release.
`)
  })

  it('works when Unreleased is the only section', () => {
    const out = cutRelease('# Changelog\n\n## [Unreleased]\n\n- One.\n', '0.1.0', '2026-11-30')
    expect(out).toBe('# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-30\n\n- One.\n')
  })

  it('refuses when there is nothing to release, no Unreleased, or the version exists', () => {
    const empty = cutRelease(CHANGELOG, '0.2.0', '2026-11-30')
    expect(() => cutRelease(empty, '0.3.0', '2026-12-01')).toThrow(/Nothing under/)
    expect(() => cutRelease('# Changelog\n', '0.2.0', '2026-11-30')).toThrow(/no "## \[Unreleased\]"/)
    expect(() => cutRelease(CHANGELOG, '0.1.0', '2026-11-30')).toThrow(/already has a section/)
    expect(() => cutRelease(CHANGELOG, '0.2.0', '30/11/2026')).toThrow(/Not a date/)
  })
})

describe('setPackageVersion', () => {
  it('changes only the version, keeping formatting', () => {
    const pkg = '{\n  "name": "@ordo/desktop",\n  "version": "0.1.0",\n  "private": true\n}\n'
    expect(setPackageVersion(pkg, '0.2.0')).toBe(pkg.replace('0.1.0', '0.2.0'))
  })

  it('throws without a version field', () => {
    expect(() => setPackageVersion('{"name":"x"}', '1.0.0')).toThrow(/no "version"/)
  })
})

describe('releaseProblems', () => {
  const ok = { branch: 'main', dirty: false, behind: 0, ahead: 0, tagExists: false, tag: 'v0.2.0' }

  it('is empty for a clean main level with origin', () => {
    expect(releaseProblems(ok)).toEqual([])
  })

  it('lists every problem', () => {
    const p = releaseProblems({
      branch: 'feat/x',
      dirty: true,
      behind: 2,
      ahead: 1,
      tagExists: true,
      tag: 'v0.2.0',
    })
    expect(p).toHaveLength(5)
    expect(p.join('\n')).toMatch(/uncommitted/)
    expect(p.join('\n')).toMatch(/"feat\/x"/)
    expect(p.join('\n')).toMatch(/2 commit\(s\) behind/)
    expect(p.join('\n')).toMatch(/1 commit\(s\) ahead/)
    expect(p.join('\n')).toMatch(/v0\.2\.0 already exists/)
  })
})
