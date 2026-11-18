import { describe, expect, it } from 'vitest'
import { toMailboxList, type RawMailbox } from './mailboxes'

const box = (path: string, extra: Partial<RawMailbox> = {}): RawMailbox => ({
  path,
  name: path.split('/').pop()!,
  delimiter: '/',
  flags: new Set(),
  ...extra,
})

describe('toMailboxList', () => {
  it('puts the special folders first in Mail’s order, then the rest by path', () => {
    const list = toMailboxList([
      box('Projects/2026'),
      box('Deleted Messages', { specialUse: '\\Trash', specialUseSource: 'extension' }),
      box('Sent Messages', { specialUse: '\\Sent', specialUseSource: 'extension' }),
      box('INBOX', { status: { messages: 10, unseen: 3 } }),
      box('Archive', { specialUse: '\\Archive', specialUseSource: 'name' }),
      box('Drafts', { specialUse: '\\Drafts', specialUseSource: 'extension' }),
      box('Junk', { specialUse: '\\Junk', specialUseSource: 'extension' }),
      box('Notes'),
    ])
    expect(list.map((m) => [m.path, m.role])).toEqual([
      ['INBOX', 'inbox'],
      ['Drafts', 'drafts'],
      ['Sent Messages', 'sent'],
      ['Archive', 'archive'],
      ['Junk', 'junk'],
      ['Deleted Messages', 'trash'],
      ['Notes', null],
      ['Projects/2026', null],
    ])
    expect(list[0]).toEqual({
      path: 'INBOX',
      name: 'Inbox',
      role: 'inbox',
      delimiter: '/',
      total: 10,
      unread: 3,
    })
  })

  it('prefers the server’s own flag over a folder guessed from its name', () => {
    const list = toMailboxList([
      box('Trash', { specialUse: '\\Trash', specialUseSource: 'name' }),
      box('Deleted Messages', { specialUse: '\\Trash', specialUseSource: 'extension' }),
    ])
    expect(list.map((m) => [m.path, m.role])).toEqual([
      ['Deleted Messages', 'trash'],
      ['Trash', null],
    ])
  })

  it('leaves out folders that can’t hold mail', () => {
    expect(toMailboxList([box('[Gmail]', { flags: new Set(['\\Noselect']) }), box('INBOX')])).toHaveLength(1)
  })
})
