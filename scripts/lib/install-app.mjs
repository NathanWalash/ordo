// Decisions and the app swap for `pnpm install-app` (scripts/install-app.mjs). Everything that
// runs git, pnpm, electron-builder or osascript lives in the script; this file only decides, and
// swaps folders it's given, so scripts/lib/install-app.test.ts can run it all in a temp folder.
import { existsSync, renameSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join, normalize, relative } from 'node:path'

export const BUNDLE_ID = 'dev.nathanwalsh.ordo'
export const APP_NAME = 'Ordo.app'

export const USAGE = `Usage: pnpm install-app [options]

Builds Ordo from this checkout for this computer only and installs it (macOS), replacing
/Applications/Ordo.app. Your Ordo data (mail cache, settings, boards) is never touched.

  --allow-branch     Build a branch other than main (no git pull).
  --allow-dirty      Build with uncommitted changes (no git pull).
  --no-pull          Don't git pull first.
  --dest <folder>    Install into another Applications folder, e.g. ~/Applications.
  --keep-previous    Keep the old app as Ordo.app.previous afterwards.
  --no-open          Don't reopen Ordo afterwards, even if it was running.
  --help             Show this.`

/**
 * @param {string[]} argv
 * @returns {{ allowBranch: boolean, allowDirty: boolean, pull: boolean, dest: string | null,
 *   keepPrevious: boolean, open: boolean, help: boolean, errors: string[] }}
 */
export function parseArgs(argv) {
  const o = {
    allowBranch: false,
    allowDirty: false,
    pull: true,
    dest: null,
    keepPrevious: false,
    open: true,
    help: false,
    errors: [],
  }
  const args = argv.filter((a) => a !== '--')
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--allow-branch') o.allowBranch = true
    else if (a === '--allow-dirty') o.allowDirty = true
    else if (a === '--no-pull') o.pull = false
    else if (a === '--keep-previous') o.keepPrevious = true
    else if (a === '--no-open') o.open = false
    else if (a === '--help' || a === '-h') o.help = true
    else if (a === '--dest' || a.startsWith('--dest=')) {
      const value = a === '--dest' ? args[++i] : a.slice('--dest='.length)
      if (!value || value.startsWith('--')) o.errors.push('--dest needs a folder.')
      else o.dest = value
    } else o.errors.push(`Unknown option ${a}`)
  }
  return o
}

/** `~/Applications` → `/Users/me/Applications`, for a --dest the shell didn't expand. */
export function expandHome(path, home) {
  if (path === '~') return home
  return /^~[\\/]/.test(path) ? join(home, path.slice(2)) : path
}

/** electron-builder's unpacked output folder for a Mac arch (x64 has no suffix). */
export function macOutputDir(arch) {
  if (arch === 'arm64') return 'mac-arm64'
  if (arch === 'x64') return 'mac'
  return null
}

/** Arguments for an unpacked build for this platform and arch only: no DMG, no installer, no publishing. */
export function builderArgs(platform, arch) {
  const os = { darwin: '--mac', win32: '--win', linux: '--linux' }[platform]
  if (!os) throw new Error(`Ordo doesn't build on ${platform}.`)
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`Ordo doesn't build for ${arch}.`)
  return ['--dir', '--publish', 'never', os, `--${arch}`]
}

/** Where electron-builder puts the unpacked app. */
export function builtAppPath(releaseRoot, version, platform, arch) {
  const dir = join(releaseRoot, version)
  if (platform === 'darwin') {
    const out = macOutputDir(arch)
    return out ? join(dir, out, APP_NAME) : null
  }
  if (platform === 'win32') return join(dir, arch === 'arm64' ? 'win-arm64-unpacked' : 'win-unpacked')
  if (platform === 'linux') return join(dir, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked')
  return null
}

/**
 * What to do before building, from the state of the checkout.
 * @param {{ platform: string, arch: string, branch: string, dirty: boolean,
 *   flags: { allowBranch: boolean, allowDirty: boolean, pull: boolean } }} s
 * @returns {{ errors: string[], warnings: string[], pull: boolean }}
 */
export function preflight(s) {
  const errors = []
  const warnings = []
  if (!['darwin', 'win32', 'linux'].includes(s.platform)) errors.push(`Ordo doesn't build on ${s.platform}.`)
  if (s.arch !== 'arm64' && s.arch !== 'x64') errors.push(`Ordo doesn't build for ${s.arch} processors.`)
  const onMain = s.branch === 'main'
  if (!onMain && !s.flags.allowBranch)
    errors.push(
      `You're on "${s.branch}", not main. Switch to main, or add --allow-branch to build it anyway.`,
    )
  if (!onMain && s.flags.allowBranch) warnings.push(`Building "${s.branch}", not main.`)
  if (s.dirty && !s.flags.allowDirty)
    errors.push(
      'You have uncommitted changes. Commit or stash them, or add --allow-dirty to build them anyway.',
    )
  if (s.dirty && s.flags.allowDirty) warnings.push('Building with uncommitted changes.')
  const pull = s.flags.pull && onMain && !s.dirty
  if (s.flags.pull && !pull) warnings.push('Skipping git pull (only a clean main is pulled).')
  return { errors, warnings, pull }
}

/**
 * Why Ordo won't install into this folder, or null. Only a folder named Applications, given as a
 * full path, outside ~/Library (where Ordo keeps your data), may receive Ordo.app.
 * @param {string} dest @param {string} home
 */
export function destinationProblem(dest, home) {
  if (!isAbsolute(dest)) return `${dest} isn't a full path.`
  const d = normalize(dest).replace(/[\\/]+$/, '')
  if (basename(d) !== 'Applications') return `Ordo only installs into an Applications folder, not ${dest}.`
  const library = join(home, 'Library')
  const rel = relative(library, d)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    return `${dest} is inside ~/Library, where Ordo keeps your data. Choose another folder.`
  return null
}

/**
 * Check the app about to be installed is the Ordo just built.
 * @param {{ bundleId: string | null, version: string | null }} info @param {string} expectedVersion
 */
export function builtAppProblem(info, expectedVersion) {
  if (info.bundleId !== BUNDLE_ID) return `The built app's identifier is ${info.bundleId}, not ${BUNDLE_ID}.`
  if (info.version !== expectedVersion)
    return `The built app is version ${info.version}, expected ${expectedVersion}.`
  return null
}

/** The three paths the swap uses, all in the destination folder (one volume, so renames are atomic). */
export function swapPaths(dest) {
  return {
    target: join(dest, APP_NAME),
    staging: join(dest, `.${APP_NAME}.installing`),
    previous: join(dest, `${APP_NAME}.previous`),
  }
}

/**
 * Put a freshly built Ordo.app in place of the installed one, safely and rerunnably:
 *
 * 1. Copy the build to a hidden temp name next to the target (a leftover from an earlier run is
 *    removed first), clear quarantine on that copy only, and check it.
 * 2. Move the installed app aside to Ordo.app.previous. If there's no installed app but there is
 *    a .previous (an earlier run stopped half way), that .previous is the only copy and is kept.
 * 3. Rename the copy to Ordo.app. If that fails, the previous app is put back.
 * 4. Remove Ordo.app.previous, unless asked to keep it.
 *
 * @param {{ built: string, dest: string, keepPrevious?: boolean,
 *   copy: (from: string, to: string) => void, clearQuarantine: (path: string) => void,
 *   verify: (path: string) => void, log?: (msg: string) => void,
 *   rename?: (from: string, to: string) => void }} o
 * @returns {{ target: string, previous: string | null }}
 */
export function swapInApp(o) {
  const log = o.log ?? (() => {})
  // Injectable so the tests can make the final rename fail.
  const rename = o.rename ?? renameSync
  const { target, staging, previous } = swapPaths(o.dest)
  if (!existsSync(o.built)) throw new Error(`There's no built app at ${o.built}.`)

  if (existsSync(staging)) {
    log(`Removing a leftover ${staging} from an earlier run`)
    rmSync(staging, { recursive: true, force: true })
  }
  log(`Copying the new app to ${staging}`)
  o.copy(o.built, staging)
  try {
    o.clearQuarantine(staging)
    o.verify(staging)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err
  }

  if (existsSync(target)) {
    if (existsSync(previous)) rmSync(previous, { recursive: true, force: true })
    log(`Moving the installed app aside to ${previous}`)
    renameSync(target, previous)
  } else if (existsSync(previous)) {
    log(`Keeping ${previous} from an earlier run until the new app is in place`)
  }

  try {
    rename(staging, target)
  } catch (err) {
    if (!existsSync(target) && existsSync(previous)) renameSync(previous, target)
    rmSync(staging, { recursive: true, force: true })
    throw err
  }
  log(`Installed ${target}`)

  if (existsSync(previous) && !o.keepPrevious) {
    rmSync(previous, { recursive: true, force: true })
    return { target, previous: null }
  }
  return { target, previous: existsSync(previous) ? previous : null }
}
