import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyImapError,
  MailAuthError,
  MailConnectionError,
  MailUnavailableError,
  testImapLogin,
} from './imap'

// How each way an iCloud sign-in can fail reaches the app. A tiny fake IMAP server plays the
// part of iCloud, so these run without Docker or the network.

type Script = (socket: Socket, line: string | null) => void

let server: Server | null = null
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

/** Start a server that calls `script` on connect (line null) and for each command line. */
async function fakeImap(script: Script): Promise<number> {
  server = createServer((socket) => {
    socket.on('error', () => {})
    let buffer = ''
    script(socket, null)
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let i: number
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        script(socket, line)
      }
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return (server!.address() as { port: number }).port
}

const GREETING = '* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] iCloud IMAP ready\r\n'

/** Greets, then answers LOGIN (or AUTHENTICATE) with `answer`. */
const refuseLogin =
  (answer: string): Script =>
  (socket, line) => {
    if (line === null) return void socket.write(GREETING)
    const [tag, command] = line.split(' ')
    if (command?.toUpperCase() === 'CAPABILITY')
      socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`)
    else if (/^(LOGIN|AUTHENTICATE)$/i.test(command ?? '')) socket.write(`${tag} ${answer}\r\n`)
    else if (tag) socket.write(`${tag} OK\r\n`)
  }

const login = (port: number, timeoutMs = 2_000) =>
  testImapLogin({ host: '127.0.0.1', port, secure: false, user: 'you@icloud.com', pass: 'x', timeoutMs })

describe('iCloud sign-in failures', () => {
  it('a wrong password (or an Apple ID password) is an auth error', async () => {
    const port = await fakeImap(refuseLogin('NO [AUTHENTICATIONFAILED] Authentication failed.'))
    await expect(login(port)).rejects.toBeInstanceOf(MailAuthError)
  })

  it('a server saying it is unavailable is not reported as a wrong password', async () => {
    const port = await fakeImap(
      refuseLogin('NO [UNAVAILABLE] Service temporarily unavailable, try again later'),
    )
    const err = await login(port).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailUnavailableError)
    expect((err as MailUnavailableError).serverText).toBe('Service temporarily unavailable, try again later')
  })

  it('throttling at sign-in without a code is still throttling', async () => {
    const port = await fakeImap(refuseLogin('NO Too many simultaneous connections. Try again later.'))
    await expect(login(port)).rejects.toBeInstanceOf(MailUnavailableError)
  })

  it('a BYE greeting means the server is turning us away', async () => {
    const port = await fakeImap((socket, line) => {
      if (line === null) socket.end('* BYE Too many connections from your IP\r\n')
    })
    const err = await login(port).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailUnavailableError)
    expect((err as MailUnavailableError).serverText).toContain('Too many connections')
  })

  it('a server that never greets is a timeout', async () => {
    const port = await fakeImap(() => {})
    const err = await login(port, 300).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailConnectionError)
    expect((err as MailConnectionError).reason).toBe('timeout')
  })

  it('a connection closed before the greeting was dropped', async () => {
    const port = await fakeImap((socket, line) => {
      if (line === null) socket.destroy()
    })
    const err = await login(port).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailConnectionError)
  })

  it('nothing listening means offline', async () => {
    const port = await fakeImap(() => {})
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    const err = await login(port).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailConnectionError)
    expect((err as MailConnectionError).reason).toBe('offline')
  })
})

describe('classifyImapError', () => {
  const coded = (code: string) => Object.assign(new Error(code), { code })

  it.each([
    ['ENOTFOUND', 'offline'],
    ['EAI_AGAIN', 'offline'],
    ['ENETUNREACH', 'offline'],
    ['EHOSTUNREACH', 'offline'],
    ['CONNECT_TIMEOUT', 'timeout'],
    ['GREETING_TIMEOUT', 'timeout'],
    ['ETIMEOUT', 'timeout'],
    ['ETIMEDOUT', 'timeout'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['ECONNRESET', 'dropped'],
    ['EPIPE', 'dropped'],
    ['NoConnection', 'dropped'],
  ])('%s is a connection error (%s)', (code, reason) => {
    const err = classifyImapError(coded(code))
    expect(err).toBeInstanceOf(MailConnectionError)
    expect((err as MailConnectionError).reason).toBe(reason)
  })

  it('ETHROTTLE is the server refusing', () => {
    expect(classifyImapError(coded('ETHROTTLE'))).toBeInstanceOf(MailUnavailableError)
  })

  it('a refusal that mentions the password is an auth error', () => {
    const err = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseText: 'Invalid password, try again',
    })
    expect(classifyImapError(err)).toBeInstanceOf(MailAuthError)
  })

  it('cleans control characters out of what the server said', () => {
    const err = Object.assign(new Error('x'), { code: 'ETHROTTLE', responseText: 'Slow\u0000 down‮ now' })
    expect((classifyImapError(err) as MailUnavailableError).serverText).toBe('Slow down now')
  })

  it('a failed sign-in that only says to try again is still about the password', () => {
    const err = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseText: 'LOGIN failed, please try again',
    })
    expect(classifyImapError(err)).toBeInstanceOf(MailAuthError)
  })

  it('cleans invisible and bidi characters out of what the server said', () => {
    const sneaky = ['Slow', 0x200b, 'down', 0x061c, 'now', 0x2060, 'or', 0xfeff, 'later', 0x2028, 'ok']
      .map((p) => (typeof p === 'number' ? String.fromCharCode(p) : p))
      .join('')
    const err = Object.assign(new Error('x'), { code: 'ETHROTTLE', responseText: sneaky })
    expect((classifyImapError(err) as MailUnavailableError).serverText).toBe('Slow down now or later ok')
  })

  it('leaves anything else alone', () => {
    const err = new Error('odd')
    expect(classifyImapError(err)).toBe(err)
  })
})
