import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { AiError, PROVIDERS, recommendedModel, type ModelProvider, type ProviderId } from '@ordo/ai'
import { CommandResolver, createProviders } from '@ordo/ai/node'
import { aiCategorise } from '@ordo/mail-core'
import {
  AI_IPC,
  AiSortInputSchema,
  AiTestInputSchema,
  isCloudProvider,
  type AiProviderStatus,
  type AiSettings,
  type AiSortInput,
  type AiSortOutcome,
  type AiSortProgress,
  type AiTestInput,
  type AiTestResult,
} from '@ordo/shared'
import { mailStore, senders } from './mail'
import { readSettings } from './settings'
import { Locked, toRenderer, withWriteLock } from './writes'

const settingsFile = () => join(app.getPath('userData'), 'settings.json')

/**
 * Tests can point an unpackaged build at fake servers and CLIs: ORDO_LMSTUDIO_URL, ORDO_OLLAMA_URL,
 * and ORDO_AI_CLI_PATH (the only folders searched for `claude` and `codex`).
 */
function testOverride(name: string): string | undefined {
  return !app.isPackaged ? process.env[name] : undefined
}

let resolver: CommandResolver
let providers: Record<ProviderId, ModelProvider>

function makeProviders() {
  const cliPath = testOverride('ORDO_AI_CLI_PATH')
  resolver = new CommandResolver(
    cliPath !== undefined ? { shell: null, pathEnv: cliPath, fallbackDirs: [] } : {},
  )
  providers = createProviders({
    lmstudioUrl: testOverride('ORDO_LMSTUDIO_URL'),
    ollamaUrl: testOverride('ORDO_OLLAMA_URL'),
    resolver,
  })
}

const message = (err: unknown) =>
  err instanceof AiError ? err.message : 'Something went wrong talking to the model. Try again.'

/** A cloud provider may only be used once the user has agreed to it in Settings, and it's saved. */
function allowed(ai: AiSettings, id: ProviderId): boolean {
  return !isCloudProvider(id) || (ai.provider === id && ai.cloudConsent === id)
}

export async function status(refresh = false): Promise<AiProviderStatus[]> {
  if (refresh) resolver.clear()
  return Promise.all(
    PROVIDERS.map(async (info) => {
      const p = providers[info.id]
      const found = await p.detect()
      const models = found.available ? await p.listModels().catch(() => []) : []
      return {
        ...info,
        ...found,
        detail: found.detail ?? '',
        models,
        recommended: recommendedModel(info.id, models),
      }
    }),
  )
}

const TEST_SYSTEM = 'You are checking that a connection works. Reply with one short, friendly sentence.'
const TEST_PROMPT = 'Say hello to Ordo in five words or fewer.'

export async function test(input: AiTestInput): Promise<AiTestResult> {
  const parsed = AiTestInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'Choose a provider first.' }
  const { provider, model } = parsed.data
  if (!allowed(readSettings(settingsFile()).ai, provider))
    return { ok: false, message: 'Confirm that Ordo may use this provider first.' }
  const started = performance.now()
  try {
    const res = await providers[provider].complete({
      system: TEST_SYSTEM,
      prompt: TEST_PROMPT,
      model: model ?? undefined,
      // Loading a large local model the first time can take a while.
      timeoutMs: 120_000,
    })
    const reply = res.text.trim().replace(/\s+/g, ' ').slice(0, 200)
    return { ok: true, reply, latencyMs: Math.round(performance.now() - started), model }
  } catch (err) {
    return { ok: false, message: message(err) }
  }
}

let running: AbortController | null = null

/** The model a sort uses: the saved one, or the provider's recommended one. Cache keys depend on it. */
async function resolveModel(ai: AiSettings): Promise<string | undefined> {
  if (ai.provider === 'none') return undefined
  if (ai.model) return ai.model
  return recommendedModel(ai.provider, await providers[ai.provider].listModels()) ?? undefined
}

/**
 * The sender list, with earlier AI answers applied from the cache when AI sorting is on.
 * Never asks a model; if anything goes wrong it falls back to the rules alone.
 */
export async function sendersWithAi() {
  const list = senders()
  const ai = readSettings(settingsFile()).ai
  if (ai.provider === 'none' || !ai.sortSenders || !allowed(ai, ai.provider)) return list
  try {
    const result = await aiCategorise(list, providers[ai.provider], {
      model: await resolveModel(ai),
      cache: mailStore(),
      cacheOnly: true,
    })
    return result.senders
  } catch {
    return list
  }
}

/** The saved AI preferences (provider, model, consent). */
export const aiSettings = (): AiSettings => readSettings(settingsFile()).ai

/** Ask the saved model about the senders. Cloud providers need saved consent, as everywhere. */
export async function categoriseSenders(
  input: AiSortInput = {},
  onProgress?: (p: AiSortProgress) => void,
): Promise<AiSortOutcome> {
  const parsed = AiSortInputSchema.safeParse(input ?? {})
  if (!parsed.success) return { ok: false, message: 'Invalid request.' }
  const ai = readSettings(settingsFile()).ai
  if (ai.provider === 'none') return { ok: false, message: 'Choose a model in Settings → AI first.' }
  if (!allowed(ai, ai.provider))
    return { ok: false, message: 'Confirm that Ordo may use this provider first.' }
  if (running) return { ok: false, message: 'Sorting is already running.' }

  const ctrl = (running = new AbortController())
  const provider = providers[ai.provider]
  try {
    const result = await withWriteLock('sorting senders with AI', async () => {
      const model = await resolveModel(ai)
      return aiCategorise(senders(), provider, {
        model,
        scope: parsed.data.scope,
        cache: mailStore(),
        // A local model answers one request at a time anyway.
        concurrency: provider.kind === 'local' ? 1 : 2,
        timeoutMs: 180_000,
        signal: ctrl.signal,
        onProgress,
      })
    })
    if (result instanceof Locked) return { ok: false, error: 'locked', message: result.message }
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, message: message(err) }
  } finally {
    running = null
  }
}

export function stop(): void {
  running?.abort()
}

/** Find the model providers. Call once at start-up, in the app and in headless mode. */
export function initAi(): void {
  makeProviders()
  app.on('before-quit', stop)
}

/** Serve the AI IPC channels. Call once, after `initAi` and before the first window opens. */
export function registerAiIpc(): void {
  ipcMain.handle(AI_IPC.aiStatus, (_e, refresh?: boolean) => status(refresh === true))
  ipcMain.handle(AI_IPC.aiTest, (_e, input: AiTestInput) => test(input))
  ipcMain.handle(AI_IPC.aiCategorise, (e, input?: AiSortInput) =>
    categoriseSenders(input, toRenderer(e.sender, AI_IPC.aiProgress)),
  )
  ipcMain.handle(AI_IPC.aiStop, () => stop())
}
