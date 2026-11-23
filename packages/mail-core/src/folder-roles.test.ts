import { describe, expect, it } from 'vitest'
import { archiveMailbox, ROLE_NAMES, toMailboxList, type RawMailbox } from './mailboxes'

const box = (path: string, extra: Partial<RawMailbox> = {}): RawMailbox => ({
  path,
  name: path.split('/').pop()!,
  delimiter: '/',
  flags: new Set(),
  ...extra,
})

// LIST responses as imapflow returns them, recorded from each provider's folder layout (names and
// flags only; synthetic counts). Roles must come from the SPECIAL-USE flags, never the names.
const GMAIL_LIST: RawMailbox[] = [
  box('INBOX', { flags: new Set(['\\HasNoChildren']), status: { messages: 12, unseen: 2 } }),
  box('[Gmail]', { flags: new Set(['\\HasChildren', '\\Noselect']) }),
  box('[Gmail]/All Mail', { flags: new Set(['\\All']), specialUse: '\\All', specialUseSource: 'extension' }),
  box('[Gmail]/Bin', { flags: new Set(['\\Trash']), specialUse: '\\Trash', specialUseSource: 'extension' }),
  box('[Gmail]/Drafts', {
    flags: new Set(['\\Drafts']),
    specialUse: '\\Drafts',
    specialUseSource: 'extension',
  }),
  box('[Gmail]/Important', { flags: new Set(['\\Important']) }),
  box('[Gmail]/Sent Mail', {
    flags: new Set(['\\Sent']),
    specialUse: '\\Sent',
    specialUseSource: 'extension',
  }),
  box('[Gmail]/Spam', { flags: new Set(['\\Junk']), specialUse: '\\Junk', specialUseSource: 'extension' }),
  box('[Gmail]/Starred', {
    flags: new Set(['\\Flagged']),
    specialUse: '\\Flagged',
    specialUseSource: 'extension',
  }),
  box('Receipts'),
  box('Travel/2026'),
]

const ICLOUD_LIST: RawMailbox[] = [
  box('Archive', { specialUse: '\\Archive', specialUseSource: 'extension' }),
  box('Deleted Messages', { specialUse: '\\Trash', specialUseSource: 'extension' }),
  box('Drafts', { specialUse: '\\Drafts', specialUseSource: 'extension' }),
  box('INBOX'),
  box('Junk', { specialUse: '\\Junk', specialUseSource: 'extension' }),
  box('Notes'),
  box('Sent Messages', { specialUse: '\\Sent', specialUseSource: 'extension' }),
]

describe('folder roles by provider', () => {
  it('Gmail: All Mail, Bin, Spam and Sent Mail by their SPECIAL-USE flags, labels as folders', () => {
    const list = toMailboxList(GMAIL_LIST)
    expect(list.map((m) => [m.path, m.role])).toEqual([
      ['INBOX', 'inbox'],
      ['[Gmail]/Drafts', 'drafts'],
      ['[Gmail]/Sent Mail', 'sent'],
      ['[Gmail]/All Mail', 'all'],
      ['[Gmail]/Spam', 'junk'],
      ['[Gmail]/Bin', 'trash'],
      ['[Gmail]/Important', null],
      ['[Gmail]/Starred', null],
      ['Receipts', null],
      ['Travel/2026', null],
    ])
    // Gmail has no Archive folder: archiving goes to All Mail.
    expect(archiveMailbox(list)?.path).toBe('[Gmail]/All Mail')
  })

  it('a Gmail account in American English calls Bin “Trash”: still found by its \\Trash flag', () => {
    const list = toMailboxList(
      GMAIL_LIST.map((b) =>
        b.path === '[Gmail]/Bin'
          ? box('[Gmail]/Trash', { specialUse: '\\Trash', specialUseSource: 'extension' })
          : b,
      ),
    )
    expect(list.find((m) => m.role === 'trash')?.path).toBe('[Gmail]/Trash')
  })

  it('iCloud: Archive is the archive, and nothing is All Mail', () => {
    const list = toMailboxList(ICLOUD_LIST)
    expect(list.map((m) => [m.path, m.role])).toEqual([
      ['INBOX', 'inbox'],
      ['Drafts', 'drafts'],
      ['Sent Messages', 'sent'],
      ['Archive', 'archive'],
      ['Junk', 'junk'],
      ['Deleted Messages', 'trash'],
      ['Notes', null],
    ])
    expect(archiveMailbox(list)?.path).toBe('Archive')
  })

  it('a server with neither Archive nor All Mail has nowhere to archive', () => {
    expect(archiveMailbox(toMailboxList([box('INBOX')]))).toBeNull()
  })

  it('a folder only guessed from a decorated name never displaces one the server declared', () => {
    const list = toMailboxList([
      box('Sent Mail', { specialUse: '\\Sent', specialUseSource: 'name-guess' }),
      box('[Gmail]/Sent Mail', { specialUse: '\\Sent', specialUseSource: 'extension' }),
    ])
    expect(list.find((m) => m.role === 'sent')?.path).toBe('[Gmail]/Sent Mail')
  })

  it('names All Mail', () => {
    expect(ROLE_NAMES.all).toBe('All Mail')
  })
})
