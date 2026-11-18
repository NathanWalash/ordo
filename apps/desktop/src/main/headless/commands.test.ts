import { describe, expect, it, vi } from 'vitest'
import { parseInvocation, type Command } from './args'
import { runCli, type CliIo } from './cli'
import { exitCodeFor, gate, runCommand } from './commands'
import { clean, formatHuman, pounds } from './format'
import { boardCard, fakeServices, summary } from './fake-services'

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
    ['boards', 'add-card', '--board', 'Home', '--title', 'x', '--confirm'],
    ['boards', 'move-card', 'Fix the gate', '--column', 'Doing', '--confirm'],
    ['mail', 'move', '7', '--to', 'archive', '--confirm'],
    ['mail', 'flag', '7', '--confirm'],
    ['mail', 'mark', '7', '--read', '--confirm'],
    ['mail', 'undo', '--confirm'],
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
    expect(services.boards.addCard).not.toHaveBeenCalled()
    expect(services.boards.moveCard).not.toHaveBeenCalled()
    expect(services.mail.move).not.toHaveBeenCalled()
    expect(services.mail.setFlags).not.toHaveBeenCalled()
    expect(services.mail.undoMove).not.toHaveBeenCalled()
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

  it('mail commands need an account too', async () => {
    const services = fakeServices({ account: () => ({ connected: false }) })
    for (const c of ['mailboxes', 'list', 'sync'] as const)
      expect(await cli(services, 'mail', c, '--json')).toMatchObject({ code: 1 })
    expect(services.mail.refresh).not.toHaveBeenCalled()
  })

  it('mail list and search print the uid to read, with control characters removed', async () => {
    const services = fakeServices()
    services.mail.messages = vi.fn(() => ({
      total: 1,
      messages: [summary(7, { subject: 'Hi\u001b[31m\u202eevil' })],
    }))
    const r = await cli(services, 'mail', 'list', '--mailbox', 'Archive', '--unread')
    expect(services.mail.messages).toHaveBeenCalledWith({
      mailbox: 'Archive',
      limit: 25,
      offset: 0,
      unread: true,
    })
    expect(r.stdout).toMatch(/^UID +DATE/)
    expect(r.stdout).toContain('Sam')
    expect(r.stdout).not.toContain(String.fromCharCode(0x1b))
    expect(r.stdout).not.toContain(String.fromCharCode(0x202e))
    const s = await cli(fakeServices(), 'mail', 'search', 'lunch', '--json')
    expect(JSON.parse(s.stdout)).toMatchObject({ where: 'cache', mailbox: null, messages: [{ uid: 7 }] })
  })

  it('mail read prints text, never HTML, and never escape sequences', async () => {
    const r = await cli(fakeServices(), 'mail', 'read', '7')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('From:    Sam <sam@friend.example>')
    expect(r.stdout).toContain('Files:   menu.pdf')
    expect(r.stdout).toContain('Fancy lunch?')
    expect(r.stdout).toContain('The menu <https://cafe.example/menu>')
    expect(r.stdout).not.toMatch(/<p>|<script>/)
    expect(r.stdout).not.toContain(String.fromCharCode(0x1b))
    const gone = await cli(fakeServices(), 'mail', 'read', '8', '--json')
    expect(gone.code).toBe(1)
    expect(JSON.parse(gone.stdout).error.code).toBe('not_found')
  })

  it('mail move, flag and mark change cached messages, and say so', async () => {
    const services = fakeServices()
    const go = ['--allow-changes', '--confirm']
    const moved = await cli(services, 'mail', 'move', '7', '8', '--to', 'bin', ...go, '--json')
    expect(moved.code).toBe(0)
    expect(JSON.parse(moved.stdout)).toEqual({
      mailbox: 'INBOX',
      to: 'Deleted Messages',
      moved: 2,
      undoId: 5,
    })
    expect(services.mail.move).toHaveBeenCalledWith({ mailbox: 'INBOX', uids: [7, 8], to: 'trash' })
    const human = await cli(services, 'mail', 'move', '7', '--to', 'Projects', ...go)
    expect(human.stdout).toBe(
      'Moved 1 message from INBOX to Projects. Undo with `mail undo 5 --confirm` while this Ordo is running.\n',
    )
    expect(services.mail.move).toHaveBeenLastCalledWith({
      mailbox: 'INBOX',
      uids: [7],
      to: { folder: 'Projects' },
    })
    expect((await cli(services, 'mail', 'flag', '7', '--unflag', ...go)).stdout).toBe(
      'Unflagged 1 message.\n',
    )
    expect(services.mail.setFlags).toHaveBeenCalledWith({ mailbox: 'INBOX', uids: [7], flagged: false })
    expect((await cli(services, 'mail', 'mark', '7', '8', '--read', ...go)).stdout).toBe(
      'Marked 2 messages as read.\n',
    )
    expect(services.mail.setFlags).toHaveBeenLastCalledWith({ mailbox: 'INBOX', uids: [7, 8], seen: true })
  })

  it('mail changes refuse unknown folders, Drafts, and messages Ordo hasn’t cached', async () => {
    const services = fakeServices()
    const go = ['--allow-changes', '--confirm', '--json']
    const nowhere = await cli(services, 'mail', 'move', '7', '--to', 'Elsewhere', ...go)
    expect(nowhere.code).toBe(1)
    expect(JSON.parse(nowhere.stdout).error.code).toBe('not_found')
    const drafts = await cli(services, 'mail', 'move', '7', '--to', 'drafts', ...go)
    expect(JSON.parse(drafts.stdout).error).toEqual({
      code: 'invalid',
      message: 'Messages can’t be moved into Drafts.',
    })
    const unknown = await cli(services, 'mail', 'flag', '7', '42', ...go)
    expect(JSON.parse(unknown.stdout).error.message).toMatch(/doesn’t have message 42 in INBOX/)
    expect(services.mail.move).not.toHaveBeenCalled()
    expect(services.mail.setFlags).not.toHaveBeenCalled()
  })

  it('mail undo puts back the last move made by this Ordo run', async () => {
    const services = fakeServices()
    const go = ['--allow-changes', '--confirm', '--json']
    const none = await cli(services, 'mail', 'undo', ...go)
    expect(JSON.parse(none.stdout).error).toMatchObject({ code: 'not_found' })
    services.mail.lastMove = () => ({ undoId: 9, from: 'INBOX', to: 'Archive', count: 1, messages: [] })
    expect(JSON.parse((await cli(services, 'mail', 'undo', ...go)).stdout)).toEqual({
      undoId: 9,
      restored: 1,
    })
    expect(services.mail.undoMove).toHaveBeenCalledWith(9)
    await cli(services, 'mail', 'undo', '3', ...go)
    expect(services.mail.undoMove).toHaveBeenLastCalledWith(3)
  })

  it('mail sync refreshes one folder and is not a change', async () => {
    const services = fakeServices()
    const r = await cli(services, 'mail', 'sync', '--mailbox', 'Projects', '--json')
    expect(r.code).toBe(0)
    expect(services.mail.refresh).toHaveBeenCalledWith({ mailbox: 'Projects' }, expect.anything())
    expect(JSON.parse(r.stdout)).toEqual({ mailbox: 'Projects', added: 1, removed: 0, changed: 2 })
  })

  it('senders filters, limits and marks people as protected', async () => {
    const r = await run({ name: 'senders', limit: 1 })
    expect(r).toEqual({
      ok: true,
      data: {
        category: null,
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

  it('an empty category says so, instead of asking for a scan', async () => {
    const r = await cli(fakeServices(), 'senders', '--category', 'receipts')
    expect(r.stdout).toBe('No senders in receipts.\n')
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
  it('--json escapes C1 controls and bidi characters, so it is safe to print, and still parses', async () => {
    const tricky = `a\u009bb\u202ec\u2066d\u200fe\u2028f`
    const services = fakeServices()
    services.mail.messages = vi.fn(() => ({ total: 1, messages: [summary(7, { subject: tricky })] }))
    const r = await cli(services, 'mail', 'list', '--json')
    const unsafe = new RegExp('[\\u0080-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029]')
    expect(r.stdout).not.toMatch(unsafe)
    expect(r.stdout).toContain('\\u009b')
    expect(r.stdout).toContain('\\u202e')
    expect(JSON.parse(r.stdout).messages[0].subject).toBe(tricky)
  })

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
      'mail read <uid>',
      'mail search <words>',
      'mail move <uid>...',
      'mail flag <uid>...',
      'mail mark <uid>...',
      'mail undo',
      'boards list',
      'boards cards',
      'boards add-card',
      'boards move-card',
    ])
      expect(r.stdout).toContain(c)
    const j = await cli(fakeServices(), '--help', '--json')
    expect(JSON.parse(j.stdout).commands).toContainEqual({ name: 'cleanup run', changes: true })
  })

  it('strips control characters and bidi tricks from third-party text', () => {
    expect(clean('Evil\u001b[2J\r\nCorp\u202e')).toBe('Evil [2J  Corp ')
    expect(clean('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`)
    // Zero-width, direction marks, line and paragraph separators and the BOM go too.
    for (const code of [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x061c, 0xfeff])
      expect(clean(`a${String.fromCharCode(code)}b`)).toBe('a b')
    // Right-to-left and left-to-right marks reorder text; line and paragraph separators start lines.
    const sneaky = ['a', 0x200f, 'b', 0x200e, 'c', 0x061c, 'd', 0x2028, 'e', 0x2029, 'f']
      .map((p) => (typeof p === 'number' ? String.fromCharCode(p) : p))
      .join('')
    expect(clean(sneaky)).toBe('a b c d e f')
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
          uid: 'a',
          calendarId: 'c',
          title: 'Holiday',
          start: new Date(2026, 6, 10),
          end: new Date(2026, 6, 11),
          allDay: true,
        },
        {
          uid: 'b',
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

describe('boards', () => {
  it('lists boards without needing an account', async () => {
    const services = fakeServices({ account: () => ({ connected: false }) })
    const r = await cli(services, 'boards', 'list', '--json')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({
      boards: [{ id: 'board-1-uuid', name: 'Home', cards: 2, overdue: 1 }],
    })
    const human = await cli(services, 'boards', 'list')
    expect(human.stdout).toMatch(/CARDS\s+OVERDUE\s+ID\s+BOARD/)
    expect(human.stdout).toMatch(/2\s+1\s+board-1-\s+Home/)
  })

  it('lists cards by board, column and labels, paged', async () => {
    const services = fakeServices()
    const r = await cli(
      services,
      'boards',
      'cards',
      '--board',
      'Home',
      '--label',
      'Urgent',
      '--label',
      'Home',
      '--json',
    )
    expect(services.boards.cards).toHaveBeenCalledWith({
      board: 'Home',
      column: undefined,
      labels: ['Urgent', 'Home'],
      archived: false,
    })
    expect(JSON.parse(r.stdout)).toMatchObject({
      board: 'Home',
      total: 1,
      shown: 1,
      cards: [{ title: 'Fix the gate' }],
    })
    const human = await cli(services, 'boards', 'cards', '--board', 'Home')
    expect(human.stdout).toContain('c0ffee00  To do   2026-11-20  Fix the gate  [Urgent]  1/3')
  })

  it('reports an unknown board as a failure, exit 1', async () => {
    const services = fakeServices()
    services.boards.cards = () => ({
      ok: false,
      error: 'not-found',
      message: 'There’s no board called “Nope”.',
    })
    const r = await cli(services, 'boards', 'cards', '--board', 'Nope', '--json')
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toEqual({
      error: { code: 'invalid', message: 'There’s no board called “Nope”.' },
    })
  })

  it('adds a card with --allow-changes and --confirm', async () => {
    const services = fakeServices()
    const r = await cli(
      services,
      'boards',
      'add-card',
      '--board',
      'Home',
      '--title',
      'Book the MOT',
      '--due',
      '2026-12-01',
      '--label',
      'Urgent',
      '--allow-changes',
      '--confirm',
    )
    expect(r.code).toBe(0)
    expect(services.boards.addCard).toHaveBeenCalledWith({
      board: 'Home',
      column: undefined,
      title: 'Book the MOT',
      notes: undefined,
      start: undefined,
      due: '2026-12-01',
      labels: ['Urgent'],
    })
    expect(r.stdout).toBe('Added “Book the MOT” to Home › To do (c0ffee00).\n')
  })

  it('checks add-card arguments', () => {
    expect(() => parseInvocation(['boards', 'add-card', '--title', 'x'])).toThrow(/needs --board/)
    expect(() => parseInvocation(['boards', 'add-card', '--board', 'Home'])).toThrow(/needs --title/)
    expect(() =>
      parseInvocation(['boards', 'add-card', '--board', 'H', '--title', 'x', '--due', '2026-02-30']),
    ).toThrow(/isn't a real date/)
    expect(() => parseInvocation(['boards', 'move-card', 'x', '--position', '0'])).toThrow(/starts at 1/)
    expect(() => parseInvocation(['boards', 'move-card'])).toThrow(/needs a card/)
    expect(() => parseInvocation(['boards', 'list', '--board', 'x'])).toThrow(/doesn't take --board/)
  })

  it('moves a card by title to a column and position', async () => {
    const services = fakeServices()
    const r = await cli(
      services,
      'boards',
      'move-card',
      'Fix the gate',
      '--column',
      'Doing',
      '--position',
      '1',
      '--allow-changes',
      '--confirm',
      '--json',
    )
    expect(r.code).toBe(0)
    expect(services.boards.moveCard).toHaveBeenCalledWith({
      card: 'Fix the gate',
      board: undefined,
      column: 'Doing',
      position: 1,
    })
    expect(JSON.parse(r.stdout).card).toMatchObject({ column: 'Doing' })
  })

  it('passes the write lock through, exit 4', async () => {
    const services = fakeServices()
    services.boards.moveCard = async () => ({ ok: false, error: 'locked', message: 'Ordo is busy.' })
    const r = await cli(services, 'boards', 'move-card', 'x', '--allow-changes', '--confirm')
    expect(r.code).toBe(4)
  })

  it('strips control characters from card titles in human output', async () => {
    const services = fakeServices()
    services.boards.cards = () => ({ ok: true, value: [boardCard({ title: 'Evil\u001b[2Jtitle\u202e' })] })
    const r = await cli(services, 'boards', 'cards')
    expect(r.stdout).not.toContain('\u001b')
    expect(r.stdout).not.toContain('\u202e')
  })
})
