import { describe, expect, it, vi } from 'vitest'
import { IMAGE_LIMITS, loadRemoteImages, type ImageFetch } from './images'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function response(status: number, headers: Record<string, string>, body?: Uint8Array) {
  return {
    status,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    body: body
      ? new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(body)
            c.close()
          },
        })
      : null,
  }
}

describe('loadRemoteImages', () => {
  it('returns images as data: URLs, without cookies or a referrer', async () => {
    const fetch = vi.fn<ImageFetch>(async () => response(200, { 'content-type': 'image/png' }, PNG))
    const out = await loadRemoteImages(['https://img.example/a.png', 'https://img.example/a.png'], { fetch })
    expect(out).toEqual({
      images: { 'https://img.example/a.png': 'data:image/png;base64,iVBORw==' },
      failed: 0,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      headers: { 'user-agent': 'Ordo' },
    })
    expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('referer')
  })

  it('refuses plain http, IP addresses and local names before connecting', async () => {
    const fetch = vi.fn<ImageFetch>()
    const out = await loadRemoteImages(
      [
        'http://img.example/a.png',
        'https://127.0.0.1/a.png',
        'https://router/a.png',
        'data:image/png;base64,x',
      ],
      { fetch },
    )
    expect(out).toEqual({ images: {}, failed: 4 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('follows a few redirects, each checked again', async () => {
    const fetch = vi.fn<ImageFetch>(async (url) =>
      url === 'https://img.example/a'
        ? response(302, { location: 'https://cdn.example/a.png' })
        : url === 'https://img.example/b'
          ? response(302, { location: 'https://10.0.0.1/b.png' })
          : response(200, { 'content-type': 'image/png' }, PNG),
    )
    const out = await loadRemoteImages(['https://img.example/a', 'https://img.example/b'], { fetch })
    expect(Object.keys(out.images)).toEqual(['https://img.example/a'])
    expect(out.failed).toBe(1)
    expect(fetch.mock.calls.map((c) => c[0])).not.toContain('https://10.0.0.1/b.png')
  })

  it('refuses things that aren’t images, and images that are too big', async () => {
    const fetch = vi.fn<ImageFetch>(async (url) =>
      url.endsWith('html')
        ? response(200, { 'content-type': 'text/html' }, PNG)
        : url.endsWith('big')
          ? response(
              200,
              { 'content-type': 'image/png', 'content-length': String(IMAGE_LIMITS.bytesEach + 1) },
              PNG,
            )
          : response(404, {}),
    )
    const out = await loadRemoteImages(
      ['https://x.example/html', 'https://x.example/big', 'https://x.example/404'],
      {
        fetch,
      },
    )
    expect(out).toEqual({ images: {}, failed: 3 })
  })

  it('never throws, and counts images past the limit as not loaded', async () => {
    const fetch = vi.fn<ImageFetch>(async () => {
      throw new Error('boom')
    })
    const urls = Array.from({ length: IMAGE_LIMITS.count + 5 }, (_, i) => `https://x.example/${i}.png`)
    const out = await loadRemoteImages(urls, { fetch })
    expect(out.failed).toBe(IMAGE_LIMITS.count + 5)
    expect(fetch).toHaveBeenCalledTimes(IMAGE_LIMITS.count)
  })

  it('allows http to this computer only in test builds', async () => {
    const fetch = vi.fn<ImageFetch>(async () => response(200, { 'content-type': 'image/gif' }, PNG))
    const out = await loadRemoteImages(['http://127.0.0.1:9/a.gif'], { fetch, allowLoopbackHttp: true })
    expect(Object.keys(out.images)).toHaveLength(1)
  })
})
