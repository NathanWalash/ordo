import { vi } from 'vitest'
import type { CategorisedSender, MemoryView } from '@ordo/shared'
import type { OrdoServices } from './commands'

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
        cloudConsent: null,
        moneyDetailsConsent: null,
        askStyle: 'brief',
        askClarify: true,
      }),
      status: async () => [],
      sort: vi.fn(async () => ({ ok: false as const, message: 'Choose a model in Settings → AI first.' })),
    },
    lockHolder: () => null,
    ...overrides,
  }
}
