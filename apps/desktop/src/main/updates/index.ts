// Update checks in the app: IPC for Settings → Updates and the update notice, plus the daily check.
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { hostRefusal } from '@ordo/mail-core'
import { createGuardedFetch } from '@ordo/mail-core/node'
import {
  ChecksEnabledSchema,
  SkipVersionSchema,
  UPDATES_IPC,
  type UpdateCheckResult,
  type UpdateState,
} from '@ordo/shared'
import { shouldAutoCheck } from './logic'
import { readUpdateStore, updateUpdateStore } from './store'
import { createGitHubUpdater, type UpdateFetch, type Updater } from './updater'

/** Let start-up finish before talking to GitHub. */
const FIRST_CHECK_DELAY_MS = 15_000
/** How often a long-running Ordo looks again; shouldAutoCheck still allows one check a day. */
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000

const storeFile = () => join(app.getPath('userData'), 'updates.json')

let updater: Updater | null = null
let last: UpdateCheckResult | null = null
let running: Promise<UpdateCheckResult> | null = null

function getUpdater(): Updater {
  updater ??= createGitHubUpdater({
    fetch: createGuardedFetch() as unknown as UpdateFetch,
    refuse: (url) => hostRefusal(url),
    openExternal: (url) => shell.openExternal(url),
    currentVersion: app.getVersion(),
    skippedVersion: () => readUpdateStore(storeFile()).skippedVersion,
    platform: process.platform,
    // An Intel build on Apple silicon should offer the Apple silicon download.
    arch: app.runningUnderARM64Translation ? 'arm64' : process.arch,
  })
  return updater
}

function state(): UpdateState {
  const store = readUpdateStore(storeFile())
  return {
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    checksEnabled: store.checksEnabled,
    lastCheckedAt: store.lastCheckedAt,
    skippedVersion: store.skippedVersion,
    last,
  }
}

/** One check at a time; a second caller waits for the one in flight. */
function runCheck(): Promise<UpdateCheckResult> {
  running ??= getUpdater()
    .check()
    .then((result) => {
      last = result
      updateUpdateStore(storeFile(), { lastCheckedAt: new Date().toISOString() })
      return result
    })
    .finally(() => (running = null))
  return running
}

async function autoCheck(): Promise<void> {
  const store = readUpdateStore(storeFile())
  if (!shouldAutoCheck({ packaged: app.isPackaged, ...store, now: new Date() })) return
  const result = await runCheck()
  if (result.status !== 'available' || result.skipped) return
  const s = state()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(UPDATES_IPC.changed, s)
}

export function registerUpdatesIpc(): void {
  ipcMain.handle(UPDATES_IPC.state, () => state())
  ipcMain.handle(UPDATES_IPC.check, async () => {
    await runCheck()
    return state()
  })
  ipcMain.handle(UPDATES_IPC.open, async () => {
    await getUpdater().apply()
  })
  ipcMain.handle(UPDATES_IPC.skip, (_e, input: unknown) => {
    const version = SkipVersionSchema.parse(input)
    updateUpdateStore(storeFile(), { skippedVersion: version })
    if (last?.status === 'available' && last.version === version) last = { ...last, skipped: true }
    return state()
  })
  ipcMain.handle(UPDATES_IPC.setChecksEnabled, (_e, input: unknown) => {
    updateUpdateStore(storeFile(), { checksEnabled: ChecksEnabledSchema.parse(input) })
    return state()
  })
}

/** Installed builds only: check once soon after launch, then look again every few hours (at most daily). */
export function scheduleUpdateChecks(): void {
  if (!app.isPackaged) return
  const run = () => void autoCheck().catch(() => {})
  setTimeout(run, FIRST_CHECK_DELAY_MS).unref()
  setInterval(run, RECHECK_EVERY_MS).unref()
}
