import { deadline } from '../limit'
import { AiError } from '../types'

export interface HttpOptions {
  /** Shown in errors, e.g. "LM Studio". */
  what: string
  method?: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

function errorText(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) return undefined
  const e = body.error
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') return e.message
  return undefined
}

/** Fetch JSON from a local model server, turning every failure into an AiError. */
export async function requestJson(url: string, opts: HttpOptions): Promise<unknown> {
  const d = deadline(opts.signal, opts.timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: opts.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: d.signal,
      })
    } catch (err) {
      if (d.signal.aborted) throw err
      throw new AiError('unavailable', `${opts.what} isn't running at ${new URL(url).host}.`, { cause: err })
    }
    const text = await res.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (!res.ok) {
      const why = errorText(body) ?? (text.slice(0, 200) || res.statusText)
      throw new AiError('failed', `${opts.what} returned an error (${res.status}): ${why}`)
    }
    if (body === undefined) throw new AiError('bad-response', `${opts.what} sent a reply that isn't JSON.`)
    return body
  } catch (err) {
    throw d.explain(err, opts.what)
  } finally {
    d.dispose()
  }
}
