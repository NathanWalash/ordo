import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AiError } from '../types'
import { LmStudioProvider, OllamaProvider } from './local'

type Handler = (req: IncomingMessage & { json?: unknown }, res: ServerResponse) => void

let server: Server | null = null
const requests: { method?: string; url?: string; json?: unknown }[] = []

/** Start a fake model server on a free port; returns its base URL. */
async function serve(handler: Handler): Promise<string> {
  requests.length = 0
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const json = body ? JSON.parse(body) : undefined
      requests.push({ method: req.method, url: req.url, json })
      handler(Object.assign(req, { json }), res)
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A port with nothing listening on it. */
async function closedPort(): Promise<string> {
  const url = await serve(() => {})
  await new Promise((r) => server!.close(r))
  server = null
  return url
}

afterEach(async () => {
  server?.closeAllConnections()
  await new Promise((r) => (server ? server.close(r) : r(null)))
  server = null
})

const lmStudio: Handler = (req, res) => {
  if (req.url === '/v1/models')
    return send(res, 200, {
      object: 'list',
      data: [
        { id: 'openai/gpt-oss-20b', object: 'model' },
        { id: 'gemma-4-26b-a4b-qat', object: 'model' },
        { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model' },
      ],
    })
  if (req.url === '/v1/chat/completions')
    return send(res, 200, {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      choices: [
        { index: 0, message: { role: 'assistant', content: '{"word":"yes"}' }, finish_reason: 'stop' },
      ],
    })
  send(res, 404, { error: 'Unexpected endpoint or method.' })
}

describe('LmStudioProvider', () => {
  it('lists chat models and reports itself running', async () => {
    const p = new LmStudioProvider(await serve(lmStudio))
    expect(await p.listModels()).toEqual(['openai/gpt-oss-20b', 'gemma-4-26b-a4b-qat'])
    expect(await p.detect()).toEqual({ available: true, state: 'ready', detail: 'Running · 2 models' })
  })

  it('accepts a base URL with or without /v1', async () => {
    const url = await serve(lmStudio)
    expect(await new LmStudioProvider(`${url}/v1/`).listModels()).toHaveLength(2)
  })

  it('sends a chat completion with a json_schema response format', async () => {
    const p = new LmStudioProvider(await serve(lmStudio))
    const schema = { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] }
    const res = await p.complete({ system: 'sys', prompt: 'hi', model: 'openai/gpt-oss-20b', schema })
    expect(res).toEqual({ text: '{"word":"yes"}' })
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      url: '/v1/chat/completions',
      json: {
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0,
        stream: false,
        response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true, schema } },
      },
    })
  })

  it('uses the first model when none is chosen, and no response_format without a schema', async () => {
    const p = new LmStudioProvider(await serve(lmStudio))
    await p.complete({ system: 's', prompt: 'p' })
    const body = requests.at(-1)!.json as Record<string, unknown>
    expect(body['model']).toBe('openai/gpt-oss-20b')
    expect(body).not.toHaveProperty('response_format')
  })

  it('reports not running when nothing is listening', async () => {
    const p = new LmStudioProvider(await closedPort())
    expect(await p.detect()).toEqual({
      available: false,
      state: 'not-running',
      detail: 'Not running. Open LM Studio.',
    })
    const err = await p.complete({ system: 's', prompt: 'p', model: 'm' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'unavailable' })
  })

  it('says when no models are downloaded', async () => {
    const p = new LmStudioProvider(await serve((_req, res) => send(res, 200, { data: [] })))
    expect(await p.detect()).toMatchObject({ available: false, state: 'error' })
  })

  it("surfaces the server's error message", async () => {
    const p = new LmStudioProvider(
      await serve((_req, res) => send(res, 400, { error: { message: 'Model not loaded' } })),
    )
    await expect(p.complete({ system: 's', prompt: 'p', model: 'm' })).rejects.toThrow(
      'LM Studio couldn’t answer (error 400: Model not loaded). Check it’s running with a model loaded, then try again.',
    )
  })

  it('rejects a reply in the wrong shape', async () => {
    const p = new LmStudioProvider(await serve((_req, res) => send(res, 200, { nope: true })))
    await expect(p.complete({ system: 's', prompt: 'p', model: 'm' })).rejects.toMatchObject({
      code: 'bad-response',
    })
  })

  it('times out a server that never answers', async () => {
    const p = new LmStudioProvider(await serve(() => {}))
    const err = await p.complete({ system: 's', prompt: 'p', model: 'm', timeoutMs: 100 }).catch((e) => e)
    expect(err).toBeInstanceOf(AiError)
    expect(err).toMatchObject({ code: 'timeout' })
  })

  it('stops when the caller aborts', async () => {
    const p = new LmStudioProvider(await serve(() => {}))
    const c = new AbortController()
    const pending = p.complete({ system: 's', prompt: 'p', model: 'm', signal: c.signal })
    setTimeout(() => c.abort(), 30)
    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })
})

const ollama: Handler = (req, res) => {
  if (req.url === '/api/tags')
    return send(res, 200, {
      models: [
        { name: 'gpt-oss:20b', model: 'gpt-oss:20b', size: 1 },
        { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', size: 1 },
      ],
    })
  if (req.url === '/api/chat')
    return send(res, 200, {
      model: 'gpt-oss:20b',
      message: { role: 'assistant', content: '{"word":"no"}' },
      done: true,
    })
  send(res, 404, { error: 'not found' })
}

describe('OllamaProvider', () => {
  it('lists chat models and reports itself running', async () => {
    const p = new OllamaProvider(await serve(ollama))
    expect(await p.listModels()).toEqual(['gpt-oss:20b'])
    expect(await p.detect()).toEqual({ available: true, state: 'ready', detail: 'Running · 1 model' })
  })

  it('sends /api/chat with the schema as format and streaming off', async () => {
    const p = new OllamaProvider(await serve(ollama))
    const schema = { type: 'object' }
    expect(await p.complete({ system: 'sys', prompt: 'hi', model: 'gpt-oss:20b', schema })).toEqual({
      text: '{"word":"no"}',
    })
    expect(requests.at(-1)).toEqual({
      method: 'POST',
      url: '/api/chat',
      json: {
        model: 'gpt-oss:20b',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        stream: false,
        options: { temperature: 0 },
        format: schema,
      },
    })
  })

  it('reports not running when nothing is listening', async () => {
    const p = new OllamaProvider(await closedPort())
    expect(await p.detect()).toMatchObject({ available: false, state: 'not-running' })
  })

  it("surfaces Ollama's error string", async () => {
    const p = new OllamaProvider(await serve((_req, res) => send(res, 404, { error: "model 'x' not found" })))
    await expect(p.complete({ system: 's', prompt: 'p', model: 'x' })).rejects.toThrow(
      "Ollama couldn’t answer (error 404: model 'x' not found). Check it’s running with a model loaded, then try again.",
    )
  })
})
