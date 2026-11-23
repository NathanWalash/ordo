// Pure decisions for the update check: no Electron, no network, no file system.
import { z } from 'zod'
import type { UpdateCheckResult } from '@ordo/shared'

export const REPO = 'NathanWalash/ordo'
/** The only URL the update check ever requests. */
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`
export const DAY_MS = 24 * 60 * 60 * 1000

// ---------- Versions ----------

export interface Version {
  major: number
  minor: number
  patch: number
  /** Pre-release identifiers, e.g. `['beta', '2']` for `1.0.0-beta.2`; empty for a release. */
  pre: string[]
}

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Parse `1.2.3`, `v1.2.3`, `1.2.3-beta.1+build.5`. Null for anything else. */
export function parseVersion(text: string): Version | null {
  const m = SEMVER.exec(text.trim())
  if (!m) return null
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number) as [number, number, number]
  if (![major, minor, patch].every(Number.isSafeInteger)) return null
  return { major, minor, patch, pre: m[4] ? m[4].split('.') : [] }
}

/** `1.2.3` for a parsed version (pre-release kept, build metadata and `v` dropped). */
export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join('.')}` : ''}`
}

const isNumeric = (id: string) => /^\d+$/.test(id)

function comparePre(a: string[], b: string[]): number {
  // A release outranks any of its pre-releases.
  if (!a.length || !b.length) return a.length ? -1 : b.length ? 1 : 0
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = isNumeric(x)
    const yn = isNumeric(y)
    if (xn && yn) return Math.sign(Number(x) - Number(y))
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Semantic Versioning precedence: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: Version, b: Version): number {
  return (
    Math.sign(a.major - b.major) ||
    Math.sign(a.minor - b.minor) ||
    Math.sign(a.patch - b.patch) ||
    comparePre(a.pre, b.pre)
  )
}

/** True only if both parse and `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest)
  const c = parseVersion(current)
  return !!l && !!c && compareVersions(l, c) > 0
}

// ---------- The GitHub release ----------

const AssetSchema = z.object({
  name: z.string().max(300),
  browser_download_url: z.string().max(2000),
})
export type ReleaseAsset = z.infer<typeof AssetSchema>

/** The fields Ordo reads from GitHub's "latest release" response. Everything else is ignored. */
export const ReleaseSchema = z.object({
  tag_name: z.string().max(100),
  html_url: z.string().max(2000),
  body: z.string().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(z.unknown()).max(200).default([]),
})
export type Release = z.infer<typeof ReleaseSchema>

/** The release's assets that look like assets, skipping anything malformed. */
export function releaseAssets(release: Release): ReleaseAsset[] {
  return release.assets.flatMap((a) => {
    const r = AssetSchema.safeParse(a)
    return r.success ? [r.data] : []
  })
}

// ---------- URLs ----------

/**
 * May Ordo open this URL in the browser? Only https on github.com (this repository's pages) or
 * GitHub's download host, with no user name, password or port. Anything else from the API
 * response (a compromised or spoofed answer) is refused.
 */
export function isAllowedReleaseUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  if (host === 'objects.githubusercontent.com') return true
  if (host !== 'github.com') return false
  const prefix = `/${REPO}/releases/`.toLowerCase()
  const path = url.pathname.toLowerCase()
  // No `..` or encoded slashes sneaking out of the repository.
  return path.startsWith(prefix) && !/(^|\/)\.\.(\/|$)|%2f|%5c/i.test(url.pathname)
}

// ---------- Picking the installer ----------

export type Platform = 'darwin' | 'win32' | 'linux' | string
export type Arch = 'arm64' | 'x64' | string

/**
 * The installer for this computer from electron-builder's names
 * (`${productName}-${version}-${os}-${arch}.${ext}`): `-mac-arm64.dmg`, `-mac-x64.dmg`,
 * `-win-x64.exe`, `-linux-x86_64.AppImage`. Windows on Arm falls back to the x64 installer, which
 * it runs under emulation. Null if there's nothing suitable (the caller opens the release page).
 */
export function pickAsset(assets: ReleaseAsset[], platform: Platform, arch: Arch): ReleaseAsset | null {
  const find = (re: RegExp) =>
    assets.find((a) => re.test(a.name) && isAllowedReleaseUrl(a.browser_download_url)) ?? null
  if (platform === 'darwin') {
    if (arch === 'arm64') return find(/-mac-arm64\.dmg$/i)
    if (arch === 'x64') return find(/-mac-x64\.dmg$/i)
    return null
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return find(/-win-arm64\.exe$/i) ?? find(/-win-x64\.exe$/i)
    if (arch === 'x64') return find(/-win-x64\.exe$/i)
    return null
  }
  if (platform === 'linux') {
    if (arch === 'x64') return find(/-linux-(x86_64|x64)\.AppImage$/i)
    if (arch === 'arm64') return find(/-linux-(arm64|aarch64)\.AppImage$/i)
  }
  return null
}

// ---------- Release notes ----------

/**
 * The start of the release notes as plain text for the notice: Markdown links become their text,
 * emphasis, headings and HTML are removed, and it's cut at a line (or word) before `max` characters.
 */
export function summariseNotes(body: string | null | undefined, max = 400): string {
  if (!body) return ''
  const lines = body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*[-*+]\s+/, '• ')
        .replace(/(\*\*|__|`)/g, '')
        .trimEnd(),
    )
    .filter((line, i, all) => line.trim() !== '' || (i > 0 && all[i - 1]!.trim() !== ''))
  const text = lines.join('\n').trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '))
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

// ---------- Throttle ----------

/**
 * Should Ordo check on its own now? Only installed builds with checks turned on, at most once a day.
 * A last-check time in the future (the clock was changed) or unreadable counts as never.
 */
export function shouldAutoCheck(opts: {
  packaged: boolean
  checksEnabled: boolean
  lastCheckedAt: string | null
  now: Date
}): boolean {
  if (!opts.packaged || !opts.checksEnabled) return false
  if (!opts.lastCheckedAt) return true
  const last = Date.parse(opts.lastCheckedAt)
  const now = opts.now.getTime()
  if (!Number.isFinite(last) || last > now) return true
  return now - last >= DAY_MS
}

// ---------- The decision ----------

/** Turn GitHub's answer into what Ordo shows. Pure: the caller fetches and parses JSON. */
export function decideUpdate(
  json: unknown,
  opts: { currentVersion: string; skippedVersion: string | null; platform: Platform; arch: Arch },
): UpdateCheckResult {
  const parsed = ReleaseSchema.safeParse(json)
  if (!parsed.success) return { status: 'error', message: 'GitHub sent a release Ordo couldn’t read.' }
  const release = parsed.data
  const latest = parseVersion(release.tag_name)
  if (!latest)
    return { status: 'error', message: `The latest release (${release.tag_name}) has no version number.` }
  const version = formatVersion(latest)
  const current = parseVersion(opts.currentVersion)
  // Drafts and pre-releases never count (GitHub's "latest" leaves them out anyway).
  if (
    release.draft ||
    release.prerelease ||
    latest.pre.length ||
    !current ||
    compareVersions(latest, current) <= 0
  )
    return { status: 'up-to-date', latest: version }
  if (!isAllowedReleaseUrl(release.html_url))
    return { status: 'error', message: 'The release page isn’t on github.com, so Ordo won’t open it.' }
  const asset = pickAsset(releaseAssets(release), opts.platform, opts.arch)
  const skipped = parseVersion(opts.skippedVersion ?? '')
  return {
    status: 'available',
    version,
    notes: summariseNotes(release.body),
    releaseUrl: release.html_url,
    assetName: asset?.name ?? null,
    skipped: !!skipped && compareVersions(skipped, latest) === 0,
  }
}

/** The URL to open for an update: the installer if there is one, otherwise the release page. */
export function downloadUrlFor(json: unknown, platform: Platform, arch: Arch): string | null {
  const parsed = ReleaseSchema.safeParse(json)
  if (!parsed.success) return null
  const asset = pickAsset(releaseAssets(parsed.data), platform, arch)
  const url = asset?.browser_download_url ?? parsed.data.html_url
  return isAllowedReleaseUrl(url) ? url : null
}
