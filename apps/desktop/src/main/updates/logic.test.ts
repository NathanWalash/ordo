import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  DAY_MS,
  decideUpdate,
  downloadUrlFor,
  formatVersion,
  isAllowedReleaseUrl,
  isNewer,
  parseVersion,
  pickAsset,
  shouldAutoCheck,
  summariseNotes,
  type ReleaseAsset,
} from './logic'

const v = (s: string) => {
  const parsed = parseVersion(s)
  if (!parsed) throw new Error(`bad version ${s}`)
  return parsed
}

describe('parseVersion', () => {
  it('reads plain, v-prefixed, pre-release and build versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(parseVersion('v0.10.0')).toEqual({ major: 0, minor: 10, patch: 0, pre: [] })
    expect(parseVersion('1.0.0-beta.2+exp.sha.5114f85')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      pre: ['beta', '2'],
    })
    expect(parseVersion(' 2.0.0 ')).not.toBeNull()
  })

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    '01.2.3',
    '1.02.3',
    'v',
    'latest',
    '1.2.3-',
    '1.2.3-01',
    'x1.2.3',
    '1.2.3 beta',
  ])('refuses %j', (s) => expect(parseVersion(s)).toBeNull())

  it('refuses numbers too big to compare exactly', () => {
    expect(parseVersion('99999999999999999999.0.0')).toBeNull()
  })

  it('formats without the v and build metadata', () => {
    expect(formatVersion(v('v1.2.3-rc.1+build'))).toBe('1.2.3-rc.1')
  })
})

describe('compareVersions', () => {
  // The precedence example from semver.org, in order.
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
    '1.0.1',
    '1.1.0',
    '1.10.0',
    '2.0.0',
  ]

  it('follows Semantic Versioning precedence', () => {
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(v(ordered[i]!), v(ordered[i + 1]!)), `${ordered[i]} < ${ordered[i + 1]}`).toBe(
        -1,
      )
      expect(compareVersions(v(ordered[i + 1]!), v(ordered[i]!))).toBe(1)
    }
  })

  it('ignores build metadata and the v', () => {
    expect(compareVersions(v('v1.2.3+a'), v('1.2.3+b'))).toBe(0)
  })

  it('compares numerically, not as text', () => {
    expect(compareVersions(v('0.10.0'), v('0.9.9'))).toBe(1)
  })
})

describe('isNewer', () => {
  it('is true only for a strictly newer valid version', () => {
    expect(isNewer('v0.2.0', '0.1.0')).toBe(true)
    expect(isNewer('0.1.0', '0.1.0')).toBe(false)
    expect(isNewer('0.0.9', '0.1.0')).toBe(false)
    expect(isNewer('nonsense', '0.1.0')).toBe(false)
    expect(isNewer('0.2.0', 'nonsense')).toBe(false)
  })
})

describe('isAllowedReleaseUrl', () => {
  it.each([
    'https://github.com/NathanWalash/ordo/releases/download/v0.2.0/Ordo-0.2.0-mac-arm64.dmg',
    'https://github.com/NathanWalash/ordo/releases/tag/v0.2.0',
    'https://github.com/nathanwalash/ORDO/releases/tag/v0.2.0',
    'https://objects.githubusercontent.com/github-production-release-asset/123/abc?X-Amz=1',
  ])('allows %s', (url) => expect(isAllowedReleaseUrl(url)).toBe(true))

  it.each([
    ['http, not https', 'http://github.com/NathanWalash/ordo/releases/tag/v0.2.0'],
    ['another repository', 'https://github.com/someone/ordo/releases/download/v1/evil.dmg'],
    ['a repository page that is not a release', 'https://github.com/NathanWalash/ordo/blob/main/x'],
    ['a look-alike host', 'https://github.com.evil.example/NathanWalash/ordo/releases/tag/v1'],
    ['a subdomain', 'https://evil.github.com/NathanWalash/ordo/releases/tag/v1'],
    ['user info', 'https://github.com@evil.example/NathanWalash/ordo/releases/tag/v1'],
    ['credentials', 'https://me:pw@github.com/NathanWalash/ordo/releases/tag/v1'],
    ['a port', 'https://github.com:8443/NathanWalash/ordo/releases/tag/v1'],
    ['dot segments', 'https://github.com/NathanWalash/ordo/releases/%2e%2e/%2e%2e/evil/x'],
    ['an encoded slash', 'https://github.com/NathanWalash/ordo/releases/..%2F..%2Fevil'],
    ['a file URL', 'file:///Applications/Ordo.app'],
    ['javascript', 'javascript:alert(1)'],
    ['not a URL', 'not a url'],
    ['the API host', 'https://api.github.com/repos/NathanWalash/ordo/releases/latest'],
  ])('refuses %s', (_why, url) => expect(isAllowedReleaseUrl(url)).toBe(false))
})

const dl = (name: string): ReleaseAsset => ({
  name,
  browser_download_url: `https://github.com/NathanWalash/ordo/releases/download/v0.2.0/${name}`,
})
const ALL = [
  dl('Ordo-0.2.0-mac-arm64.dmg'),
  dl('Ordo-0.2.0-mac-arm64.dmg.blockmap'),
  dl('Ordo-0.2.0-mac-x64.dmg'),
  dl('Ordo-0.2.0-win-x64.exe'),
  dl('Ordo-0.2.0-win-x64.exe.blockmap'),
  dl('Ordo-0.2.0-linux-x86_64.AppImage'),
  dl('latest-mac.yml'),
  dl('latest.yml'),
]

describe('pickAsset', () => {
  it.each([
    ['darwin', 'arm64', 'Ordo-0.2.0-mac-arm64.dmg'],
    ['darwin', 'x64', 'Ordo-0.2.0-mac-x64.dmg'],
    ['win32', 'x64', 'Ordo-0.2.0-win-x64.exe'],
    ['win32', 'arm64', 'Ordo-0.2.0-win-x64.exe'],
    ['linux', 'x64', 'Ordo-0.2.0-linux-x86_64.AppImage'],
  ])('%s %s gets %s', (platform, arch, name) => {
    expect(pickAsset(ALL, platform, arch)?.name).toBe(name)
  })

  it('prefers a native Windows on Arm installer when there is one', () => {
    expect(pickAsset([...ALL, dl('Ordo-0.2.0-win-arm64.exe')], 'win32', 'arm64')?.name).toBe(
      'Ordo-0.2.0-win-arm64.exe',
    )
  })

  it('gives null when there is nothing for this computer', () => {
    expect(pickAsset(ALL, 'linux', 'arm64')).toBeNull()
    expect(pickAsset(ALL, 'darwin', 'ia32')).toBeNull()
    expect(pickAsset(ALL, 'freebsd', 'x64')).toBeNull()
    expect(pickAsset([], 'darwin', 'arm64')).toBeNull()
  })

  it('never picks the Intel DMG for Apple silicon or the other way round', () => {
    expect(pickAsset([dl('Ordo-0.2.0-mac-x64.dmg')], 'darwin', 'arm64')).toBeNull()
    expect(pickAsset([dl('Ordo-0.2.0-mac-arm64.dmg')], 'darwin', 'x64')).toBeNull()
  })

  it('skips an asset whose download URL is off GitHub', () => {
    const evil = { name: 'Ordo-0.2.0-mac-arm64.dmg', browser_download_url: 'https://evil.example/Ordo.dmg' }
    expect(pickAsset([evil], 'darwin', 'arm64')).toBeNull()
    expect(
      pickAsset([evil, dl('Ordo-0.2.0-mac-arm64.dmg')], 'darwin', 'arm64')?.browser_download_url,
    ).toMatch(/^https:\/\/github\.com\//)
  })
})

describe('summariseNotes', () => {
  it('turns Markdown into short plain text', () => {
    const body = [
      '## [0.2.0] - 2026-11-30',
      '',
      '### Added',
      '',
      '- **Updates**: Ordo tells you about a [new release](https://example.com).',
      '- `pnpm install-app` <b>builds</b> from source. ![shot](https://x/y.png)',
    ].join('\n')
    expect(summariseNotes(body)).toBe(
      '[0.2.0] - 2026-11-30\n\nAdded\n\n• Updates: Ordo tells you about a new release.\n• pnpm install-app builds from source.',
    )
  })

  it('cuts long notes at a word with an ellipsis', () => {
    const s = summariseNotes('word '.repeat(200), 50)
    expect(s.length).toBeLessThanOrEqual(51)
    expect(s.endsWith('word…')).toBe(true)
  })

  it('collapses runs of blank lines and handles empty notes', () => {
    expect(summariseNotes('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb')
    expect(summariseNotes(null)).toBe('')
    expect(summariseNotes(undefined)).toBe('')
    expect(summariseNotes('')).toBe('')
  })
})

describe('shouldAutoCheck', () => {
  const now = new Date('2026-11-23T12:00:00Z')
  const base = { packaged: true, checksEnabled: true, lastCheckedAt: null, now }

  it('checks an installed build that has never checked', () => {
    expect(shouldAutoCheck(base)).toBe(true)
  })

  it('never checks on its own in development or when turned off', () => {
    expect(shouldAutoCheck({ ...base, packaged: false })).toBe(false)
    expect(shouldAutoCheck({ ...base, checksEnabled: false })).toBe(false)
  })

  it('checks at most once a day', () => {
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString()
    expect(shouldAutoCheck({ ...base, lastCheckedAt: at(DAY_MS - 1000) })).toBe(false)
    expect(shouldAutoCheck({ ...base, lastCheckedAt: at(60_000) })).toBe(false)
    expect(shouldAutoCheck({ ...base, lastCheckedAt: at(DAY_MS) })).toBe(true)
    expect(shouldAutoCheck({ ...base, lastCheckedAt: at(10 * DAY_MS) })).toBe(true)
  })

  it('treats a time in the future or an unreadable one as never checked', () => {
    expect(shouldAutoCheck({ ...base, lastCheckedAt: '2030-01-01T00:00:00Z' })).toBe(true)
    expect(shouldAutoCheck({ ...base, lastCheckedAt: 'yesterday' })).toBe(true)
  })
})

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.2.0',
  name: 'Ordo 0.2.0',
  html_url: 'https://github.com/NathanWalash/ordo/releases/tag/v0.2.0',
  body: '### Added\n\n- Update notices.',
  draft: false,
  prerelease: false,
  assets: ALL,
  ...over,
})
const opts = { currentVersion: '0.1.0', skippedVersion: null, platform: 'darwin', arch: 'arm64' }

describe('decideUpdate', () => {
  it('offers a newer release with the right installer and notes', () => {
    expect(decideUpdate(release(), opts)).toEqual({
      status: 'available',
      version: '0.2.0',
      notes: 'Added\n\n• Update notices.',
      releaseUrl: 'https://github.com/NathanWalash/ordo/releases/tag/v0.2.0',
      assetName: 'Ordo-0.2.0-mac-arm64.dmg',
      skipped: false,
    })
  })

  it('says up to date for the same or an older version', () => {
    expect(decideUpdate(release(), { ...opts, currentVersion: '0.2.0' })).toEqual({
      status: 'up-to-date',
      latest: '0.2.0',
    })
    expect(decideUpdate(release(), { ...opts, currentVersion: '0.3.0-beta.1' }).status).toBe('up-to-date')
  })

  it('offers the release to someone on its pre-release', () => {
    expect(decideUpdate(release(), { ...opts, currentVersion: '0.2.0-rc.1' }).status).toBe('available')
  })

  it('ignores drafts and pre-releases', () => {
    expect(decideUpdate(release({ draft: true }), opts).status).toBe('up-to-date')
    expect(decideUpdate(release({ prerelease: true }), opts).status).toBe('up-to-date')
    expect(decideUpdate(release({ tag_name: 'v0.3.0-beta.1' }), opts).status).toBe('up-to-date')
  })

  it('marks a skipped version, and only that one', () => {
    expect(decideUpdate(release(), { ...opts, skippedVersion: '0.2.0' })).toMatchObject({ skipped: true })
    expect(decideUpdate(release(), { ...opts, skippedVersion: '0.1.5' })).toMatchObject({ skipped: false })
    expect(decideUpdate(release({ tag_name: 'v0.3.0' }), { ...opts, skippedVersion: '0.2.0' })).toMatchObject(
      {
        version: '0.3.0',
        skipped: false,
      },
    )
  })

  it('still offers the release page when there is no installer for this computer', () => {
    expect(decideUpdate(release(), { ...opts, platform: 'linux', arch: 'arm64' })).toMatchObject({
      status: 'available',
      assetName: null,
    })
  })

  it('refuses a release page that is not on github.com', () => {
    expect(decideUpdate(release({ html_url: 'https://evil.example/r' }), opts).status).toBe('error')
  })

  it('reports an unreadable answer or tag', () => {
    expect(decideUpdate({ message: 'Not Found' }, opts).status).toBe('error')
    expect(decideUpdate(null, opts).status).toBe('error')
    expect(decideUpdate(release({ tag_name: 'nightly' }), opts)).toMatchObject({ status: 'error' })
  })

  it('skips malformed assets instead of failing', () => {
    const r = release({ assets: [42, { name: 'x' }, dl('Ordo-0.2.0-mac-arm64.dmg')] })
    expect(decideUpdate(r, opts)).toMatchObject({ assetName: 'Ordo-0.2.0-mac-arm64.dmg' })
  })
})

describe('downloadUrlFor', () => {
  it('gives the installer for this computer', () => {
    expect(downloadUrlFor(release(), 'win32', 'x64')).toBe(
      'https://github.com/NathanWalash/ordo/releases/download/v0.2.0/Ordo-0.2.0-win-x64.exe',
    )
  })

  it('falls back to the release page', () => {
    expect(downloadUrlFor(release({ assets: [] }), 'darwin', 'arm64')).toBe(
      'https://github.com/NathanWalash/ordo/releases/tag/v0.2.0',
    )
  })

  it('gives null rather than an unsafe URL', () => {
    expect(
      downloadUrlFor(release({ assets: [], html_url: 'https://evil.example' }), 'darwin', 'arm64'),
    ).toBeNull()
    expect(downloadUrlFor('garbage', 'darwin', 'arm64')).toBeNull()
  })
})
