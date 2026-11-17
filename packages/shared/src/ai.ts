import { z } from 'zod'
import { PROVIDER_IDS, PROVIDERS, type DetectResult, type ProviderId, type ProviderInfo } from '@ordo/ai'
import type { AiSortedSender, AiSortProgress } from '@ordo/mail-core'

export { PROVIDERS as AI_PROVIDERS, type ProviderId as AiProviderId }
export type { AiSortedSender, AiSortProgress }

export const CLOUD_PROVIDER_IDS = PROVIDERS.filter((p) => p.kind === 'cloud').map((p) => p.id)
export const isCloudProvider = (id: string) => (CLOUD_PROVIDER_IDS as string[]).includes(id)

/**
 * AI preferences. Local is the default and nothing is on until the user picks a provider.
 * A cloud provider is only valid together with consent for that same provider, which the
 * renderer asks for in a confirm sheet; the main process re-checks it on every save and use.
 */
export const AiSettingsSchema = z
  .object({
    provider: z.enum(['none', ...PROVIDER_IDS]),
    model: z.string().max(200).nullable(),
    /** Sort senders the rules aren't sure about with the chosen model. */
    sortSenders: z.boolean(),
    /** The cloud provider the user agreed may receive sender names and subject lines. */
    cloudConsent: z.enum(PROVIDER_IDS).nullable(),
  })
  .strict()
  .refine((s) => !isCloudProvider(s.provider) || s.cloudConsent === s.provider, {
    message: 'Confirm before sending sender details to a cloud provider.',
    path: ['cloudConsent'],
  })
export type AiSettings = z.infer<typeof AiSettingsSchema>

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: 'none',
  model: null,
  sortSenders: false,
  cloudConsent: null,
}

export interface AiProviderStatus extends ProviderInfo, Omit<DetectResult, 'detail'> {
  /** What to show next to the provider, e.g. "Running · 3 models" or "Not running. Open LM Studio." */
  detail: string
  models: string[]
  /** The model to preselect, e.g. gpt-oss-20b when LM Studio has it. */
  recommended: string | null
}

export const AiTestInputSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().max(200).nullable(),
})
export type AiTestInput = z.infer<typeof AiTestInputSchema>

export type AiTestResult =
  { ok: true; reply: string; latencyMs: number; model: string | null } | { ok: false; message: string }

export const AiSortInputSchema = z.object({ scope: z.enum(['uncategorised', 'all']).optional() }).strict()
export type AiSortInput = z.infer<typeof AiSortInputSchema>

export type AiSortOutcome =
  | {
      ok: true
      senders: AiSortedSender[]
      checked: number
      changed: number
      cached: number
      failed: number
      errors: string[]
    }
  | { ok: false; message: string }

export interface AiApi {
  /** Detect every provider. `refresh` looks for newly installed CLIs again. */
  status(refresh?: boolean): Promise<AiProviderStatus[]>
  /** Send a tiny fixed prompt to a provider and time the reply. Cloud providers need saved consent. */
  test(input: AiTestInput): Promise<AiTestResult>
  /** Re-sort the cached senders with the saved provider and model. */
  categoriseSenders(input?: AiSortInput): Promise<AiSortOutcome>
  stop(): Promise<void>
  /** Subscribe to sorting progress; returns an unsubscribe function. */
  onProgress(listener: (p: AiSortProgress) => void): () => void
}

export const AI_IPC = {
  aiStatus: 'ai:status',
  aiTest: 'ai:test',
  aiCategorise: 'ai:categorise-senders',
  aiStop: 'ai:stop',
  aiProgress: 'ai:progress',
} as const
