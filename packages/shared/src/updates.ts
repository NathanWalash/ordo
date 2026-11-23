import { z } from 'zod'

/** A newer release than the one running, as the update check found it. */
export interface AvailableUpdate {
  /** `0.2.0`, without the leading `v`. */
  version: string
  /** The first part of the release notes as plain text, at most a few hundred characters. */
  notes: string
  /** The release page on github.com. */
  releaseUrl: string
  /** The installer for this computer, e.g. `Ordo-0.2.0-mac-arm64.dmg`, or null if the release has none. */
  assetName: string | null
  /** You chose "Skip this version" for this version. */
  skipped: boolean
}

export type UpdateCheckResult =
  | { status: 'up-to-date'; latest: string }
  | ({ status: 'available' } & AvailableUpdate)
  | { status: 'error'; message: string }

/** What Settings → Updates and the update notice show. */
export interface UpdateState {
  /** The version running now. */
  currentVersion: string
  /** Installed builds check on their own; development builds only check when asked. */
  packaged: boolean
  /** "Check for updates automatically" in Settings. */
  checksEnabled: boolean
  /** ISO time of the last check (whatever its result), or null. */
  lastCheckedAt: string | null
  skippedVersion: string | null
  /** The result of the last check since Ordo started, or null if it hasn't checked yet. */
  last: UpdateCheckResult | null
}

/** "Skip this version" input: a plain version such as `0.2.0`. */
export const SkipVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  .max(64)
export const ChecksEnabledSchema = z.boolean()

export interface UpdatesApi {
  state(): Promise<UpdateState>
  /** Check GitHub now, whatever the daily limit and setting say. Never downloads anything. */
  check(): Promise<UpdateState>
  /** Open the installer for the update found last (or its release page) in the browser. */
  open(): Promise<void>
  /** Don't tell me about this version again. */
  skip(version: string): Promise<UpdateState>
  setChecksEnabled(enabled: boolean): Promise<UpdateState>
  /** Subscribe to the result of the check Ordo runs at launch; returns an unsubscribe function. */
  onChanged(listener: (state: UpdateState) => void): () => void
}

export const UPDATES_IPC = {
  state: 'updates:state',
  check: 'updates:check',
  open: 'updates:open',
  skip: 'updates:skip',
  setChecksEnabled: 'updates:set-checks-enabled',
  changed: 'updates:changed',
} as const
