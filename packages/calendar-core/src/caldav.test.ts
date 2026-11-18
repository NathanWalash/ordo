import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CalDavProvider,
  CalendarAuthError,
  CalendarConnectionError,
  CalendarWriteError,
  inside,
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

describe('inside', () => {
  const cal = 'https://p01-caldav.icloud.com/123/calendars/home/'
  it('only allows objects directly inside the calendar, on the same server', () => {
    expect(inside(cal, `${cal}event.ics`)).toBe(true)
    expect(inside(cal.slice(0, -1), `${cal}event.ics`)).toBe(true)
    expect(inside(cal, '/123/calendars/home/event.ics')).toBe(true)
    expect(inside(cal, 'https://evil.example/123/calendars/home/event.ics')).toBe(false)
    expect(inside(cal, 'http://p01-caldav.icloud.com/123/calendars/home/event.ics')).toBe(false)
    expect(inside(cal, `${cal}../work/event.ics`)).toBe(false)
    expect(inside(cal, `${cal}%2e%2e/work/event.ics`)).toBe(false)
    expect(inside(cal, `${cal}sub/event.ics`)).toBe(false)
    expect(inside(cal, 'https://p01-caldav.icloud.com/123/calendars/homework/event.ics')).toBe(false)
    expect(inside(cal, cal)).toBe(false)
  })
})

describe('CalDavProvider writes', () => {
  let server: Server
  let base: string
  const seen: { method: string; url: string; ifMatch?: string; ifNoneMatch?: string }[] = []
  let status = 201

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({
        method: req.method!,
        url: req.url!,
        ifMatch: req.headers['if-match'] as string | undefined,
        ifNoneMatch: req.headers['if-none-match'] as string | undefined,
      })
      req.resume()
      req.on('end', () => res.writeHead(status, status < 300 ? { ETag: '"e2"' } : {}).end())
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cal/home/`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const provider = () => new CalDavProvider({ serverUrl: base, username: 'u', password: 'p' })

  it('creates with If-None-Match and changes with If-Match', async () => {
    status = 201
    const created = await provider().createResource(base, 'ABC-1', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    expect(created).toEqual({ href: `${base}ABC-1.ics`, etag: '"e2"' })
    status = 204
    await provider().updateResource(base, `${base}ABC-1.ics`, 'x', '"e1"')
    await provider().deleteResource(base, `${base}ABC-1.ics`, '"e2"')
    expect(seen.slice(-3)).toEqual([
      { method: 'PUT', url: '/cal/home/ABC-1.ics', ifNoneMatch: '*', ifMatch: undefined },
      { method: 'PUT', url: '/cal/home/ABC-1.ics', ifMatch: '"e1"', ifNoneMatch: undefined },
      { method: 'DELETE', url: '/cal/home/ABC-1.ics', ifMatch: '"e2"', ifNoneMatch: undefined },
    ])
  })

  it('turns 412, 404, 403 and other errors into CalendarWriteError kinds', async () => {
    const kinds: [number, string][] = [
      [412, 'conflict'],
      [404, 'gone'],
      [410, 'gone'],
      [403, 'forbidden'],
      [500, 'failed'],
    ]
    for (const [code, kind] of kinds) {
      status = code
      const attempt = provider().updateResource(base, `${base}a.ics`, 'x', '"e1"')
      await expect(attempt).rejects.toBeInstanceOf(CalendarWriteError)
      await expect(attempt).rejects.toMatchObject({ kind, status: code })
    }
    status = 401
    await expect(provider().deleteResource(base, `${base}a.ics`, '"e1"')).rejects.toBeInstanceOf(
      CalendarAuthError,
    )
  })

  it('never sends a change outside the calendar', async () => {
    const before = seen.length
    await expect(
      provider().updateResource(base, 'http://127.0.0.1:9/elsewhere.ics', 'x', '"1"'),
    ).rejects.toMatchObject({
      kind: 'failed',
    })
    await expect(provider().deleteResource(base, `${base}../other/x.ics`, '"1"')).rejects.toBeInstanceOf(
      CalendarWriteError,
    )
    expect(seen.length).toBe(before)
  })

  it('makes a safe file name from any UID', async () => {
    status = 201
    const r = await provider().createResource(base, '../../evil/<uid>', 'x')
    expect(r.href).toBe(`${base}.._.._evil__uid_.ics`)
    expect(inside(base, r.href)).toBe(true)
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
