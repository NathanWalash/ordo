import { vi } from 'vitest'
import type { CategorisedSender, MailAccount, MemoryView, MessageContent, MessageSummary } from '@ordo/shared'
import type { BoardCardRow, OrdoServices } from './commands'

const period = (from: string, to: string, spent: number) => ({
  from,
  to,
  spent,
  paidBack: 0,
  net: spent,
  byCategory: [{ category: 'Home', amount: spent }],
})

/** What Ordo has learned, for the memory commands: one held balance, one question, one event. */
export function memoryView(): MemoryView {
  return {
    facts: [
      {
        id: 'f1',
        kind: 'held',
        from: 'Gabe',
        forPerson: 'Patrick',
        what: 'rent',
        createdAt: '2026-11-18T10:00:00.000Z',
        source: 'question',
        summary: 'Money from Gabe is rent you hold for Patrick, not your income.',
      },
    ],
    questions: [
      {
        id: 'pass-through:m1>m2',
        kind: 'pass-through',
        step: 'matches',
        text: "H Bennie's £50.00 on 5 Oct went out again the same day to Sam. Was it just passing through?",
        confidence: 'exact',
        answers: [
          { id: 'yes', label: 'Yes, passing through' },
          { id: 'no', label: 'No' },
        ],
      },
    ],
    held: [
      {
        factId: 'f1',
        from: 'Gabe',
        forPerson: 'Patrick',
        what: 'rent',
        received: 89550,
        passedOn: 59700,
        holding: 29850,
        lastIn: '2026-11-01',
        lastOut: '2026-10-02',
        ins: [],
        outs: [],
      },
    ],
    owed: [
      {
        factId: 'f2',
        person: 'Someone',
        amount: 3000,
        received: 0,
        outstanding: 3000,
        date: '2026-10-31',
        note: 'Halloween',
      },
    ],
    billsOwed: [],
    events: [
      {
        id: 'e1',
        name: 'Italy',
        from: '2026-08-28',
        to: '2026-09-04',
        paidOut: 42399,
        paidBack: 500,
        net: 41899,
        byCategory: [{ category: 'Other', amount: 25000 }],
        byAccount: [],
        outgoings: [],
        paybacks: [],
        excluded: 1,
      },
    ],
    people: [],
    caveats: [
      { account: 'HSBC', dates: 'posting', from: 'bank', text: 'HSBC shows the day a payment cleared.' },
    ],
    compare: {
      category: null,
      account: null,
      thisMonth: period('2026-11-01', '2026-11-18', 5000),
      lastMonth: period('2026-10-01', '2026-10-18', 8000),
      difference: -3000,
      caveats: ['HSBC shows posting dates, so the last few days may not be in yet.'],
    },
    accounts: ['HSBC', 'Monzo'],
    categories: ['Home'],
    hasTransactions: true,
    ask: { ready: false, provider: null, cloud: false, reason: 'no-model' },
  }
}

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

/** The fake services' one mail account, unless a test gives more. */
export const FAKE_ACCOUNT: MailAccount = {
  id: 'acc-1',
  label: 'iCloud',
  email: 'me@icloud.example',
  color: 'blue',
  provider: 'icloud',
  imap: { host: 'imap.mail.me.com', port: 993, secure: true },
  smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true },
  auth: { kind: 'password' },
  lastScan: null,
}

/** A second account, for tests of several accounts. */
export const WORK_ACCOUNT: MailAccount = {
  ...FAKE_ACCOUNT,
  id: 'acc-work',
  label: 'Work',
  email: 'me@work.example',
  color: 'green',
  provider: 'gmail',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false },
}

/** A message list row. */
export function summary(uid: number, extra: Partial<MessageSummary> = {}): MessageSummary {
  return {
    account: 'acc-1',
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
    account: () => ({
      connected: true,
      email: 'me@icloud.example',
      lastScan: null,
      messageCount: 4,
      accounts: [FAKE_ACCOUNT],
    }),
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
      accounts: () => [FAKE_ACCOUNT],
      mailboxes: () => [
        { path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 2, unread: 1 },
        { path: 'Archive', name: 'Archive', role: 'archive', delimiter: '/', total: 0, unread: 0 },
        {
          path: 'Deleted Messages',
          name: 'Deleted Messages',
          role: 'trash',
          delimiter: '/',
          total: 0,
          unread: 0,
        },
        { path: 'Drafts', name: 'Drafts', role: 'drafts', delimiter: '/', total: 0, unread: 0 },
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
      // Messages 7 and 8 are cached in the inbox; 7 is Sam's lunch email.
      cached: vi.fn((ref: { mailbox: string; uid: number }) =>
        ref.mailbox === 'INBOX' && ref.uid === 7
          ? summary(7)
          : ref.mailbox === 'INBOX' && ref.uid === 8
            ? summary(8, {
                from: { address: 'digest@news.example', name: 'Daily Digest' },
                subject: 'Issue 12',
                seen: true,
                flagged: false,
              })
            : null,
      ),
      setFlags: vi.fn(async () => ({ ok: true as const })),
      move: vi.fn(async (input: { uids: number[] }) => ({
        ok: true as const,
        moved: input.uids.length,
        undoId: 5,
      })),
      lastMove: vi.fn(() => null),
      undoMove: vi.fn(async () => ({ ok: true as const, restored: 1 })),
      saveDraft: vi.fn(async () => ({
        ok: true as const,
        draft: { mailbox: 'Drafts', uid: 30 },
        attachments: [],
      })),
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
      memory: async () => memoryView(),
      answer: vi.fn(async () => ({ ok: true as const, facts: 1 })),
      forget: vi.fn(async () => ({ ok: true as const })),
      compare: vi.fn(async () => memoryView().compare),
    },
    ai: {
      settings: () => ({
        provider: 'none',
        model: null,
        sortSenders: false,
        money: false,
        boards: false,
        cloudConsent: null,
        moneyDetailsConsent: null,
        askStyle: 'brief',
        askClarify: true,
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
