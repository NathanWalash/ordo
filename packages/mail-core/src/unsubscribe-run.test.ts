import { describe, expect, it, vi } from 'vitest'
import { executeUnsubscribe, type FetchLike, type UnsubscribeDeps } from './unsubscribe-run'

type Call = { url: string; init: Parameters<FetchLike>[1] }

/** A fake fetch that answers from a script of responses, recording every request. */
function fakeFetch(...responses: { status: number; location?: string }[]) {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const r = responses.shift() ?? { status: 200 }
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (n: string) => (n.toLowerCase() === 'location' ? (r.location ?? null) : null) },
    }
  }
  return { fetch, calls }
}

const deps = (over: Partial<UnsubscribeDeps> = {}): UnsubscribeDeps => ({
  fetch: fakeFetch().fetch,
  openExternal: vi.fn(async () => {}),
  sendMail: vi.fn(async () => {}),
  ...over,
})

const oneClick = { kind: 'one-click', url: 'https://list.example/u?id=1' } as const

describe('executeUnsubscribe: one-click', () => {
  it('POSTs the RFC 8058 body with a generic user agent and no cookies', async () => {
    const f = fakeFetch({ status: 200 })
    expect(await executeUnsubscribe(oneClick, deps({ fetch: f.fetch }))).toEqual({
      status: 'done',
      method: 'one-click',
    })
    expect(f.calls).toHaveLength(1)
    const { url, init } = f.calls[0]!
    expect(url).toBe('https://list.example/u?id=1')
    expect(init).toMatchObject({
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      redirect: 'manual',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Ordo' },
    })
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('cookie')
  })

  it('records a 4xx as a failure with the status', async () => {
    const f = fakeFetch({ status: 404 })
    expect(await executeUnsubscribe(oneClick, deps({ fetch: f.fetch }))).toEqual({
      status: 'failed',
      method: 'one-click',
      detail: 'The server answered 404',
    })
  })

  it('follows https redirects, keeping POST only for 307/308', async () => {
    const f = fakeFetch(
      { status: 307, location: '/again' },
      { status: 303, location: 'https://list.example/done' },
      { status: 200 },
    )
    expect((await executeUnsubscribe(oneClick, deps({ fetch: f.fetch }))).status).toBe('done')
    expect(f.calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', 'https://list.example/u?id=1'],
      ['POST', 'https://list.example/again'],
      ['GET', 'https://list.example/done'],
    ])
  })

  it('refuses a redirect to plain http', async () => {
    const f = fakeFetch({ status: 302, location: 'http://list.example/u' })
    const out = await executeUnsubscribe(oneClick, deps({ fetch: f.fetch }))
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringMatching(/redirect.*https/) })
    expect(f.calls).toHaveLength(1)
  })

  it('gives up after a few redirects', async () => {
    const loop = { status: 302, location: 'https://list.example/loop' }
    const f = fakeFetch(loop, loop, loop, loop, loop)
    const out = await executeUnsubscribe(oneClick, deps({ fetch: f.fetch, maxRedirects: 3 }))
    expect(out).toMatchObject({ status: 'failed', detail: 'Too many redirects' })
    expect(f.calls).toHaveLength(4)
  })

  it('times out', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(init.signal.reason)),
      )
    const out = await executeUnsubscribe(oneClick, deps({ fetch: hang, timeoutMs: 30 }))
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringMatching(/No answer within/) })
  })

  it('reports network errors', async () => {
    const out = await executeUnsubscribe(
      oneClick,
      deps({
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND')
        },
      }),
    )
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringContaining('ENOTFOUND') })
  })

  it('refuses non-https one-click URLs unless loopback http is allowed for tests', async () => {
    const local = { kind: 'one-click', url: 'http://127.0.0.1:9999/u' } as const
    const f = fakeFetch({ status: 200 })
    expect((await executeUnsubscribe(local, deps({ fetch: f.fetch }))).status).toBe('failed')
    expect(f.calls).toHaveLength(0)
    expect((await executeUnsubscribe(local, deps({ fetch: f.fetch, allowLoopbackHttp: true }))).status).toBe(
      'done',
    )
  })
})

describe('executeUnsubscribe: link and mailto', () => {
  it('opens https links in the browser', async () => {
    const d = deps()
    const out = await executeUnsubscribe({ kind: 'link', url: 'https://list.example/prefs' }, d)
    expect(out.status).toBe('opened')
    expect(d.openExternal).toHaveBeenCalledWith('https://list.example/prefs')
  })

  it('opens plain http links only once the user has confirmed them', async () => {
    const d = deps()
    const link = { kind: 'link', url: 'http://list.example/prefs' } as const
    expect((await executeUnsubscribe(link, d)).status).toBe('failed')
    expect(d.openExternal).not.toHaveBeenCalled()
    expect((await executeUnsubscribe(link, d, { insecureLinkConfirmed: true })).status).toBe('opened')
  })

  it('never opens other schemes', async () => {
    const d = deps()
    const out = await executeUnsubscribe({ kind: 'link', url: 'file:///etc/passwd' }, d, {
      insecureLinkConfirmed: true,
    })
    expect(out.status).toBe('failed')
    expect(d.openExternal).not.toHaveBeenCalled()
  })

  it('sends a mailto unsubscribe with its subject and body', async () => {
    const d = deps()
    const out = await executeUnsubscribe(
      { kind: 'mailto', address: 'leave@x.example', url: 'mailto:leave@x.example?subject=Remove%20me' },
      d,
    )
    expect(out.status).toBe('done')
    expect(d.sendMail).toHaveBeenCalledWith({
      to: ['leave@x.example'],
      subject: 'Remove me',
      body: 'unsubscribe',
    })
  })

  it('turns a sending error into a failure', async () => {
    const d = deps({
      sendMail: async () => {
        throw new Error('535 Authentication failed')
      },
    })
    const out = await executeUnsubscribe(
      { kind: 'mailto', address: 'leave@x.example', url: 'mailto:leave@x.example' },
      d,
    )
    expect(out).toEqual({ status: 'failed', method: 'mailto', detail: '535 Authentication failed' })
  })

  it('skips senders without a method', async () => {
    expect((await executeUnsubscribe({ kind: 'none' }, deps())).status).toBe('skipped')
  })
})
