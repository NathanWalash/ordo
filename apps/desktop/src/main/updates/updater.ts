// The Updater seam. Today's builds are unsigned, so the only updater tells you about a new release
// and opens its installer in your browser. A signed build can swap in one based on electron-updater
// (download in the background, install on restart) behind the same interface. See docs/updates.md.
import type { UpdateCheckResult } from '@ordo/shared'
import {
  decideUpdate,
  downloadUrlFor,
  isAllowedReleaseUrl,
  LATEST_RELEASE_URL,
  type Arch,
  type Platform,
} from './logic'

export interface Updater {
  /** Ask whether there's a newer version. Never downloads or runs anything. */
  check(): Promise<UpdateCheckResult>
  /**
   * Act on the update the last check found. This one opens the installer (or the release page) in
   * the browser and returns false if there's nothing to open; an electron-updater one would
   * download it and restart into it.
   */
  apply(): Promise<boolean>
}

/** The slice of fetch the check needs, so tests can pass a fake. */
export type UpdateFetch = (
  url: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    redirect: 'manual'
    credentials: 'omit'
    signal: AbortSignal
  },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>

export interface GitHubUpdaterDeps {
  /** Must refuse private and local addresses at connect time (createGuardedFetch). */
  fetch: UpdateFetch
  /** Why a URL's host is refused, or null (hostRefusal). Checked before every request. */
  refuse: (url: string) => string | null
  /** Open a URL in the browser. Only ever given an https URL on github.com. */
  openExternal: (url: string) => Promise<void>
  currentVersion: string
  /** Read when each check runs, so "Skip this version" applies straight away. */
  skippedVersion: () => string | null
  platform: Platform
  arch: Arch
  timeoutMs?: number
}

/** GitHub's answer is a few kilobytes; refuse anything absurd. */
const MAX_BYTES = 1_000_000

/**
 * Checks `releases/latest` on GitHub, unauthenticated. Sends nothing but the request itself: no
 * version, no identifiers, no cookies.
 */
export function createGitHubUpdater(deps: GitHubUpdaterDeps): Updater {
  let lastRelease: unknown = null
  let lastResult: UpdateCheckResult | null = null

  const fail = (message: string): UpdateCheckResult => ({ status: 'error', message })

  async function check(): Promise<UpdateCheckResult> {
    const refusal = deps.refuse(LATEST_RELEASE_URL)
    if (refusal) return (lastResult = fail(refusal))
    let json: unknown
    try {
      const res = await deps.fetch(LATEST_RELEASE_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          // GitHub's API requires a User-Agent. No version or anything else that identifies you.
          'User-Agent': 'Ordo',
        },
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      })
      if (res.status === 404) return (lastResult = fail('No Ordo releases have been published yet.'))
      if (res.status === 403 || res.status === 429)
        return (lastResult = fail('GitHub is limiting requests right now. Try again in an hour.'))
      if (res.status < 200 || res.status >= 300)
        return (lastResult = fail(`GitHub answered with an error (${res.status}). Try again later.`))
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES)
        return (lastResult = fail('GitHub sent more than Ordo expected.'))
      const text = await res.text()
      if (text.length > MAX_BYTES) return (lastResult = fail('GitHub sent more than Ordo expected.'))
      json = JSON.parse(text)
    } catch (err) {
      const name = (err as Error | undefined)?.name
      if (name === 'TimeoutError' || name === 'AbortError')
        return (lastResult = fail('GitHub didn’t answer in time. Try again later.'))
      if (name === 'SyntaxError') return (lastResult = fail('GitHub sent a release Ordo couldn’t read.'))
      return (lastResult = fail('Couldn’t reach GitHub. Check your internet connection.'))
    }
    lastRelease = json
    lastResult = decideUpdate(json, {
      currentVersion: deps.currentVersion,
      skippedVersion: deps.skippedVersion(),
      platform: deps.platform,
      arch: deps.arch,
    })
    return lastResult
  }

  async function apply(): Promise<boolean> {
    if (lastResult?.status !== 'available') return false
    const url = downloadUrlFor(lastRelease, deps.platform, deps.arch)
    // Checked when the release was read and again here, right before it leaves Ordo.
    if (!url || !isAllowedReleaseUrl(url)) return false
    await deps.openExternal(url)
    return true
  }

  return { check, apply }
}
