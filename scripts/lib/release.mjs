// Pure helpers for `pnpm release` and the Release workflow: versions and CHANGELOG.md sections.
// No file system, git or network here, so scripts/lib/release.test.ts can cover all of it.

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

/** @param {string} text @returns {{ major: number, minor: number, patch: number, pre: string[] } | null} */
export function parseVersion(text) {
  const m = SEMVER.exec(String(text).trim().replace(/^v/, ''))
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] }
}

/** Semver precedence: negative, 0 or positive. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`)
  const core = Math.sign(x.major - y.major) || Math.sign(x.minor - y.minor) || Math.sign(x.patch - y.patch)
  if (core) return core
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Math.sign(Number(p) - Number(q))
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * The version to release: `patch`, `minor` or `major` bumps the current one; anything else must
 * be an explicit version (an optional `v` is dropped) newer than the current one. With
 * `unreleased` (the current version has no tag yet, as before the first release), the current
 * version itself may be released as is.
 * @param {string} current @param {string} requested @param {{ unreleased?: boolean }} [opts]
 */
export function nextVersion(current, requested, opts = {}) {
  const cur = parseVersion(current)
  if (!cur) throw new Error(`apps/desktop/package.json has an invalid version: ${current}`)
  let next
  if (requested === 'major') next = `${cur.major + 1}.0.0`
  else if (requested === 'minor') next = `${cur.major}.${cur.minor + 1}.0`
  else if (requested === 'patch') next = `${cur.major}.${cur.minor}.${cur.patch + 1}`
  else {
    if (!parseVersion(requested))
      throw new Error(`Not a version: ${requested}. Use e.g. 0.2.0, patch, minor or major.`)
    next = String(requested).trim().replace(/^v/, '')
  }
  if (opts.unreleased && compareVersions(next, current) === 0) return next
  if (compareVersions(next, current) <= 0)
    throw new Error(`${next} isn't newer than the current version ${current}.`)
  return next
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Where a `## ...` heading's section starts and ends (end = next `## ` heading or the file's end). */
function section(changelog, headingRe) {
  const lines = changelog.split('\n')
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i
      break
    }
    // Link reference definitions at the bottom ("[0.1.0]: https://...") aren't part of a section.
    if (/^\[[^\]]+\]:\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return {
    lines,
    start,
    end,
    body: lines
      .slice(start + 1, end)
      .join('\n')
      .trim(),
  }
}

/**
 * The notes for one version from CHANGELOG.md, without its heading; null if there's no
 * `## [x.y.z]` section or it's empty.
 * @param {string} changelog @param {string} version
 */
export function releaseNotes(changelog, version) {
  const v = escape(String(version).replace(/^v/, ''))
  const s = section(changelog.replace(/\r\n?/g, '\n'), new RegExp(`^## \\[?v?${v}\\]?(\\s|$)`))
  return s && s.body ? s.body : null
}

/**
 * Move everything under `## [Unreleased]` to a new `## [version] - date` section, leaving an empty
 * Unreleased heading at the top. Throws if there's nothing to release or the version is already there.
 * @param {string} changelog @param {string} version @param {string} date YYYY-MM-DD
 */
export function cutRelease(changelog, version, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not a date: ${date}`)
  const text = changelog.replace(/\r\n?/g, '\n')
  if (
    releaseNotes(text, version) !== null ||
    new RegExp(`^## \\[?v?${escape(version)}\\]?(\\s|$)`, 'm').test(text)
  )
    throw new Error(`CHANGELOG.md already has a section for ${version}.`)
  const s = section(text, /^## \[?Unreleased\]?\s*$/i)
  if (!s) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.')
  if (!s.body) throw new Error('Nothing under "## [Unreleased]" in CHANGELOG.md to release.')
  const before = s.lines.slice(0, s.start)
  const after = s.lines.slice(s.end)
  const out = [...before, '## [Unreleased]', '', `## [${version}] - ${date}`, '', s.body, '', ...after]
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`
}

/**
 * Set `"version"` in a package.json's text, keeping its formatting.
 * @param {string} json @param {string} version
 */
export function setPackageVersion(json, version) {
  let count = 0
  const out = json.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, (_m, a, b) => {
    count++
    return `${a}${version}${b}`
  })
  if (count !== 1) throw new Error('package.json has no "version" field.')
  return out
}

/**
 * What stops a release from this checkout. Empty when it's clean, on main and level with origin/main.
 * @param {{ branch: string, dirty: boolean, behind: number, ahead: number, tagExists: boolean, tag: string }} s
 * @returns {string[]}
 */
export function releaseProblems(s) {
  const problems = []
  if (s.dirty) problems.push('The working tree has uncommitted changes. Commit or stash them first.')
  if (s.branch !== 'main') problems.push(`You're on "${s.branch}". Releases are cut from main.`)
  if (s.behind > 0) problems.push(`main is ${s.behind} commit(s) behind origin/main. Run git pull --ff-only.`)
  if (s.ahead > 0)
    problems.push(`main is ${s.ahead} commit(s) ahead of origin/main. Push or open a PR first.`)
  if (s.tagExists) problems.push(`The tag ${s.tag} already exists.`)
  return problems
}
