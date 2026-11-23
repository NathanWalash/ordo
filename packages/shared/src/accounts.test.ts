import { describe, expect, it } from 'vitest'
import {
  AddAccountSchema,
  defaultLabel,
  fromAccount,
  nextColor,
  SetPasswordSchema,
  TestAccountSchema,
  UpdateAccountSchema,
} from './accounts'
import { ComposeSchema, MessageListQuerySchema, MessageRefSchema } from './mail'

describe('account inputs from the window', () => {
  it('accepts each supported preset with an app password', () => {
    expect(
      AddAccountSchema.safeParse({
        provider: 'icloud',
        email: 'me@icloud.com',
        password: 'abcd-efgh-ijkl-mnop',
      }).success,
    ).toBe(true)
    expect(
      AddAccountSchema.safeParse({
        provider: 'gmail',
        email: 'jo@gmail.com',
        password: 'abcd efgh ijkl mnop',
      }).success,
    ).toBe(true)
  })

  it('refuses Outlook.com, a password that can’t be iCloud’s, and Other without servers', () => {
    const issues = (input: unknown) =>
      AddAccountSchema.safeParse(input).error?.issues.map((i) => [i.path.join('.'), i.message]) ?? []
    expect(issues({ provider: 'outlook', email: 'me@outlook.com', password: 'x' })[0]?.[1]).toMatch(
      /Microsoft sign-in/,
    )
    expect(issues({ provider: 'icloud', email: 'me@icloud.com', password: 'hunter2' })).toEqual([
      ['password', 'App-specific passwords look like abcd-efgh-ijkl-mnop.'],
    ])
    expect(issues({ provider: 'other', email: 'me@x.example', password: 'p' }).map((i) => i[0])).toEqual([
      'imap',
      'smtp',
    ])
  })

  it('checks typed servers: a real host name, a port, never plain-text SMTP', () => {
    const other = (imap: object, smtp: object) =>
      AddAccountSchema.safeParse({ provider: 'other', email: 'me@x.example', password: 'p', imap, smtp })
        .success
    const smtp = { host: 'smtp.x.example', port: 587, secure: false, requireTLS: true }
    expect(other({ host: 'imap.x.example', port: 993, secure: true }, smtp)).toBe(true)
    expect(other({ host: 'imap x.example', port: 993, secure: true }, smtp)).toBe(false)
    expect(other({ host: 'imap.x.example', port: 70000, secure: true }, smtp)).toBe(false)
    expect(other({ host: 'imap.x.example', port: 993, secure: true }, { ...smtp, requireTLS: false })).toBe(
      false,
    )
    expect(other({ host: 'imap.x.example', port: 993, secure: true, extra: 1 }, smtp)).toBe(false)
  })

  it('names, colours and ids are plain', () => {
    expect(UpdateAccountSchema.safeParse({ id: 'acc-1', label: 'Work', color: 'green' }).success).toBe(true)
    expect(UpdateAccountSchema.safeParse({ id: 'acc-1', color: 'url(evil)' }).success).toBe(false)
    expect(UpdateAccountSchema.safeParse({ id: '../acc', label: 'x' }).success).toBe(false)
    expect(UpdateAccountSchema.safeParse({ id: 'acc-1', label: 'a'.repeat(41) }).success).toBe(false)
    expect(SetPasswordSchema.safeParse({ id: 'acc-1', password: '' }).success).toBe(false)
    expect(TestAccountSchema.safeParse({ id: 'acc-1' }).success).toBe(true)
  })

  it('mail inputs take an account, or all of them for the unified inbox', () => {
    expect(MessageRefSchema.parse({ mailbox: 'INBOX', uid: 1 })).toEqual({ mailbox: 'INBOX', uid: 1 })
    expect(MessageRefSchema.safeParse({ account: 'all', mailbox: 'INBOX', uid: 1 }).success).toBe(false)
    expect(MessageListQuerySchema.parse({ account: 'all', mailbox: 'INBOX' })).toMatchObject({
      account: 'all',
    })
    expect(
      ComposeSchema.safeParse({
        account: 'acc-work',
        to: [],
        cc: [],
        bcc: [],
        subject: '',
        body: '',
        attachments: [],
      }).success,
    ).toBe(true)
  })
})

describe('defaults for a new account', () => {
  it('labels it after the provider, numbering repeats', () => {
    expect(defaultLabel('gmail', [])).toBe('Gmail')
    expect(defaultLabel('gmail', ['gmail', 'Gmail 2'])).toBe('Gmail 3')
    expect(defaultLabel('other', ['iCloud'])).toBe('Other')
  })

  it('gives each a colour no other account has yet', () => {
    expect(nextColor([])).toBe('blue')
    expect(nextColor(['blue', 'purple'])).toBe('pink')
  })
})

describe('which account a message is written from', () => {
  const accounts = [{ id: 'acc-1' }, { id: 'acc-work' }]
  it('a reply or a draft: always the original’s account', () => {
    expect(fromAccount(accounts, { original: 'acc-work', picked: 'acc-1' })).toBe('acc-work')
    expect(fromAccount(accounts, { original: 'acc-gone' })).toBeNull()
  })
  it('a new message: the one picked, else the one being looked at, else the first', () => {
    expect(fromAccount(accounts, { picked: 'acc-work', viewing: 'acc-1' })).toBe('acc-work')
    expect(fromAccount(accounts, { viewing: 'acc-work' })).toBe('acc-work')
    expect(fromAccount(accounts, { picked: 'acc-gone' })).toBe('acc-1')
    expect(fromAccount([], {})).toBeNull()
  })
})
