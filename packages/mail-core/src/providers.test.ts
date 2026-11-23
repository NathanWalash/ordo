import { describe, expect, it } from 'vitest'
import {
  guessProvider,
  imapSecureFor,
  PROVIDER_IDS,
  PROVIDERS,
  serversFor,
  smtpSecurityFor,
} from './providers'

describe('provider presets', () => {
  it('guesses the provider from the address', () => {
    expect(guessProvider('me@icloud.com')).toBe('icloud')
    expect(guessProvider('Me@Me.com')).toBe('icloud')
    expect(guessProvider('jo.bloggs@gmail.com')).toBe('gmail')
    expect(guessProvider('jo@googlemail.com')).toBe('gmail')
    expect(guessProvider('jo@yahoo.co.uk')).toBe('yahoo')
    expect(guessProvider('jo@fastmail.com')).toBe('fastmail')
    expect(guessProvider('jo@hotmail.com')).toBe('outlook')
    // A work address on Google Workspace can't be told from its domain: you pick Gmail yourself.
    expect(guessProvider('jo@company.example')).toBe('other')
    expect(guessProvider('not an address')).toBe('other')
  })

  it('gives each preset encrypted IMAP and SMTP', () => {
    for (const id of PROVIDER_IDS) {
      const p = PROVIDERS[id]
      if (!p.imap || !p.smtp) continue
      expect(p.imap.secure, id).toBe(true)
      expect(p.smtp.secure || p.smtp.requireTLS, id).toBe(true)
    }
    expect(serversFor('gmail')).toEqual({
      imap: { host: 'imap.gmail.com', port: 993, secure: true },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false },
    })
    expect(serversFor('icloud')?.smtp).toEqual({
      host: 'smtp.mail.me.com',
      port: 587,
      secure: false,
      requireTLS: true,
    })
  })

  it('lists Outlook.com but doesn’t support it yet (Microsoft turned off password IMAP)', () => {
    expect(PROVIDERS.outlook.supported).toBe(false)
    expect(PROVIDERS.outlook.notes.join(' ')).toContain('Microsoft sign-in')
    expect(serversFor('outlook')).toBeNull()
  })

  it('says what Gmail app passwords need', () => {
    const notes = PROVIDERS.gmail.notes.join(' ')
    expect(notes).toContain('2-Step Verification')
    expect(notes).toContain('Workspace')
    expect(notes).toContain('Sign in with Google')
  })

  it('uses the servers you type for Other, and has none without them', () => {
    expect(serversFor('other')).toBeNull()
    const manual = {
      imap: { host: 'mail.example.org', port: 993, secure: true },
      smtp: { host: 'mail.example.org', port: 587, secure: false, requireTLS: true },
    }
    expect(serversFor('other', manual)).toEqual(manual)
  })

  it('picks the usual security for a port, never plain text', () => {
    expect(smtpSecurityFor(465)).toEqual({ secure: true, requireTLS: false })
    expect(smtpSecurityFor(587)).toEqual({ secure: false, requireTLS: true })
    expect(smtpSecurityFor(25)).toEqual({ secure: false, requireTLS: true })
    expect(imapSecureFor(993)).toBe(true)
    expect(imapSecureFor(143)).toBe(false)
  })
})
