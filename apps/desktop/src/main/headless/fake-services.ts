import { vi } from 'vitest'
import type { CategorisedSender, MessageContent, MessageSummary } from '@ordo/shared'
import type { BoardCardRow, OrdoServices } from './commands'

/** A sender as the analysis would return it. */
export function sender(address: string, extra: Partial<CategorisedSender> = {}): CategorisedSender {
  return {
    address,
    domain: address.split('@')[1]!,
    count: 3,
    unread: 1,
    firstSeen: new Date('2026-11-01T10:00:00Z'),
    lastSeen: new Date('2026-11-16T10:00:00Z'),
    sampleSubjects: ['Hello'],
    unsubscribe: { kind: 'none' },
    bulk: false,
    automated: false,
    category: 'uncategorised',
    ...extra,
  }
}

/** A message list row. */
export function summary(uid: number, extra: Partial<MessageSummary> = {}): MessageSummary {
  return {
    mailbox: 'INBOX',
    uid,
    date: new Date('2026-11-16T10:00:00Z'),
    from: { address: 'sam@friend.example', name: 'Sam' },
    to: [{ address: 'me@icloud.example' }],
    subject: 'Lunch?',
    seen: false,
    flagged: true,
    answered: false,
    hasAttachments: false,
    ...extra,
  }
}

/** A message as `open` returns it: HTML only, with a link and an escape sequence in it. */
export function content(extra: Partial<MessageContent> = {}): MessageContent {
  return {
    mailbox: 'INBOX',
    uid: 7,
    date: new Date('2026-11-16T10:00:00Z'),
    subject: 'Lunch?',
    from: { address: 'sam@friend.example', name: 'Sam' },
    to: [{ address: 'me@icloud.example' }],
    cc: [],
    bcc: [],
    replyTo: [],
    messageId: '<lunch@friend.example>',
    inReplyTo: null,
    references: [],
    seen: false,
    flagged: true,
    answered: false,
    draft: false,
    text: null,
    html: '<p>Fancy <b>lunch</b>?\u001b[2J</p><p><a href="https://cafe.example/menu">The menu</a></p><script>x()</script>',
    truncated: false,
    attachments: [
      { part: '2', filename: 'menu.pdf', contentType: 'application/pdf', size: 1000, inline: false },
      { part: '3', filename: 'logo.png', contentType: 'image/png', size: 10, inline: true, contentId: 'l' },
    ],
    inlineImages: {},
    ...extra,
  }
}

/** A board card as headless mode shows it. */
export function boardCard(extra: Partial<BoardCardRow> = {}): BoardCardRow {
  return {
    id: 'c0ffee00-1111-2222-3333-444455556666',
    title: 'Fix the gate',
    board: 'Home',
    column: 'To do',
    start: null,
    due: '2026-11-20',
    labels: ['Urgent'],
    checklist: { done: 1, total: 3 },
    links: 0,
    fields: {},
    archived: false,
    ...extra,
  }
}

/** Test doubles for the main-process services, connected by default. Override what a test needs. */
export function fakeServices(overrides: Partial<OrdoServices> = {}): OrdoServices {
  return {
    version: '9.9.9',
    account: () => ({ connected: true, email: 'me@icloud.example', lastScan: null, messageCount: 4 }),
    scan: vi.fn(async () => ({ ok: true as const, added: 4, total: 4, stopped: false })),
    senders: async () => [
      sender('digest@news.example', {
        name: 'Daily Digest',
        category: 'newsletters',
        count: 2,
        unsubscribe: { kind: 'one-click', url: 'https://news.example/u' },
      }),
      sender('sam@friend.example', { name: 'Sam', category: 'people', count: 1 }),
    ],
    cleanup: {
      plan: vi.fn(() => ({ ok: true as const, plan: { senders: [], rejected: [] } })),
      run: vi.fn(async () => ({ ok: false as const, error: 'invalid' as const, message: 'Nothing to do' })),
      history: () => [],
      undo: vi.fn(async () => ({ ok: true as const, restored: 2, missing: 0 })),
    },
    mail: {
      mailboxes: () => [
        { path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 2, unread: 1 },
        { path: 'Projects', name: 'Projects', role: null, delimiter: '/', total: 0, unread: 0 },
      ],
      refresh: vi.fn(async () => ({ ok: true as const, added: 1, removed: 0, changed: 2 })),
      messages: vi.fn(() => ({ total: 1, messages: [summary(7)] })),
      search: vi.fn(() => [summary(7)]),
      searchServer: vi.fn(async () => ({ ok: true as const, messages: [summary(3)] })),
      open: vi.fn(async (ref: { mailbox: string; uid: number }) =>
        ref.uid === 7
          ? { ok: true as const, message: content() }
          : {
              ok: false as const,
              error: 'not-found' as const,
              message: 'This message isn’t there any more.',
            },
      ),
    },
    calendar: {
      status: () => ({ connected: false, lastSync: null, syncing: false, subscriptions: 0 }),
      sync: vi.fn(async () => ({
        ok: true as const,
        calendars: 1,
        fetched: 1,
        skipped: 0,
        events: 2,
        stopped: false,
      })),
      calendars: () => [],
      events: () => [],
      locate: () => [],
      details: () => null,
      createEvent: vi.fn(async () => ({ ok: true as const, uid: 'NEW-UID' })),
      updateEvent: vi.fn(async (input: { ref: { uid: string } }) => ({
        ok: true as const,
        uid: input.ref.uid,
      })),
      deleteEvent: vi.fn(async (input: { ref: { uid: string } }) => ({
        ok: true as const,
        uid: input.ref.uid,
      })),
    },
    money: {
      overview: async () => ({
        bills: [],
        review: [],
        people: [{ id: 'me', name: 'Me' }],
        debts: [],
        settlements: [],
        monthlyTotal: 0,
        hasTransactions: false,
        mailConnected: true,
      }),
      transactions: async () => ({
        transactions: [],
        accounts: [],
        months: [],
        summary: { moneyIn: 0, moneyOut: 0, byCategory: [], byMonth: [] },
        uncategorisedMerchants: 0,
      }),
      importFile: vi.fn(async () => ({ ok: true as const, accountName: 'Monzo', added: 3, duplicates: 0 })),
      counts: () => ({ transactions: 0, accounts: 0, bills: 0 }),
      aiSort: vi.fn(async () => ({
        ok: false as const,
        message: 'Turn on AI for Money in Settings → AI first.',
      })),
    },
    ai: {
      settings: () => ({
        provider: 'none',
        model: null,
        sortSenders: false,
        money: false,
        boards: false,
        cloudConsent: null,
      }),
      status: async () => [],
      sort: vi.fn(async () => ({ ok: false as const, message: 'Choose a model in Settings → AI first.' })),
    },
    boards: {
      list: () => [
        {
          id: 'board-1-uuid',
          name: 'Home',
          rank: 'V',
          createdAt: '2026-11-01T10:00:00.000Z',
          cards: 2,
          overdue: 1,
        },
      ],
      cards: vi.fn(() => ({ ok: true as const, value: [boardCard()] })),
      addCard: vi.fn(async (input: { title: string }) => ({
        ok: true as const,
        value: boardCard({ title: input.title }),
      })),
      moveCard: vi.fn(async () => ({ ok: true as const, value: boardCard({ column: 'Doing' }) })),
      resolve: (q: { board?: string; column?: string; card?: string; labels?: string[] }) =>
        q.board && q.board !== 'Home'
          ? {
              ok: false as const,
              error: 'not-found' as const,
              message: `There’s no board called “${q.board}”.`,
            }
          : {
              ok: true as const,
              value: {
                board: 'Home',
                column: q.column ?? (q.card ? 'To do' : null),
                card: q.card ? boardCard() : null,
                labels: q.labels ?? [],
              },
            },
    },
    lockHolder: () => null,
    ...overrides,
  }
}
