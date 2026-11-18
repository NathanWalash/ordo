import { describe, expect, it, vi } from 'vitest'
import { parseInvocation, type Command } from './args'
import { runCli, type CliIo } from './cli'
import { exitCodeFor, gate, runCommand } from './commands'
import { clean, formatHuman, pounds } from './format'
import { fakeServices } from './fake-services'

function io() {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (t) => void out.push(t), err: (t) => void err.push(t), errIsTTY: false }
  return { io, out, err }
}

async function cli(services: ReturnType<typeof fakeServices>, ...args: string[]) {
  const inv = parseInvocation(args)
  if (inv.kind === 'mcp') throw new Error('not here')
  const t = io()
  const code = await runCli(inv, services, t.io)
  return { code, stdout: t.out.join(''), stderr: t.err.join('') }
}

describe('the change gate', () => {
  it('needs --allow-changes on the command line, then confirm', () => {
    expect(gate('undo', false, true)).toMatchObject({ ok: false, code: 'changes_not_allowed' })
    expect(gate('undo', true, false)).toMatchObject({ ok: false, code: 'confirm_required' })
    expect(gate('undo', true, true)).toBeNull()
  })

  it.each([
    ['cleanup', 'run', '--sender', 'digest@news.example', '--confirm'],
    ['undo', '1', '--confirm'],
    ['money', 'import', 'x.csv', '--confirm'],
    ['ai', 'sort', '--confirm'],
    ['money', 'sort', '--confirm'],
  ])('%s %s is refused without --allow-changes and nothing is called', async (...args) => {
    const services = fakeServices()
    const r = await cli(services, ...args)
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/only runs it when started with --allow-changes\. Nothing was changed\./)
    expect(services.cleanup.run).not.toHaveBeenCalled()
    expect(services.cleanup.undo).not.toHaveBeenCalled()
    expect(services.money.importFile).not.toHaveBeenCalled()
    expect(services.ai.sort).not.toHaveBeenCalled()
    expect(services.money.aiSort).not.toHaveBeenCalled()
  })

  it('is refused without --confirm even when changes are allowed', async () => {
    const services = fakeServices()
    const r = await cli(services, 'undo', '1', '--allow-changes', '--json')
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stdout)).toEqual({
      error: {
        code: 'confirm_required',
        message: 'undo changes your data. Add --confirm to go ahead. Nothing was changed.',
      },
    })
    expect(services.cleanup.undo).not.toHaveBeenCalled()
  })

  it('runs with both', async () => {
    const services = fakeServices()
    const r = await cli(services, 'undo', '1', '--allow-changes', '--confirm', '--json')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ id: 1, restored: 2, missing: 0, reason: null })
    expect(services.cleanup.undo).toHaveBeenCalledWith(1)
  })

  it('reads never need it', async () => {
    expect((await cli(fakeServices(), 'senders')).code).toBe(0)
    expect((await cli(fakeServices(), 'cleanup', 'plan', '--sender', 'a@b.example')).code).toBe(0)
  })
})

describe('exit codes', () => {
  it('maps results to documented codes', () => {
    expect(exitCodeFor({ ok: true, data: {} })).toBe(0)
    expect(exitCodeFor({ ok: false, code: 'usage', message: '' })).toBe(2)
    expect(exitCodeFor({ ok: false, code: 'confirm_required', message: '' })).toBe(3)
    expect(exitCodeFor({ ok: false, code: 'locked', message: '' })).toBe(4)
    expect(exitCodeFor({ ok: false, code: 'network', message: '' })).toBe(1)
    expect(exitCodeFor({ ok: false, code: 'not_connected', message: '' })).toBe(1)
  })

  it('passes the lock through from a service', async () => {
    const services = fakeServices({
      scan: async () => ({ ok: false, error: 'locked', message: 'Ordo is busy in another Ordo window.' }),
    })
    const r = await cli(services, 'scan', '--json')
    expect(r.code).toBe(4)
    expect(JSON.parse(r.stdout)).toEqual({
      error: { code: 'locked', message: 'Ordo is busy in another Ordo window.' },
    })
  })
})

describe('commands', () => {
  const run = (command: Command, services = fakeServices()) =>
    runCommand(services, command, { allowChanges: false })

  it('status shows the email only, and the lock holder', async () => {
    const services = fakeServices({
      lockHolder: () => ({
        pid: 7,
        owner: 'app',
        task: 'scanning the inbox',
        since: '2026-11-17T10:00:00.000Z',
      }),
    })
    const r = await run({ name: 'status' }, services)
    expect(r).toMatchObject({
      ok: true,
      data: {
        version: '9.9.9',
        account: { connected: true, email: 'me@icloud.example', messages: 4 },
        counts: { senders: 2, cleanups: 0 },
        writeLock: { owner: 'app', task: 'scanning the inbox' },
      },
    })
    expect(JSON.stringify(r)).not.toMatch(/password|pid/)
  })

  it('needs an account for mail commands', async () => {
    const services = fakeServices({ account: () => ({ connected: false }) })
    expect(await run({ name: 'senders', limit: 5 }, services)).toMatchObject({
      ok: false,
      code: 'not_connected',
    })
    expect(await run({ name: 'scan' }, services)).toMatchObject({ ok: false, code: 'not_connected' })
    expect(services.scan).not.toHaveBeenCalled()
  })

  it('senders filters, limits and marks people as protected', async () => {
    const r = await run({ name: 'senders', limit: 1 })
    expect(r).toEqual({
      ok: true,
      data: {
        total: 2,
        offset: 0,
        shown: 1,
        senders: [
          {
            address: 'digest@news.example',
            name: 'Daily Digest',
            category: 'newsletters',
            emails: 2,
            unread: 1,
            lastSeen: '2026-11-16T10:00:00.000Z',
            unsubscribe: 'one-click',
            protected: false,
          },
        ],
      },
    })
    expect(await run({ name: 'senders', limit: 50, category: 'people' })).toMatchObject({
      data: { total: 1, senders: [{ address: 'sam@friend.example', protected: true }] },
    })
  })

  it('cleanup plan sends the same request the review sheet would', async () => {
    const services = fakeServices()
    await run(
      { name: 'cleanup plan', sender: ['A@x.example'], 'no-unsubscribe': true, 'no-trash': false },
      services,
    )
    expect(services.cleanup.plan).toHaveBeenCalledWith({
      senders: [{ address: 'A@x.example', unsubscribe: false, trash: true }],
    })
  })

  it('money import hands the path to the service unchanged', async () => {
    const services = fakeServices()
    const r = await runCommand(
      services,
      { name: 'money import', file: '../x.csv', account: 'Joint', confirm: true },
      { allowChanges: true },
    )
    expect(services.money.importFile).toHaveBeenCalledWith('../x.csv', 'Joint')
    expect(r).toEqual({ ok: true, data: { account: 'Monzo', added: 3, duplicates: 0 } })
  })

  it('money sort needs --confirm, works without a mail account and reports refusals as failures', async () => {
    const services = fakeServices({ account: () => ({ connected: false }) })
    const unconfirmed = await cli(services, 'money', 'sort', '--allow-changes')
    expect(unconfirmed.code).toBe(3)
    expect(services.money.aiSort).not.toHaveBeenCalled()
    const r = await cli(services, 'money', 'sort', '--allow-changes', '--confirm', '--json')
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toEqual({
      error: { code: 'failed', message: 'Turn on AI for Money in Settings → AI first.' },
    })
    expect(services.money.aiSort).toHaveBeenCalledTimes(1)
  })

  it('money sort summarises what the model did, and locked exits 4', async () => {
    const services = fakeServices()
    services.money.aiSort = vi.fn(async (onProgress) => {
      onProgress?.({ phase: 'categories', done: 1, total: 1 })
      return {
        ok: true as const,
        merchants: 3,
        checked: 3,
        changed: 2,
        cached: 1,
        failed: 0,
        billPairs: 1,
        billsMatched: 1,
        errors: [],
      }
    })
    const r = await cli(services, 'money', 'sort', '--allow-changes', '--confirm')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      'Checked 3 merchants of 3 in Other: 2 categorised, 1 from earlier answers, 0 failed. Matched 1 bill to email, to confirm in the app.\n',
    )
    expect(r.stderr).toContain('Sorting merchants: 1 of 1')

    services.money.aiSort = vi.fn(async () => ({
      ok: false as const,
      error: 'locked' as const,
      message: 'Ordo is busy in another Ordo window (sorting senders with AI). Try again when it finishes.',
    }))
    expect((await cli(services, 'money', 'sort', '--allow-changes', '--confirm')).code).toBe(4)
  })

  it('money transactions shows who chose a category', async () => {
    const tx = { accountName: 'Monzo', date: '2026-11-06', description: 'ZORBLAX', amount: -1450 }
    const services = fakeServices()
    services.money.transactions = async () => ({
      transactions: [
        { ...tx, id: 'a', merchant: 'Zorblax', category: 'Shopping', categorisedBy: 'ai', confidence: 0.85 },
        { ...tx, id: 'b', merchant: 'Mine', category: 'Health', categorisedBy: 'you' },
        { ...tx, id: 'c', merchant: 'Tesco', category: 'Groceries' },
      ],
      accounts: ['Monzo'],
      months: ['2026-11'],
      summary: { moneyIn: 0, moneyOut: 4350, byCategory: [], byMonth: [] },
      uncategorisedMerchants: 0,
    })
    const json = JSON.parse((await cli(services, 'money', 'transactions', '--json')).stdout)
    expect(
      json.transactions.map((t: Record<string, unknown>) => [
        t['category'],
        t['categorisedBy'],
        t['confidence'],
      ]),
    ).toEqual([
      ['Shopping', 'ai', 0.85],
      ['Health', 'you', undefined],
      ['Groceries', undefined, undefined],
    ])
    const human = (await cli(services, 'money', 'transactions')).stdout
    expect(human).toContain('Shopping*')
    expect(human).toContain('* categorised by AI')
  })

  it('ai sort reports the consent refusal as a failure', async () => {
    const r = await runCommand(fakeServices(), { name: 'ai sort', confirm: true }, { allowChanges: true })
    expect(r).toEqual({ ok: false, code: 'failed', message: 'Choose a model in Settings → AI first.' })
  })
})

describe('output', () => {
  it('--json prints exactly one JSON document on stdout', async () => {
    const r = await cli(fakeServices(), 'senders', '--json')
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toMatchObject({ total: 2 })
  })

  it('human errors go to stderr, leaving stdout empty', async () => {
    const r = await cli(fakeServices({ account: () => ({ connected: false }) }), 'senders')
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('Error: No iCloud account is connected. Open Ordo and connect one in Mail first.\n')
  })

  it('progress goes to stderr', async () => {
    const services = fakeServices({
      scan: async (onProgress) => {
        onProgress?.({ phase: 'inbox', checked: 0, total: 4 })
        onProgress?.({ phase: 'done', checked: 4, total: 4 })
        return { ok: true, added: 4, total: 4, stopped: false }
      },
    })
    const r = await cli(services, 'scan', '--json')
    expect(r.stderr).toBe('Scanning inbox: 0 of 4\nDone: 4 of 4\n')
    expect(JSON.parse(r.stdout)).toEqual({ added: 4, total: 4, stopped: false })
  })

  it('an unexpected error is reported without internals on stdout', async () => {
    const services = fakeServices({
      senders: async () => {
        throw new Error('/Users/me/secret/path exploded')
      },
    })
    const r = await cli(services, 'senders', '--json')
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toEqual({
      error: { code: 'internal', message: 'Something went wrong inside Ordo.' },
    })
    expect(r.stdout).not.toContain('secret')
  })

  it('help lists every command', async () => {
    const r = await cli(fakeServices(), '--help')
    expect(r.code).toBe(0)
    for (const c of [
      'status',
      'scan',
      'senders',
      'cleanup plan',
      'cleanup run',
      'history',
      'undo',
      'calendar sync',
    ])
      expect(r.stdout).toContain(c)
    const j = await cli(fakeServices(), '--help', '--json')
    expect(JSON.parse(j.stdout).commands).toContainEqual({ name: 'cleanup run', changes: true })
  })

  it('strips control characters and bidi tricks from third-party text', () => {
    expect(clean('Evil\u001b[2J\r\nCorp‮')).toBe('Evil [2J  Corp ')
    expect(clean('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
    const text = formatHuman('senders', {
      ok: true,
      data: {
        total: 1,
        offset: 0,
        shown: 1,
        senders: [
          {
            address: 'a@b.example',
            name: 'Line\nbreak\u001b]0;title\u0007',
            category: 'promotions',
            emails: 1,
            unsubscribe: 'none',
            protected: false,
          },
        ],
      },
    })
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/)
    expect(text.split('\n')).toHaveLength(2)
  })

  it('formats pence as pounds', () => {
    expect(pounds(1299)).toBe('£12.99')
    expect(pounds(-50)).toBe('-£0.50')
    expect(pounds(null)).toBe('?')
  })

  it('a dry run says nothing changed and lists refusals', () => {
    const text = formatHuman('cleanup plan', {
      ok: true,
      data: {
        senders: [
          {
            address: 'digest@news.example',
            name: 'Daily Digest',
            category: 'newsletters',
            emails: 2,
            trash: true,
            unsubscribe: { kind: 'one-click', url: 'https://news.example/u' },
          },
        ],
        rejected: [{ address: 'sam@friend.example', reason: 'Someone you’ve written to.' }],
        summary: { senders: 1, emailsToTrash: 2, unsubscribes: 1 },
      },
    })
    expect(text).toBe(
      [
        'Dry run. Nothing has changed. Ordo would clear 1 sender: move 2 emails to Trash and unsubscribe from 1.',
        '  Daily Digest <digest@news.example>',
        '    move 2 emails to Trash',
        '    unsubscribe with one click (POST https://news.example/u)',
        '  Refused sam@friend.example: Someone you’ve written to.',
      ].join('\n'),
    )
  })
})

describe('calendar events', () => {
  it('shows all-day events on their own day and times on this computer’s clock', async () => {
    const tz = process.env['TZ']
    process.env['TZ'] = 'Europe/London' // BST in July: local midnight is 23:00 UTC the day before
    try {
      const services = fakeServices()
      services.calendar.events = () => [
        {
          id: 'a',
          calendarId: 'c',
          title: 'Holiday',
          start: new Date(2026, 6, 10),
          end: new Date(2026, 6, 11),
          allDay: true,
        },
        {
          id: 'b',
          calendarId: 'c',
          title: 'Dentist',
          start: new Date(2026, 6, 10, 9, 0),
          end: new Date(2026, 6, 10, 10, 0),
          allDay: false,
        },
      ]
      const json = await cli(
        services,
        'calendar',
        'events',
        '--from',
        '2026-07-01',
        '--to',
        '2026-07-31',
        '--json',
      )
      const events = JSON.parse(json.stdout).events
      expect(events[0]).toMatchObject({
        title: 'Holiday',
        start: '2026-07-10',
        end: '2026-07-11',
        allDay: true,
      })
      expect(events[1]).toMatchObject({ title: 'Dentist', start: '2026-07-10T08:00:00.000Z' })

      const human = await cli(services, 'calendar', 'events', '--from', '2026-07-01', '--to', '2026-07-31')
      expect(human.stdout).toContain('2026-07-10 all day')
      expect(human.stdout).toContain('2026-07-10 09:00')
    } finally {
      if (tz === undefined) delete process.env['TZ']
      else process.env['TZ'] = tz
    }
  })
})
