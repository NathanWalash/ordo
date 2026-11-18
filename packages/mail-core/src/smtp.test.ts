import { describe, expect, it, vi } from 'vitest'
import {
  buildMessage,
  checkOutgoing,
  createMailtoSender,
  RecipientsRefused,
  sendMessage,
  type OutgoingMessage,
} from './smtp'

const message = (o: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  from: { address: 'me@icloud.example', name: 'Me' },
  to: [{ address: 'sam@friend.example', name: 'Sam' }],
  cc: [],
  bcc: [{ address: 'secret@friend.example' }],
  subject: 'Dinner',
  text: 'See you at 8.',
  attachments: [],
  ...o,
})

describe('checkOutgoing', () => {
  it('accepts a normal message', () => {
    expect(checkOutgoing(message(), { needRecipients: true })).toBeNull()
  })

  it('refuses header injection anywhere', () => {
    expect(checkOutgoing(message({ subject: 'Hi\r\nBcc: spy@z.example' }), { needRecipients: true })).toMatch(
      /subject/,
    )
    expect(
      checkOutgoing(message({ to: [{ address: 'a@x.example', name: 'A\r\nBcc: spy@z.example' }] }), {
        needRecipients: true,
      }),
    ).toMatch(/address/)
    expect(
      checkOutgoing(message({ inReplyTo: '<a@x>\r\nBcc: spy@z.example' }), { needRecipients: true }),
    ).toMatch(/thread/)
    expect(
      checkOutgoing(message({ attachments: [{ filename: 'a\r\n.txt', content: Buffer.from('x') }] }), {
        needRecipients: true,
      }),
    ).toMatch(/attachment/)
  })

  it('needs a recipient to send, but not to save a draft, and limits how many', () => {
    const none = message({ to: [], bcc: [] })
    expect(checkOutgoing(none, { needRecipients: true })).toMatch(/at least one/)
    expect(checkOutgoing(none, { needRecipients: false })).toBeNull()
    const many = Array.from({ length: 51 }, (_, i) => ({ address: `p${i}@x.example` }))
    expect(checkOutgoing(message({ to: many, bcc: [] }), { needRecipients: true })).toMatch(/at most 50/)
  })

  it('limits attachments', () => {
    const big = { filename: 'big.bin', content: Buffer.alloc(15 * 1024 * 1024) }
    expect(checkOutgoing(message({ attachments: [big] }), { needRecipients: true })).toMatch(/too big/)
  })
})

describe('buildMessage', () => {
  it('keeps Bcc only in the saved copy and threads a reply', async () => {
    const m = message({ inReplyTo: '<orig@x.example>', references: ['<a@x.example>', '<orig@x.example>'] })
    const sent = (await buildMessage(m, { keepBcc: false })).raw.toString()
    const copy = (
      await buildMessage(m, { keepBcc: true, messageId: '<fixed@icloud.example>' })
    ).raw.toString()
    expect(sent).not.toMatch(/^Bcc:/m)
    expect(copy).toMatch(/^Bcc: secret@friend\.example/m)
    expect(copy).toMatch(/^Message-ID: <fixed@icloud\.example>/m)
    expect(sent).toMatch(/^In-Reply-To: <orig@x\.example>/m)
    expect(sent).toMatch(/^References: <a@x\.example> <orig@x\.example>/m)
    expect(sent).toMatch(/^To: Sam <sam@friend\.example>/m)
    expect(sent).toMatch(/See you at 8\./)
  })

  it('attaches files from memory', async () => {
    const raw = (
      await buildMessage(
        message({ attachments: [{ filename: 'notes.txt', content: Buffer.from('hello') }] }),
        {
          keepBcc: false,
        },
      )
    ).raw.toString()
    expect(raw).toMatch(/filename=notes\.txt/)
    expect(raw).toMatch(/multipart\/mixed/)
  })

  it('refuses an unsafe message before building it', async () => {
    await expect(buildMessage(message({ subject: 'a\nb' }), { keepBcc: false })).rejects.toThrow(/subject/)
  })
})

describe('sendMessage and refused recipients', () => {
  const cfg = { host: '127.0.0.1', port: 9, secure: false, requireTLS: true, user: 'u', pass: 'p' }
  const transport = (result: () => Promise<unknown>) => ({ sendMail: vi.fn(result), close: vi.fn() })

  it('reports the recipients the server refused when it took the rest', async () => {
    const t = transport(async () => ({
      accepted: ['sam@friend.example'],
      rejected: ['nobody@friend.example'],
    }))
    const r = await sendMessage(cfg, message({ cc: [{ address: 'nobody@friend.example' }] }), {
      transport: t,
    })
    expect(r.rejected).toEqual(['nobody@friend.example'])
    expect(t.close).toHaveBeenCalled()
  })

  it('says which recipients were refused when nobody could be sent to', async () => {
    const t = transport(async () => {
      throw Object.assign(new Error('Can’t send mail - all recipients were rejected'), {
        code: 'EENVELOPE',
        rejected: ['sam@friend.example', 'secret@friend.example'],
      })
    })
    const err = await sendMessage(cfg, message(), { transport: t }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RecipientsRefused)
    expect((err as RecipientsRefused).recipients).toEqual(['sam@friend.example', 'secret@friend.example'])
  })
})

describe('sendMessage', () => {
  it('checks the message before connecting', async () => {
    const cfg = { host: '127.0.0.1', port: 9, secure: false, requireTLS: true, user: 'u', pass: 'p' }
    await expect(sendMessage(cfg, message({ to: [], bcc: [] }))).rejects.toThrow(/at least one/)
  })
})

// Port 9 (discard) on loopback: nothing is ever sent, these checks run before any connection.
const cfg = { host: '127.0.0.1', port: 9, secure: false, requireTLS: true, user: 'u', pass: 'p' }

describe('createMailtoSender', () => {
  it('refuses header injection and multiple recipients before connecting', async () => {
    const sender = createMailtoSender(cfg, 'me@icloud.com')
    try {
      await expect(
        sender.send({ to: 'a@x.example\r\nBcc: spy@z.example', subject: 's', body: 'b' }),
      ).rejects.toThrow(/unsafe/)
      await expect(sender.send({ to: 'a@x.example', subject: 's\r\nBcc: x', body: 'b' })).rejects.toThrow(
        /unsafe/,
      )
      await expect(sender.send({ to: 'a@x.example,b@y.example', subject: 's', body: 'b' })).rejects.toThrow(
        /unsafe/,
      )
    } finally {
      sender.close()
    }
  })

  it('stops after its limit', async () => {
    const sender = createMailtoSender(cfg, 'me@icloud.com', 0)
    try {
      await expect(sender.send({ to: 'a@x.example', subject: 's', body: 'b' })).rejects.toThrow(/at most 0/)
    } finally {
      sender.close()
    }
  })
})
