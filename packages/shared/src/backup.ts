import { z } from 'zod'

/** IPC channels for Settings → Backup. */
export const BACKUP_IPC = {
  status: 'backup:status',
  chooseFolder: 'backup:choose-folder',
  setPassphrase: 'backup:set-passphrase',
  forgetPassphrase: 'backup:forget-passphrase',
  update: 'backup:update',
  run: 'backup:run',
  restorePick: 'backup:restore-pick',
  restoreOpen: 'backup:restore-open',
  restoreCancel: 'backup:restore-cancel',
  restoreConfirm: 'backup:restore-confirm',
} as const

/** How many backups to keep in the folder. */
export const BACKUP_KEEP_CHOICES = [3, 7, 14, 30] as const

export const MIN_PASSPHRASE_LENGTH = 10
const MAX_PASSPHRASE_LENGTH = 1024

export const SetBackupPassphraseSchema = z.strictObject({
  passphrase: z
    .string()
    .min(
      MIN_PASSPHRASE_LENGTH,
      `Use at least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words work well.`,
    )
    .max(MAX_PASSPHRASE_LENGTH),
  /** Keep it in this Mac's keychain (safeStorage), so automatic backups work after a restart. */
  remember: z.boolean(),
  /** The passphrase being replaced. Required once one is set: changing it needs proof you know it. */
  current: z.string().max(MAX_PASSPHRASE_LENGTH).optional(),
})
export type SetBackupPassphrase = z.infer<typeof SetBackupPassphraseSchema>

export const BackupUpdateSchema = z.strictObject({
  auto: z.boolean().optional(),
  keep: z.literal(BACKUP_KEEP_CHOICES).optional(),
})
export type BackupUpdate = z.infer<typeof BackupUpdateSchema>

/** Back up now. The passphrase is needed when it isn't remembered and hasn't been typed this session. */
export const BackupRunSchema = z.strictObject({
  passphrase: z.string().max(MAX_PASSPHRASE_LENGTH).optional(),
})
export type BackupRun = z.infer<typeof BackupRunSchema>

export const RestoreOpenSchema = z.strictObject({ passphrase: z.string().min(1).max(MAX_PASSPHRASE_LENGTH) })
export type RestoreOpen = z.infer<typeof RestoreOpenSchema>

/** The word to type before a restore goes ahead. */
export const RESTORE_CONFIRM_WORD = 'restore'
export const RestoreConfirmSchema = z.strictObject({
  id: z.string().min(1).max(100),
  confirm: z.literal(RESTORE_CONFIRM_WORD),
})
export type RestoreConfirm = z.infer<typeof RestoreConfirmSchema>

export type BackupLast =
  | { at: string; ok: true; file: string; size: number; automatic: boolean }
  | { at: string; ok: false; message: string; automatic: boolean }

export interface BackupStatus {
  /** The folder backups go into, or null until one is chosen. */
  folder: string | null
  passphraseSet: boolean
  /** The passphrase is in this Mac's keychain. */
  remembered: boolean
  /** This Mac can keep secrets (safeStorage is available). */
  canRemember: boolean
  /** The passphrase is available now (remembered, or typed since Ordo opened). */
  unlocked: boolean
  auto: boolean
  keep: number
  running: boolean
  /** The last attempt, successful or not. */
  last: BackupLast | null
  /** The last successful backup, for "Last backed up". */
  lastSuccessAt: string | null
}

export type BackupRunResult =
  | { ok: true; file: string; size: number; at: string; pruned: number }
  | {
      ok: false
      error: 'not-set-up' | 'needs-passphrase' | 'wrong-passphrase' | 'locked' | 'invalid' | 'failed'
      message: string
    }

export type BackupActionResult = { ok: true; status: BackupStatus } | { ok: false; message: string }

export interface RestorePreview {
  /** Pass back to confirm this restore. */
  id: string
  fileName: string
  createdAt: string
  appVersion: string
  files: { name: string; label: string; size: number }[]
  /** The account the backup's mail is for, if any. */
  account: string | null
  /** This Mac's saved password stays (same account). False: you'll connect again after restoring. */
  keepsAccount: boolean
  /** The folder the current data will be moved into. */
  asideFolder: string
}

export type RestorePickResult = { ok: true; fileName: string } | { ok: false; cancelled: true }

export type RestoreOpenResult =
  | { ok: true; preview: RestorePreview }
  | {
      ok: false
      error:
        | 'no-file'
        | 'not-backup'
        | 'newer-version'
        | 'wrong-passphrase'
        | 'damaged'
        | 'truncated'
        | 'invalid'
        | 'failed'
      message: string
    }

export type RestoreConfirmResult = { ok: false; message: string }

export interface BackupApi {
  status(): Promise<BackupStatus>
  /** Show a folder picker; resolves with the new status (unchanged if cancelled). */
  chooseFolder(): Promise<BackupActionResult>
  setPassphrase(input: SetBackupPassphrase): Promise<BackupActionResult>
  /**
   * Remove the passphrase from this Mac's keychain. Automatic backups then wait for it. This and
   * every other call that changes something are only passed on after a click or key press.
   */
  forgetPassphrase(): Promise<BackupActionResult>
  update(input: BackupUpdate): Promise<BackupActionResult>
  run(input?: BackupRun): Promise<BackupRunResult>
  /** Show a file picker for a backup to restore. */
  restorePick(): Promise<RestorePickResult>
  /** Decrypt and check the picked backup, and describe it. Changes nothing yet. */
  restoreOpen(input: RestoreOpen): Promise<RestoreOpenResult>
  restoreCancel(): Promise<void>
  /**
   * Replace Ordo's data with the opened backup and restart. Only resolves if it couldn't; only
   * passed on after a click or key press in the window.
   */
  restoreConfirm(input: RestoreConfirm): Promise<RestoreConfirmResult>
}
