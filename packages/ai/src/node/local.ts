import { z } from 'zod'
import {
  AiError,
  type CompleteRequest,
  type CompleteResult,
  type DetectResult,
  type ModelProvider,
} from '../types'
import { requestJson } from './http'

const DETECT_TIMEOUT_MS = 2_000
const DEFAULT_TIMEOUT_MS = 120_000

function plural(n: number, one: string) {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function parseShape<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new AiError('bad-response', `${what} sent a reply Ordo doesn't understand.`)
  return parsed.data
}

async function detectLocal(p: ModelProvider, app: string): Promise<DetectResult> {
  try {
    const models = await p.listModels()
    if (!models.length)
      return {
        available: false,
        state: 'error',
        detail: `Running, but no models yet. Download one in ${app}.`,
      }
    return { available: true, state: 'ready', detail: `Running · ${plural(models.length, 'model')}` }
  } catch (err) {
    if (err instanceof AiError && (err.code === 'unavailable' || err.code === 'timeout'))
      return { available: false, state: 'not-running', detail: `Not running. Open ${app}.` }
    return { available: false, state: 'error', detail: err instanceof Error ? err.message : String(err) }
  }
}

const OpenAiModels = z.object({ data: z.array(z.object({ id: z.string() })) })
const OpenAiChat = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }) })).min(1),
})

/**
 * LM Studio's OpenAI-compatible server (Developer → Start server, port 1234 by default).
 * Structured output uses `response_format: json_schema`, which LM Studio enforces with a grammar.
 */
export class LmStudioProvider implements ModelProvider {
  readonly id = 'lmstudio' as const
  readonly label = 'LM Studio'
  readonly kind = 'local' as const
  private readonly base: string

  constructor(baseUrl = 'http://127.0.0.1:1234') {
    this.base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  }

  detect() {
    return detectLocal(this, 'LM Studio')
  }

  async listModels(): Promise<string[]> {
    const body = await requestJson(`${this.base}/v1/models`, {
      what: this.label,
      timeoutMs: DETECT_TIMEOUT_MS,
    })
    // Embedding models can't chat.
    return parseShape(OpenAiModels, body, this.label)
      .data.map((m) => m.id)
      .filter((id) => !/embed/i.test(id))
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const model = req.model ?? (await this.listModels())[0]
    if (!model) throw new AiError('unavailable', 'LM Studio has no models. Download one first.')
    const body = await requestJson(`${this.base}/v1/chat/completions`, {
      what: this.label,
      method: 'POST',
      signal: req.signal,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      body: {
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        temperature: 0,
        stream: false,
        ...(req.schema && {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'reply', strict: true, schema: req.schema },
          },
        }),
      },
    })
    const text = parseShape(OpenAiChat, body, this.label).choices[0]!.message.content
    if (!text) throw new AiError('bad-response', 'LM Studio returned an empty reply.')
    return { text }
  }
}

const OllamaTags = z.object({ models: z.array(z.object({ name: z.string() })) })
const OllamaChat = z.object({ message: z.object({ content: z.string() }) })

/** Ollama's native API on port 11434. Structured output passes the JSON Schema as `format`. */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama' as const
  readonly label = 'Ollama'
  readonly kind = 'local' as const
  private readonly base: string

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.base = baseUrl.replace(/\/+$/, '')
  }

  detect() {
    return detectLocal(this, 'Ollama')
  }

  async listModels(): Promise<string[]> {
    const body = await requestJson(`${this.base}/api/tags`, {
      what: this.label,
      timeoutMs: DETECT_TIMEOUT_MS,
    })
    return parseShape(OllamaTags, body, this.label)
      .models.map((m) => m.name)
      .filter((id) => !/embed/i.test(id))
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const model = req.model ?? (await this.listModels())[0]
    if (!model) throw new AiError('unavailable', 'Ollama has no models. Run `ollama pull gpt-oss:20b` first.')
    const body = await requestJson(`${this.base}/api/chat`, {
      what: this.label,
      method: 'POST',
      signal: req.signal,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      body: {
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        stream: false,
        options: { temperature: 0 },
        ...(req.schema && { format: req.schema }),
      },
    })
    const text = parseShape(OllamaChat, body, this.label).message.content
    if (!text) throw new AiError('bad-response', 'Ollama returned an empty reply.')
    return { text }
  }
}
