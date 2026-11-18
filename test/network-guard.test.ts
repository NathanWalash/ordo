import dns from 'node:dns'
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import tls from 'node:tls'
import { ImapFlow } from 'imapflow'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isLoopback, NetworkBlockedError } from './network-guard'

const BLOCKED = /Unit tests may not use the network/

describe('the unit test network guard', () => {
  it('blocks connecting to iCloud IMAP, however it is asked', async () => {
    expect(() => tls.connect({ host: 'imap.mail.me.com', port: 993 })).toThrow(NetworkBlockedError)
    expect(() => tls.connect(993, 'imap.mail.me.com')).toThrow(BLOCKED)
    expect(() => net.connect(993, 'imap.mail.me.com')).toThrow(BLOCKED)
    expect(() => net.createConnection({ host: 'imap.mail.me.com', port: 993 })).toThrow(BLOCKED)
    expect(() => new net.Socket().connect(993, 'imap.mail.me.com')).toThrow(BLOCKED)

    const client = new ImapFlow({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      auth: { user: 'nobody@example.invalid', pass: 'not-a-password' },
      logger: false,
    })
    await expect(client.connect()).rejects.toThrow(BLOCKED)
  })

  it('blocks iCloud SMTP, CalDAV and lookups of real names', async () => {
    expect(() => net.connect(587, 'smtp.mail.me.com')).toThrow(BLOCKED)
    expect(() => https.get('https://caldav.icloud.com/')).toThrow(BLOCKED)
    expect(() => http.get('http://17.0.0.1/')).toThrow(BLOCKED)
    await expect(fetch('https://caldav.icloud.com/')).rejects.toMatchObject({
      cause: expect.any(NetworkBlockedError),
    })
    expect(() => dns.lookup('imap.mail.me.com', () => {})).toThrow(BLOCKED)
    await expect(dns.promises.lookup('imap.mail.me.com')).rejects.toThrow(BLOCKED)
  })

  it('points iCloud settings at a closed local port unless a test sets its own', () => {
    expect(process.env['ORDO_IMAP_HOST']).toBe('127.0.0.1')
    expect(process.env['ORDO_SMTP_HOST']).toBe('127.0.0.1')
    expect(process.env['ORDO_CALDAV_URL']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
  })

  it('knows loopback when it sees it', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      'app.localhost',
    ])
      expect(isLoopback(h), h).toBe(true)
    for (const h of [
      'imap.mail.me.com',
      '17.0.0.1',
      '10.0.0.1',
      '0.0.0.0',
      '::',
      'localhost.example.com',
      '128.0.0.1',
    ])
      expect(isLoopback(h), h).toBe(false)
  })

  describe('loopback still works', () => {
    let server: net.Server
    let port: number
    beforeAll(async () => {
      server = net.createServer((s) => s.end('hello\n'))
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      port = (server.address() as AddressInfo).port
    })
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

    it('for a local test server', async () => {
      for (const host of ['127.0.0.1', 'localhost']) {
        const socket = net.connect({ host, port, family: 4 })
        const [data] = (await once(socket, 'data')) as [Buffer]
        expect(data.toString()).toBe('hello\n')
        socket.destroy()
      }
    })

    it('for a made-up name a test resolves to loopback itself, but not to anywhere else', async () => {
      const fake =
        (address: string) =>
        (_h: string, o: { all?: boolean }, cb: (e: Error | null, a: unknown, f?: number) => void) =>
          o.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)
      const ok = net.connect({ host: 'unsub.example', port, lookup: fake('127.0.0.1') })
      const [data] = (await once(ok, 'data')) as [Buffer]
      expect(data.toString()).toBe('hello\n')
      ok.destroy()

      const bad = net.connect({ host: 'unsub.example', port, lookup: fake('17.0.0.1') })
      const [err] = (await once(bad, 'error')) as [Error]
      expect(err).toBeInstanceOf(NetworkBlockedError)
      expect(err.message).toContain('unsub.example (17.0.0.1)')
    })
  })
})
