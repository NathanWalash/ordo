import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createGuardedFetch, createGuardedLookup, type Resolver } from './net-guard'
import { executeUnsubscribe, type FetchLike, type UnsubscribeDeps } from './unsubscribe-run'

const answer =
  (...addresses: string[]): Resolver =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

const deps = (fetch: FetchLike, over: Partial<UnsubscribeDeps> = {}): UnsubscribeDeps => ({
  fetch,
  openExternal: async () => {},
  sendMail: async () => {},
  ...over,
})

describe('createGuardedLookup', () => {
  const lookup = (resolve: Resolver, all = false) =>
    new Promise<unknown>((ok, fail) =>
      createGuardedLookup({ resolve })('list.example', { all }, (err, address) =>
        err ? fail(err) : ok(address),
      ),
    )

  it('passes public addresses through in either callback shape', async () => {
    await expect(lookup(answer('93.184.215.14'))).resolves.toBe('93.184.215.14')
    await expect(lookup(answer('93.184.215.14', '2606:4700::1'), true)).resolves.toHaveLength(2)
  })

  it('refuses a public name that resolves to a private address', async () => {
    await expect(lookup(answer('10.0.0.7'))).rejects.toMatchObject({ code: 'ORDO_BLOCKED_ADDRESS' })
  })

  it('refuses when any of several answers is private', async () => {
    await expect(lookup(answer('93.184.215.14', '169.254.169.254'), true)).rejects.toThrow(/169\.254/)
  })
})

describe('createGuardedFetch', () => {
  let server: Server
  let port = 0
  const hits: string[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`)
      if (req.url === '/to-private') {
        res.writeHead(302, { location: 'https://192.168.1.1/admin' })
        return res.end()
      }
      if (req.url === '/to-rebound') {
        res.writeHead(307, { location: `https://rebound.example:${port}/ok` })
        return res.end()
      }
      res.writeHead(200).end('ok')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('refuses a public hostname that resolves to a private IP, before connecting', async () => {
    const resolve = vi.fn(answer('127.0.0.1'))
    const out = await executeUnsubscribe(
      { kind: 'one-click', url: `https://unsub.example:${port}/u` },
      deps(createGuardedFetch({ resolve })),
    )
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringMatching(/Refused.*127\.0\.0\.1/) })
    expect(resolve).toHaveBeenCalledWith('unsub.example')
    expect(hits).toEqual([])
  })

  it('connects to exactly the address it checked', async () => {
    // This name doesn't exist in real DNS: it reaches the test server only through the guarded lookup.
    const fetch = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    const res = await fetch(`http://unsub.example:${port}/u`, {
      method: 'POST',
      headers: {},
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(5000),
    })
    expect(res.status).toBe(200)
    expect(hits).toContain('POST /u')
  })

  it('refuses a redirect to a private IP literal', async () => {
    const fetch = createGuardedFetch({ resolve: answer('127.0.0.1'), allowLoopback: true })
    hits.length = 0
    const out = await executeUnsubscribe(
      { kind: 'one-click', url: `http://127.0.0.1:${port}/to-private` },
      deps(fetch, { allowLoopbackHttp: true }),
    )
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringMatching(/^Refused a redirect/) })
    expect(hits).toEqual(['POST /to-private'])
  })

  it('checks DNS again on every redirect hop', async () => {
    const resolve = vi.fn(answer('10.1.2.3'))
    const fetch = createGuardedFetch({ resolve, allowLoopback: true })
    hits.length = 0
    const out = await executeUnsubscribe(
      { kind: 'one-click', url: `http://127.0.0.1:${port}/to-rebound` },
      deps(fetch, { allowLoopbackHttp: true }),
    )
    expect(resolve).toHaveBeenCalledWith('rebound.example')
    expect(out).toMatchObject({ status: 'failed', detail: expect.stringMatching(/10\.1\.2\.3/) })
    expect(hits).toEqual(['POST /to-rebound'])
  })
})
