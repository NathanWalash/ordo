import { z } from 'zod'
import type { CleanupProgress, CleanupSummary, UndoResult } from '@ordo/mail-core'

/** What the review sheet asks for. The main process re-checks every sender against its own analysis. */
export const CleanupRequestSchema = z.object({
  senders: z
    .array(
      z.object({
        address: z.string().trim().min(3).max(320),
        unsubscribe: z.boolean(),
        trash: z.boolean(),
        /** For a plain http unsubscribe link: the URL the sheet showed the user. */
        confirmedUrl: z.string().max(4096).optional(),
      }),
    )
    .min(1)
    .max(5000),
})
export type CleanupRequest = z.input<typeof CleanupRequestSchema>

export const CleanupIdSchema = z.number().int().positive()

export type CleanupError = 'invalid' | 'auth' | 'network' | 'unavailable' | 'busy' | 'unknown'

export type CleanupOutcome =
  | {
      ok: true
      cleanup: CleanupSummary
      /** Senders the main process refused (people, unknown senders), with the reason. */
      rejected: { address: string; reason: string }[]
    }
  | { ok: false; error: CleanupError; message: string }

export type UndoOutcome = ({ ok: true } & UndoResult) | { ok: false; error: CleanupError; message: string }

export interface CleanupApi {
  /** Unsubscribe from and/or move the chosen senders' emails to Trash. */
  run(request: CleanupRequest): Promise<CleanupOutcome>
  /** Subscribe to progress events; returns an unsubscribe function. */
  onProgress(listener: (p: CleanupProgress) => void): () => void
  /** Past clean-ups, newest first. */
  history(): Promise<CleanupSummary[]>
  /** Move a clean-up's emails from Trash back to the inbox. Unsubscribes can't be undone. */
  undo(id: number): Promise<UndoOutcome>
}

export const CLEANUP_IPC = {
  run: 'cleanup:run',
  progress: 'cleanup:progress',
  history: 'cleanup:history',
  undo: 'cleanup:undo',
} as const

export type { CleanupProgress, CleanupSummary, UndoResult }
