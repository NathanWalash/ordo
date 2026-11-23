// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailAccount, MailboxInfo, MessageSummary } from '@ordo/shared'
import { ALL, MailboxList } from './MailboxList'
import { keyOf, MessageList } from './MessageList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const account = (id: string, label: string, color: MailAccount['color']): MailAccount => ({
  id,
  label,
  email: `${id}@example.com`,
  color,
  provider: 'gmail',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false },
  auth: { kind: 'password' },
  lastScan: null,
})
const box = (path: string, role: MailboxInfo['role'], unread = 0): MailboxInfo => ({
  path,
  name: path.split('/').pop()!,
  role,
  delimiter: '/',
  total: 5,
  unread,
})
const HOME = account('acc-1', 'Home', 'blue')
const WORK = account('acc-work', 'Work', 'green')
const BOXES = {
  'acc-1': [box('INBOX', 'inbox', 2), box('Sent Messages', 'sent'), box('Notes', null)],
  'acc-work': [box('INBOX', 'inbox', 3), box('[Gmail]/All Mail', 'all'), box('[Gmail]/Bin', 'trash')],
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (props: Partial<Parameters<typeof MailboxList>[0]> = {}) => {
  const onSelect = vi.fn()
  act(() =>
    root.render(
      createElement(MailboxList, {
        accounts: [HOME, WORK],
        mailboxes: BOXES,
        current: { account: ALL, mailbox: 'INBOX' },
        onSelect,
        onRefresh: () => {},
        refreshing: false,
        footer: null,
        ...props,
      }),
    ),
  )
  return onSelect
}
const labels = () => [...host.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'))

describe('the mailbox list with several accounts', () => {
  it('starts with All Inboxes (every unread inbox message), then each account’s folders', () => {
    render()
    expect(labels()).toEqual([
      'Check for new mail',
      'All Inboxes, 5 unread',
      'Home: Inbox, 2 unread',
      'Home: Sent',
      'Home: Notes',
      'Work: Inbox, 3 unread',
      'Work: All Mail',
      'Work: Bin',
    ])
    expect(host.querySelector('[aria-current="page"]')?.getAttribute('aria-label')).toBe(
      'All Inboxes, 5 unread',
    )
  })

  it('opens one account’s folder, and folds an account away', () => {
    const onSelect = render()
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Work: All Mail"]')!.click())
    expect(onSelect).toHaveBeenCalledWith({ account: 'acc-work', mailbox: '[Gmail]/All Mail' })
    const header = [...host.querySelectorAll('button[aria-expanded]')].find((b) =>
      b.textContent?.includes('Work'),
    )!
    act(() => (header as HTMLButtonElement).click())
    expect(labels()).not.toContain('Work: Bin')
  })

  it('marks an account whose check failed', () => {
    render({ problems: { 'acc-work': 'Gmail didn’t accept the password.' } })
    expect(host.querySelector('[aria-label="Couldn’t check Work"]')).not.toBeNull()
  })

  it('with one account, looks as it always did: no account headings, no All Inboxes', () => {
    render({ accounts: [HOME], current: { account: 'acc-1', mailbox: 'INBOX' } })
    expect(labels()).toEqual(['Check for new mail', 'Inbox, 2 unread', 'Sent', 'Notes'])
  })
})

describe('message rows across accounts', () => {
  const row = (accountId: string, uid: number): MessageSummary => ({
    account: accountId,
    mailbox: 'INBOX',
    uid,
    date: new Date('2026-11-16T10:00:00Z'),
    from: { address: 'sam@friend.example', name: 'Sam' },
    to: [],
    subject: `Message ${uid}`,
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
  })

  it('tells apart the same UID in two accounts, and names each row’s account', () => {
    expect(keyOf(row('acc-1', 7))).not.toBe(keyOf(row('acc-work', 7)))
    act(() =>
      root.render(
        createElement(MessageList, {
          label: 'All Inboxes messages',
          messages: [row('acc-1', 7), row('acc-work', 7)],
          selected: null,
          onSelect: () => {},
          showRecipients: false,
          accountOf: (m: MessageSummary) => (m.account === 'acc-1' ? HOME : WORK),
          empty: null,
        }),
      ),
    )
    const options = [...host.querySelectorAll('[role="option"]')]
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.getAttribute('aria-label')?.split('.')[0])).toEqual(['Home', 'Work'])
    expect(options[1]!.textContent).toContain('Work')
  })
})
