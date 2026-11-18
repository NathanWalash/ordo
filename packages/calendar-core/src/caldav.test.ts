import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CalDavProvider,
  CalendarAuthError,
  CalendarConnectionError,
  CalendarUnavailableError,
  isReadOnly,
  normaliseColor,
} from './caldav'

describe('normaliseColor', () => {
  it('turns CalDAV colours into #rrggbb', () => {
    expect(normaliseColor('#FF2968FF')).toBe('#ff2968')
    expect(normaliseColor('#1BADF8')).toBe('#1badf8')
    expect(normaliseColor('#abc')).toBe('#aabbcc')
    expect(normaliseColor('blue')).toBeUndefined()
    expect(normaliseColor(undefined)).toBeUndefined()
  })
})

describe('isReadOnly', () => {
  it('is read-only only when privileges are listed without write access', () => {
    expect(isReadOnly(undefined)).toBe(false)
    expect(isReadOnly({ privilege: [{ read: {} }, { readFreeBusy: {} }] })).toBe(true)
    expect(isReadOnly({ privilege: [{ read: {} }, { write: {} }] })).toBe(false)
    expect(isReadOnly({ privilege: { all: {} } })).toBe(false)
  })
})

describe('CalDavProvider errors', () => {
  let server: Server
  let url: string
  beforeAll(async () => {
    // Rejects every request, like iCloud with a wrong app-specific password.
    server = createServer((_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('reports rejected credentials as CalendarAuthError', async () => {
    const p = new CalDavProvider({ serverUrl: url, username: 'you@icloud.com', password: 'wrong' })
    await expect(p.connect()).rejects.toBeInstanceOf(CalendarAuthError)
  })

  it('reports an unreachable server as CalendarConnectionError', async () => {
    const p = new CalDavProvider({
      serverUrl: 'http://127.0.0.1:9/',
      username: 'u',
      password: 'p',
      timeoutMs: 2000,
    })
    await expect(p.connect()).rejects.toBeInstanceOf(CalendarConnectionError)
  })
})

describe('CalDavProvider when the server is busy', () => {
  let server: Server
  let url: string
  beforeAll(async () => {
    // Like iCloud throttling or down for maintenance.
    server = createServer((_req, res) => {
      res.writeHead(503, { 'Retry-After': '120' })
      res.end('Service Unavailable')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it('reports it as CalendarUnavailableError, not a wrong password', async () => {
    const p = new CalDavProvider({
      serverUrl: url,
      username: 'you@icloud.com',
      password: 'abcd-efgh-ijkl-mnop',
    })
    const err = await p.connect().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CalendarUnavailableError)
    expect(err).not.toBeInstanceOf(CalendarAuthError)
  })
})
