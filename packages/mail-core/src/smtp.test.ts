import { describe, expect, it } from 'vitest'
import { createMailtoSender } from './smtp'

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
