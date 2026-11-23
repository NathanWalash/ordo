import { describe, expect, it, vi } from 'vitest'
import { LATEST_RELEASE_URL } from './logic'
import { createGitHubUpdater, type GitHubUpdaterDeps, type UpdateFetch } from './updater'

const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/NathanWalash/ordo/releases/tag/v0.2.0',
  body: '- Faster.',
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'Ordo-0.2.0-mac-arm64.dmg',
      browser_download_url:
        'https://github.com/NathanWalash/ordo/releases/download/v0.2.0/Ordo-0.2.0-mac-arm64.dmg',
    },
  ],
}

const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn<UpdateFetch>(async () => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }))

function setup(fetch: UpdateFetch, over: Partial<GitHubUpdaterDeps> = {}) {
  const openExternal = vi.fn(async (_url: string) => {})
  const deps: GitHubUpdaterDeps = {
    fetch,
    refuse: () => null,
    openExternal,
    currentVersion: '0.1.0',
    skippedVersion: () => null,
    platform: 'darwin',
    arch: 'arm64',
    ...over,
  }
  return { updater: createGitHubUpdater(deps), openExternal }
}

describe('GitHub updater', () => {
  it('asks GitHub for the latest release and nothing else, sending no identifying details', async () => {
    const fetch = respond(200, RELEASE)
    const { updater } = setup(fetch)
    expect(await updater.check()).toMatchObject({ status: 'available', version: '0.2.0' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.github.com/repos/NathanWalash/ordo/releases/latest')
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(init.credentials).toBe('omit')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(init.headers).sort()).toEqual(['Accept', 'User-Agent', 'X-GitHub-Api-Version'])
    expect(init.headers['User-Agent']).toBe('Ordo')
    expect(JSON.stringify(init)).not.toContain('0.1.0')
  })

  it('opens the installer for this computer, only after a check found one', async () => {
    const { updater, openExternal } = setup(respond(200, RELEASE))
    expect(await updater.apply()).toBe(false)
    await updater.check()
    expect(await updater.apply()).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(RELEASE.assets[0]!.browser_download_url)
  })

  it('opens nothing when up to date', async () => {
    const { updater, openExternal } = setup(respond(200, RELEASE), { currentVersion: '0.2.0' })
    expect(await updater.check()).toEqual({ status: 'up-to-date', latest: '0.2.0' })
    expect(await updater.apply()).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('never opens a download URL off GitHub, falling back to the release page', async () => {
    const evil = {
      ...RELEASE,
      assets: [{ name: 'Ordo-0.2.0-mac-arm64.dmg', browser_download_url: 'https://evil.example/x.dmg' }],
    }
    const { updater, openExternal } = setup(respond(200, evil))
    expect(await updater.check()).toMatchObject({ status: 'available', assetName: null })
    await updater.apply()
    expect(openExternal).toHaveBeenCalledWith(RELEASE.html_url)
  })

  it('reads the skipped version at check time', async () => {
    let skipped: string | null = null
    const { updater } = setup(respond(200, RELEASE), { skippedVersion: () => skipped })
    expect(await updater.check()).toMatchObject({ skipped: false })
    skipped = '0.2.0'
    expect(await updater.check()).toMatchObject({ skipped: true })
  })

  it('does not fetch when the host is refused', async () => {
    const fetch = respond(200, RELEASE)
    const { updater } = setup(fetch, { refuse: (url) => (url === LATEST_RELEASE_URL ? 'refused' : null) })
    expect(await updater.check()).toEqual({ status: 'error', message: 'refused' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [404, /No Ordo releases/],
    [403, /limiting/],
    [429, /limiting/],
    [500, /error \(500\)/],
    [301, /error \(301\)/],
  ])('explains HTTP %i', async (status, message) => {
    const { updater } = setup(respond(status, {}))
    expect(await updater.check()).toMatchObject({ status: 'error', message: expect.stringMatching(message) })
  })

  it('refuses an oversized answer', async () => {
    const big = setup(respond(200, RELEASE, { 'content-length': '5000000' }))
    expect(await big.updater.check()).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/more/),
    })
    const long = setup(respond(200, 'x'.repeat(1_000_001)))
    expect(await long.updater.check()).toMatchObject({ status: 'error' })
  })

  it('reports bad JSON, timeouts and network failures without throwing', async () => {
    expect(await setup(respond(200, '{not json')).updater.check()).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/couldn’t read/),
    })
    const timeout = vi.fn<UpdateFetch>(async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError')
    })
    expect(await setup(timeout).updater.check()).toMatchObject({ message: expect.stringMatching(/in time/) })
    const offline = vi.fn<UpdateFetch>(async () => {
      throw new TypeError('fetch failed')
    })
    expect(await setup(offline).updater.check()).toMatchObject({
      message: expect.stringMatching(/reach GitHub/),
    })
  })

  it('times out a request that never answers', async () => {
    const hang = vi.fn<UpdateFetch>(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason)),
        ),
    )
    const { updater } = setup(hang, { timeoutMs: 20 })
    expect(await updater.check()).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/in time/),
    })
  })

  it('forgets an earlier update after a failed check', async () => {
    let fail = false
    const fetch = vi.fn<UpdateFetch>(async () => {
      if (fail) throw new TypeError('fetch failed')
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(RELEASE) }
    })
    const { updater, openExternal } = setup(fetch)
    await updater.check()
    fail = true
    await updater.check()
    expect(await updater.apply()).toBe(false)
    expect(openExternal).not.toHaveBeenCalled()
  })
})
