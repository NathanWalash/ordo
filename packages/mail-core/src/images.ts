// Remote images in an email, fetched only after the user asks ("Load images"), by the main
// process: no cookies, no referrer, public internet only, images only, small. The window gets
// data: URLs back, so the message frame itself never connects anywhere.
import { hostRefusal } from './url-guard'
import { isSecureUrl } from './unsubscribe'

export const IMAGE_LIMITS = {
  /** Images loaded for one message. */
  count: 60,
  bytesEach: 3 * 1024 * 1024,
  bytesTotal: 20 * 1024 * 1024,
  timeoutMs: 10_000,
  redirects: 3,
  concurrency: 4,
} as const

const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/

export type ImageFetch = (
  url: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    redirect: 'manual'
    credentials: 'omit'
    signal: AbortSignal
  },
) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  body: ReadableStream<Uint8Array> | null
}>

export interface LoadImagesOptions {
  /** Must refuse private and local addresses at connect time (createGuardedFetch). */
  fetch: ImageFetch
  /** Test-only: allow http://127.0.0.1. */
  allowLoopbackHttp?: boolean
}

export interface LoadedImages {
  /** Image URL to data: URL. */
  images: Record<string, string>
  /** How many couldn't be loaded (refused, not an image, too big, unreachable). */
  failed: number
}

/** Fetch one image and return it as a data: URL, or null. Never throws. */
async function loadOne(
  url: string,
  opts: LoadImagesOptions,
  budget: { left: number },
): Promise<string | null> {
  const signal = AbortSignal.timeout(IMAGE_LIMITS.timeoutMs)
  let current = url
  try {
    for (let hop = 0; hop <= IMAGE_LIMITS.redirects; hop++) {
      if (!isSecureUrl(current, { allowLoopbackHttp: opts.allowLoopbackHttp })) return null
      if (hostRefusal(current, { allowLoopback: opts.allowLoopbackHttp })) return null
      const res = await opts.fetch(current, {
        method: 'GET',
        headers: { accept: 'image/*', 'user-agent': 'Ordo' },
        redirect: 'manual',
        credentials: 'omit',
        signal,
      })
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => {})
        current = new URL(location, current).href
        continue
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        return null
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const length = Number(res.headers.get('content-length') ?? 0)
      if (!IMAGE_TYPES.test(type) || length > IMAGE_LIMITS.bytesEach || length > budget.left || !res.body) {
        await res.body?.cancel().catch(() => {})
        return null
      }
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > IMAGE_LIMITS.bytesEach || size > budget.left) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
      budget.left -= size
      return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`
    }
    return null
  } catch {
    return null
  }
}

/** Load the images the user asked for, a few at a time, within the limits above. */
export async function loadRemoteImages(
  urls: readonly string[],
  opts: LoadImagesOptions,
): Promise<LoadedImages> {
  const all = [...new Set(urls)]
  const unique = all.slice(0, IMAGE_LIMITS.count)
  // Images past the limit aren't fetched at all.
  const out: LoadedImages = { images: {}, failed: all.length - unique.length }
  const budget = { left: IMAGE_LIMITS.bytesTotal }
  const queue = [...unique]
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      const data = await loadOne(url, opts, budget)
      if (data) out.images[url] = data
      else out.failed++
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMAGE_LIMITS.concurrency, queue.length) }, worker))
  return out
}
