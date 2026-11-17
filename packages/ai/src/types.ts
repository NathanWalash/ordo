export const PROVIDER_IDS = ['lmstudio', 'ollama', 'claude-cli', 'codex-cli'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/** `local` runs on this computer; `cloud` sends the prompt to a company under the user's own account. */
export type ProviderKind = 'local' | 'cloud'

export interface ProviderInfo {
  id: ProviderId
  label: string
  kind: ProviderKind
  /** Who receives the prompt for a cloud provider. */
  vendor?: string
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'lmstudio', label: 'LM Studio', kind: 'local' },
  { id: 'ollama', label: 'Ollama', kind: 'local' },
  { id: 'claude-cli', label: 'Claude Code CLI', kind: 'cloud', vendor: 'Anthropic' },
  { id: 'codex-cli', label: 'Codex CLI', kind: 'cloud', vendor: 'OpenAI' },
]

export const providerInfo = (id: ProviderId): ProviderInfo => PROVIDERS.find((p) => p.id === id)!

/**
 * The model to pick when the user hasn't chosen one. gpt-oss-20b sorts senders well and runs on a
 * laptop with 16 GB of memory; Claude's smallest model is plenty for one-word labels.
 */
export function recommendedModel(id: ProviderId, models: readonly string[]): string | null {
  if (id === 'claude-cli') return models.includes('haiku') ? 'haiku' : (models[0] ?? null)
  return models.find((m) => /gpt-oss[-:_]?20b/i.test(m)) ?? models[0] ?? null
}

/**
 * What `detect()` found. `state` says why a provider can't be used, so the UI can say what to do:
 * start the app, install the tool or sign in.
 */
export interface DetectResult {
  available: boolean
  state: 'ready' | 'not-running' | 'not-installed' | 'signed-out' | 'error'
  detail?: string
}

/** A JSON Schema object, as sent to the model to constrain its reply. */
export type JsonSchema = Record<string, unknown>

export interface CompleteRequest {
  system: string
  prompt: string
  /** Model id from `listModels()`. Providers fall back to their default when omitted. */
  model?: string
  /** Ask for JSON matching this schema, using the provider's structured output when it has one. */
  schema?: JsonSchema
  signal?: AbortSignal
  timeoutMs?: number
}

export interface CompleteResult {
  text: string
  /** Parsed JSON when a schema was given and the provider returned structured output. */
  json?: unknown
}

export interface ModelProvider {
  readonly id: ProviderId
  readonly label: string
  readonly kind: ProviderKind
  detect(): Promise<DetectResult>
  listModels(): Promise<string[]>
  complete(req: CompleteRequest): Promise<CompleteResult>
}

export type AiErrorCode = 'unavailable' | 'timeout' | 'aborted' | 'bad-response' | 'failed'

/** Every adapter failure surfaces as an AiError with a message fit to show the user. */
export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AiError'
  }
}
