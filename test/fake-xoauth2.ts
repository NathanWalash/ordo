/**
 * A tiny IMAP and SMTP server on 127.0.0.1 that signs in only with SASL XOAUTH2, as Gmail does for
 * Sign in with Google (https://developers.google.com/workspace/gmail/imap/xoauth2-protocol):
 *
 * - IMAP advertises `SASL-IR AUTH=XOAUTH2` and takes `AUTHENTICATE XOAUTH2 <base64>`; SMTP
 *   advertises `AUTH XOAUTH2` and takes `AUTH XOAUTH2 <base64>`. The payload must be exactly
 *   `user=<email>\x01auth=Bearer <token>\x01\x01`.
 * - With `{ oauthbearer: true }`, IMAP also advertises `AUTH=OAUTHBEARER` (RFC 7628), as Gmail
 *   does, and takes `n,a=<email>,\x01host=…\x01port=…\x01auth=Bearer <token>\x01\x01`; a refused
 *   token's challenge must be answered with `AQ==` (\x01). imapflow prefers it when offered.
 * - A token it refuses gets Google's failure: a continuation carrying base64 JSON
 *   (`{"status":"401","schemes":"bearer","scope":"https://mail.google.com/"}`), which the client
 *   must answer with an empty line, then `NO [AUTHENTICATIONFAILED]` (IMAP) or `535` (SMTP).
 *
 * Just enough of each protocol for imapflow and nodemailer to sign in, send and sign out. GreenMail
 * doesn't speak XOAUTH2, so this proves the real handshake end to end. Never a real server.
 */
import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

export interface XoauthAttempt {
  protocol: 'imap' | 'smtp'
  user: string
  token: string
  ok: boolean
}

const FAILURE = Buffer.from(
  JSON.stringify({ status: '401', schemes: 'bearer', scope: 'https://mail.google.com/' }),
).toString('base64')

/** The user and token in an XOAUTH2 initial response, or null if it isn't exactly that format. */
export function parseOauthbearer(b64: string): { user: string; token: string } | null {
  const fields = Buffer.from(b64, 'base64').toString().split('\x01')
  const user = /^n,a=([^,]+),$/.exec(fields[0] ?? '')?.[1]
  const token = fields.map((f) => /^auth=Bearer (.+)$/.exec(f)?.[1]).find(Boolean)
  const ends = fields.length >= 3 && fields.at(-1) === '' && fields.at(-2) === ''
  return user && token && ends ? { user: user.replace(/=2C/g, ',').replace(/=3D/g, '='), token } : null
}

export function parseXoauth2(b64: string): { user: string; token: string } | null {
  // eslint-disable-next-line no-control-regex -- XOAUTH2 separates its fields with \x01
  const m = /^user=([^\x01]+)\x01auth=Bearer ([^\x01]+)\x01\x01$/.exec(Buffer.from(b64, 'base64').toString())
  return m ? { user: m[1]!, token: m[2]! } : null
}

/** Feed a socket's text to `onLine` one CRLF-terminated line at a time. */
function lines(socket: Socket, onLine: (line: string) => void): void {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let i = buffer.indexOf('\r\n'); i >= 0; i = buffer.indexOf('\r\n')) {
      const line = buffer.slice(0, i)
      buffer = buffer.slice(i + 2)
      onLine(line)
    }
  })
  socket.on('error', () => {})
}

export class FakeXoauth2Mail {
  imapPort = 0
  smtpPort = 0
  attempts: XoauthAttempt[] = []
  /** Payloads that weren't in XOAUTH2's format. */
  malformed: string[] = []
  sent: { from: string; to: string[]; data: string }[] = []
  private servers: Server[] = []
  private sockets = new Set<Socket>()

  /** The SASL mechanism of each attempt, in order. */
  mechanisms: string[] = []

  /** `accept` decides whether a user and access token may sign in. */
  constructor(
    public accept: (user: string, token: string) => boolean,
    private options: { oauthbearer?: boolean } = {},
  ) {}

  private check(protocol: 'imap' | 'smtp', b64: string, mechanism = 'XOAUTH2'): boolean {
    this.mechanisms.push(mechanism)
    const p = mechanism === 'OAUTHBEARER' ? parseOauthbearer(b64) : parseXoauth2(b64)
    if (!p) {
      this.malformed.push(b64)
      return false
    }
    const ok = this.accept(p.user, p.token)
    this.attempts.push({ protocol, ...p, ok })
    return ok
  }

  private imap(socket: Socket): void {
    const send = (s: string) => socket.write(`${s}\r\n`)
    let failing: { tag: string; breaker: string } | null = null
    let authed = false
    const auth = `SASL-IR AUTH=XOAUTH2${this.options.oauthbearer ? ' AUTH=OAUTHBEARER' : ''}`
    send(`* OK [CAPABILITY IMAP4rev1 ${auth}] Fake Gimap ready`)
    lines(socket, (line) => {
      if (failing) {
        // The client's answer to the failure challenge: empty for XOAUTH2, \x01 for OAUTHBEARER.
        send(
          line === failing.breaker
            ? `${failing.tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`
            : `${failing.tag} BAD expected ${failing.breaker ? failing.breaker : 'an empty response'}`,
        )
        failing = null
        return
      }
      const [tag = '*', command = '', ...rest] = line.split(' ')
      switch (command.toUpperCase()) {
        case 'CAPABILITY':
          send(`* CAPABILITY IMAP4rev1${authed ? '' : ` ${auth}`}`)
          return send(`${tag} OK Success`)
        case 'AUTHENTICATE': {
          const mechanism = rest[0]?.toUpperCase() ?? ''
          const offered = mechanism === 'XOAUTH2' || (mechanism === 'OAUTHBEARER' && this.options.oauthbearer)
          if (!offered || !rest[1]) return send(`${tag} NO unsupported`)
          if (this.check('imap', rest[1], mechanism)) {
            authed = true
            return send(`${tag} OK [CAPABILITY IMAP4rev1] user authenticated (Success)`)
          }
          failing = { tag, breaker: mechanism === 'OAUTHBEARER' ? 'AQ==' : '' }
          return send(`+ ${FAILURE}`)
        }
        case 'LOGOUT':
          send('* BYE LOGOUT Requested')
          send(`${tag} OK 73 good day (Success)`)
          return void socket.end()
        default:
          if (!authed) return send(`${tag} NO not signed in`)
          // An empty mailbox: just enough for an app to check an inbox with nothing in it.
          switch (command.toUpperCase()) {
            case 'LIST':
              send('* LIST (\\HasNoChildren) "/" "INBOX"')
              break
            case 'STATUS':
              send('* STATUS "INBOX" (MESSAGES 0 UIDNEXT 1 UIDVALIDITY 1 UNSEEN 0)')
              break
            case 'SELECT':
            case 'EXAMINE':
              send('* FLAGS (\\Answered \\Flagged \\Draft \\Deleted \\Seen)')
              send('* 0 EXISTS')
              send('* OK [UIDVALIDITY 1] UIDs valid')
              send('* OK [UIDNEXT 1] Predicted next UID')
              return send(`${tag} OK [READ-ONLY] Selected`)
          }
          return send(`${tag} OK Success`)
      }
    })
  }

  private smtp(socket: Socket): void {
    const send = (s: string) => socket.write(`${s}\r\n`)
    let failing = false
    let authed = false
    let data: { from: string; to: string[]; lines: string[] } | null = null
    let envelope = { from: '', to: [] as string[] }
    send('220 fake.gmail.test ESMTP ready')
    lines(socket, (line) => {
      if (data) {
        if (line === '.') {
          this.sent.push({ from: data.from, to: data.to, data: data.lines.join('\r\n') })
          data = null
          return send('250 2.0.0 OK queued')
        }
        data.lines.push(line.startsWith('..') ? line.slice(1) : line)
        return
      }
      if (failing) {
        failing = false
        return send(
          line === ''
            ? '535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 BadCredentials'
            : '501 expected an empty response',
        )
      }
      const [verb = '', ...rest] = line.split(' ')
      switch (verb.toUpperCase()) {
        case 'EHLO':
          return send('250-fake.gmail.test\r\n250-AUTH XOAUTH2\r\n250 8BITMIME')
        case 'HELO':
          return send('250 fake.gmail.test')
        case 'AUTH':
          if (rest[0]?.toUpperCase() !== 'XOAUTH2' || !rest[1]) return send('504 unsupported')
          if (this.check('smtp', rest[1])) {
            authed = true
            return send('235 2.7.0 Accepted')
          }
          failing = true
          return send(`334 ${FAILURE}`)
        case 'MAIL':
          if (!authed) return send('530 5.7.0 Authentication Required')
          envelope = { from: /<([^>]*)>/.exec(line)?.[1] ?? '', to: [] }
          return send('250 2.1.0 OK')
        case 'RCPT':
          envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '')
          return send('250 2.1.5 OK')
        case 'DATA':
          data = { ...envelope, lines: [] }
          return send('354 Go ahead')
        case 'RSET':
          return send('250 OK')
        case 'NOOP':
          return send('250 OK')
        case 'QUIT':
          send('221 2.0.0 closing connection')
          return void socket.end()
        default:
          return send('502 not implemented')
      }
    })
  }

  async start(): Promise<this> {
    const listen = (handler: (s: Socket) => void) =>
      new Promise<number>((resolve) => {
        const server = createServer((socket) => {
          this.sockets.add(socket)
          socket.on('close', () => this.sockets.delete(socket))
          handler(socket)
        })
        this.servers.push(server)
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
      })
    this.imapPort = await listen((s) => this.imap(s))
    this.smtpPort = await listen((s) => this.smtp(s))
    return this
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy()
    await Promise.all(this.servers.map((s) => new Promise((r) => s.close(r))))
  }
}

export async function startFakeXoauth2Mail(
  accept: (user: string, token: string) => boolean,
  options: { oauthbearer?: boolean } = {},
): Promise<FakeXoauth2Mail> {
  return new FakeXoauth2Mail(accept, options).start()
}
