// pnpm install-app: build Ordo from this checkout and install it on this computer.
//
// macOS: checks the checkout, pulls main, installs dependencies, builds the unpacked app for this
// Mac's processor only (no DMG, nothing published), quits a running Ordo, then swaps the new
// Ordo.app into /Applications (see swapInApp in lib/install-app.mjs). Windows and Linux: builds the
// unpacked app and says where it is. Never touches Ordo's data folder. Safe to run again.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ID,
  USAGE,
  builderArgs,
  builtAppPath,
  builtAppProblem,
  destinationProblem,
  expandHome,
  parseArgs,
  preflight,
  swapInApp,
} from './lib/install-app.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'apps/desktop')
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
const arch = process.arch

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  console.log(USAGE)
  process.exit(0)
}
if (opts.errors.length) {
  for (const e of opts.errors) console.error(e)
  console.error(`\n${USAGE}`)
  process.exit(1)
}

const total = isMac ? 6 : 4
let n = 0
const step = (msg) => console.log(`\n[${++n}/${total}] ${msg}`)
const note = (msg) => console.log(`      ${msg}`)

/** Run a command with its output shown; throw if it fails. */
function run(cmd, args, { cwd = root, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    // pnpm is pnpm.cmd on Windows, which needs a shell.
    shell: isWin && cmd === 'pnpm',
  })
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed${r.error ? `: ${r.error.message}` : ''}.`)
}
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim()

/** Is the installed Ordo (by bundle id, so never a development copy) running? */
function ordoRunning() {
  try {
    return read('osascript', ['-e', `application id "${BUNDLE_ID}" is running`]) === 'true'
  } catch {
    // No app with that id is registered (never installed), or AppleScript is unavailable.
    return spawnSync('pgrep', ['-x', 'Ordo']).status === 0
  }
}

async function quitOrdo() {
  if (!ordoRunning()) {
    note('Ordo isn’t running.')
    return false
  }
  note('Asking Ordo to quit…')
  // Only sent when it's running: `tell application` would otherwise launch it.
  spawnSync('osascript', ['-e', `tell application id "${BUNDLE_ID}" to quit`], { stdio: 'ignore' })
  for (let i = 0; i < 60 && ordoRunning(); i++) await new Promise((r) => setTimeout(r, 500))
  while (ordoRunning()) {
    if (!process.stdin.isTTY)
      throw new Error('Ordo is still running. Quit it, then run pnpm install-app again.')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    await rl.question(
      '      Ordo is still running (it may be asking about unsaved work). Quit it, then press Return… ',
    )
    rl.close()
  }
  note('Ordo has quit.')
  return true
}

function plist(app, key) {
  try {
    return read('plutil', ['-extract', key, 'raw', join(app, 'Contents', 'Info.plist')])
  } catch {
    return null
  }
}

async function main() {
  step('Checking the checkout')
  const branch = read('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  const dirty = read('git', ['status', '--porcelain']) !== ''
  const check = preflight({ platform: process.platform, arch, branch, dirty, flags: opts })
  const dest = expandHome(opts.dest ?? '/Applications', homedir())
  if (isMac) {
    const problem = destinationProblem(dest, homedir())
    if (problem) check.errors.push(problem)
  }
  for (const w of check.warnings) note(`! ${w}`)
  if (check.errors.length) {
    for (const e of check.errors) console.error(`      ✗ ${e}`)
    process.exit(1)
  }
  note(`✓ ${branch}${dirty ? ' (with uncommitted changes)' : ''}, building for ${process.platform} ${arch}.`)

  if (check.pull) {
    note('git pull --ff-only')
    run('git', ['pull', '--ff-only'])
  }

  step('Installing dependencies')
  run('pnpm', ['install', '--frozen-lockfile'])

  const version = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version
  step(`Building Ordo ${version} for this computer (unpacked, nothing published)`)
  run('pnpm', ['--filter', '@ordo/desktop', 'build'])
  run(
    'pnpm',
    ['--filter', '@ordo/desktop', 'exec', 'electron-builder', ...builderArgs(process.platform, arch)],
    {
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    },
  )
  const built = builtAppPath(join(desktop, 'release'), version, process.platform, arch)
  if (!built || !existsSync(built)) throw new Error(`The build finished but there's no app at ${built}.`)
  note(`✓ Built ${built}`)

  if (!isMac) {
    step('Done')
    const exe = join(built, isWin ? 'Ordo.exe' : 'ordo')
    note(`Ordo ${version} is built at ${built}.`)
    note(
      `Run it from there (${exe}), or run pnpm package for an installer in ${join(desktop, 'release', version)}.`,
    )
    note('install-app only replaces an installed copy on macOS.')
    return
  }

  step('Quitting Ordo')
  const wasRunning = await quitOrdo()

  step(`Installing into ${dest}`)
  const result = swapInApp({
    built,
    dest,
    keepPrevious: opts.keepPrevious,
    log: note,
    // ditto keeps the bundle's symlinks, permissions and extended attributes intact.
    copy: (from, to) => run('ditto', [from, to]),
    // Only on the copy just built; ignore "no such attribute".
    clearQuarantine: (app) =>
      void spawnSync('xattr', ['-dr', 'com.apple.quarantine', app], { stdio: 'ignore' }),
    verify: (app) => {
      const problem = builtAppProblem(
        { bundleId: plist(app, 'CFBundleIdentifier'), version: plist(app, 'CFBundleShortVersionString') },
        version,
      )
      if (problem) throw new Error(problem)
    },
  })

  step('Done')
  note(`Ordo ${version} is installed at ${result.target}.`)
  if (result.previous) note(`The previous version is at ${result.previous}.`)
  if (wasRunning && opts.open) {
    note('Reopening Ordo.')
    spawnSync('open', [result.target])
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`)
  if (err?.code === 'EACCES' || err?.code === 'EPERM')
    console.error('  No permission to write there. Use an admin account, or --dest ~/Applications.')
  process.exit(1)
})
