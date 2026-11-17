import { join } from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'
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
  type AiTestInput,
  type AiTestResult,
} from '@ordo/shared'
import { mailStore, senders } from './mail'
import { readSettings } from './settings'

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

export async function categoriseSenders(
  sender: WebContents,
  input: AiSortInput = {},
): Promise<AiSortOutcome> {
  const parsed = AiSortInputSchema.safeParse(input ?? {})
  if (!parsed.success) return { ok: false, message: 'Invalid request.' }
  const ai = readSettings(settingsFile()).ai
  if (ai.provider === 'none') return { ok: false, message: 'Choose a model in Settings → AI first.' }
  if (!allowed(ai, ai.provider))
    return { ok: false, message: 'Confirm that Ordo may use this provider first.' }
  if (running) return { ok: false, message: 'Sorting is already running.' }

  running = new AbortController()
  const provider = providers[ai.provider]
  try {
    const model = ai.model ?? recommendedModel(ai.provider, await provider.listModels()) ?? undefined
    const result = await aiCategorise(senders(), provider, {
      model,
      scope: parsed.data.scope,
      cache: mailStore(),
      // A local model answers one request at a time anyway.
      concurrency: provider.kind === 'local' ? 1 : 2,
      timeoutMs: 180_000,
      signal: running.signal,
      onProgress: (p) => !sender.isDestroyed() && sender.send(AI_IPC.aiProgress, p),
    })
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

/** Serve the AI IPC channels. Call once, before the first window opens. */
export function setupAi(): void {
  makeProviders()
  ipcMain.handle(AI_IPC.aiStatus, (_e, refresh?: boolean) => status(refresh === true))
  ipcMain.handle(AI_IPC.aiTest, (_e, input: AiTestInput) => test(input))
  ipcMain.handle(AI_IPC.aiCategorise, (e, input?: AiSortInput) => categoriseSenders(e.sender, input))
  ipcMain.handle(AI_IPC.aiStop, () => stop())
  app.on('before-quit', stop)
}
