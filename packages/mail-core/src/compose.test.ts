import { describe, expect, it } from 'vitest'
import {
  forwardBody,
  forwardSubject,
  ownAddresses,
  parseMailtoLink,
  referencesFor,
  replyBody,
  replyRecipients,
  replySubject,
} from './compose'

const me = 'me@icloud.example'
const original = {
  from: { address: 'sam@friend.example', name: 'Sam' },
  to: [{ address: me }, { address: 'pat@friend.example', name: 'Pat' }],
  cc: [{ address: 'jo@friend.example' }, { address: 'ME@icloud.example' }],
  replyTo: [],
}

describe('subjects', () => {
  it('adds Re: and Fwd: once', () => {
    expect(replySubject('Dinner?')).toBe('Re: Dinner?')
    expect(replySubject('RE: Dinner?')).toBe('RE: Dinner?')
    expect(forwardSubject('Dinner?')).toBe('Fwd: Dinner?')
    expect(forwardSubject('Fw: Dinner?')).toBe('Fw: Dinner?')
  })
})

describe('replyRecipients', () => {
  it('replies to the sender, or Reply-To when there is one', () => {
    expect(replyRecipients(original, [me], false)).toEqual({ to: [original.from], cc: [] })
    const list = { ...original, replyTo: [{ address: 'list@club.example' }] }
    expect(replyRecipients(list, [me], false)).toEqual({ to: [{ address: 'list@club.example' }], cc: [] })
  })

  it('reply all adds everyone else, never you, without duplicates', () => {
    expect(replyRecipients(original, [me], true)).toEqual({
      to: [original.from, { address: 'pat@friend.example', name: 'Pat' }],
      cc: [{ address: 'jo@friend.example' }],
    })
  })

  it('knows your iCloud aliases, and treats a message in Sent as yours', () => {
    expect(ownAddresses('Me.Person@icloud.com')).toEqual([
      'me.person@icloud.com',
      'me.person@me.com',
      'me.person@mac.com',
    ])
    expect(ownAddresses('me@custom.example')).toEqual(['me@custom.example'])
  })

  it('knows Gmail’s other spellings, and takes every account at once', () => {
    expect(ownAddresses('Jo.Bloggs@gmail.com').sort()).toEqual(
      [
        'jo.bloggs@gmail.com',
        'jo.bloggs@googlemail.com',
        'jobloggs@gmail.com',
        'jobloggs@googlemail.com',
      ].sort(),
    )
    expect(ownAddresses('me@icloud.com', 'jo@work.example', '')).toEqual([
      'me@icloud.com',
      'me@me.com',
      'me@mac.com',
      'jo@work.example',
    ])
    const toAlias = {
      from: { address: 'sam@friend.example' },
      to: [{ address: 'me.person@me.com' }, { address: 'pat@friend.example' }],
      cc: [{ address: 'ME.PERSON@mac.com' }],
      replyTo: [],
    }
    expect(replyRecipients(toAlias, ownAddresses('me.person@icloud.com'), true)).toEqual({
      to: [{ address: 'sam@friend.example' }, { address: 'pat@friend.example' }],
      cc: [],
    })
    // Sent from an address Ordo doesn't know is yours, but it's in Sent.
    const sent = {
      ...original,
      from: { address: 'old-alias@elsewhere.example' },
      to: [{ address: 'pat@friend.example' }],
    }
    expect(replyRecipients(sent, [me], false, { inSent: true })).toEqual({
      to: [{ address: 'pat@friend.example' }],
      cc: [],
    })
  })

  it('replying to your own sent message goes to its recipients', () => {
    const sent = { ...original, from: { address: me }, to: [{ address: 'pat@friend.example' }] }
    expect(replyRecipients(sent, [me], false)).toEqual({ to: [{ address: 'pat@friend.example' }], cc: [] })
  })
})

describe('referencesFor', () => {
  it('appends the Message-ID, drops anything malformed and keeps the last 20', () => {
    const refs = Array.from({ length: 25 }, (_, i) => `<r${i}@x>`)
    const out = referencesFor({ references: [...refs, 'bad id', '<a\r\n@x>'], messageId: '<m@x>' })
    expect(out).toHaveLength(20)
    expect(out.at(-1)).toBe('<m@x>')
    expect(out).not.toContain('bad id')
  })
})

describe('reply and forward bodies', () => {
  it('quotes the original under a blank line', () => {
    expect(replyBody({ from: original.from, date: new Date(0) }, 'Hi\n> earlier', '16 Nov 2026')).toBe(
      '\n\nOn 16 Nov 2026, Sam <sam@friend.example> wrote:\n\n> Hi\n>> earlier\n',
    )
  })

  it('forwards with the original headers', () => {
    expect(forwardBody({ ...original, subject: 'Plans' }, 'Body', '16 Nov 2026')).toBe(
      '\n\n---------- Forwarded message ----------\nFrom: Sam <sam@friend.example>\nDate: 16 Nov 2026\n' +
        'Subject: Plans\nTo: me@icloud.example, Pat <pat@friend.example>\nCc: jo@friend.example, ME@icloud.example\n\nBody\n',
    )
  })
})

describe('parseMailtoLink', () => {
  it('fills To, Cc, Subject and Body', () => {
    expect(
      parseMailtoLink('mailto:a@x.example,b@x.example?cc=c@x.example&subject=Hi%20there&body=Line%0D%0ATwo'),
    ).toEqual({
      to: 'a@x.example, b@x.example',
      cc: 'c@x.example',
      subject: 'Hi there',
      body: 'Line\nTwo',
    })
  })

  it('keeps only the bare address, so a link can’t dress an address up with a name', () => {
    expect(parseMailtoLink('mailto:Your%20Bank%20%3Cphish@evil.example%3E')).toMatchObject({
      to: 'phish@evil.example',
    })
  })

  it('never takes Bcc or other headers, and strips line breaks from the subject', () => {
    expect(
      parseMailtoLink('mailto:a@x.example?bcc=spy@z.example&in-reply-to=x&subject=a%0D%0ABcc:%20b'),
    ).toEqual({
      to: 'a@x.example',
      cc: '',
      subject: 'a Bcc: b',
      body: '',
    })
  })

  it('refuses invalid addresses, too many recipients and links with nobody to write to', () => {
    expect(parseMailtoLink('mailto:not-an-address')).toBeNull()
    expect(
      parseMailtoLink(`mailto:${Array.from({ length: 11 }, (_, i) => `p${i}@x.example`).join(',')}`),
    ).toBeNull()
    expect(parseMailtoLink('mailto:?subject=hi')).toBeNull()
    expect(parseMailtoLink('https://x.example')).toBeNull()
    expect(parseMailtoLink('mailto:%E0%A4%A')).toBeNull()
  })
})
