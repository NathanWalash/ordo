import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { addDays, toISODate } from '@ordo/boards-core'

// The Boards service run without a window: the functions the IPC handlers, headless mode and the
// assistant call. Electron is replaced by a temp profile; LM Studio by a local stand-in.
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: false, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: {},
  BrowserWindow: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}))

dir.path = mkdtempSync(join(tmpdir(), 'ordo-boards-'))

let lmStudio: Server
const prompts: string[] = []
let answer: (prompt: string) => unknown = () => ({ due: null, checklist: [], labels: [], links: [] })

beforeAll(async () => {
  lmStudio = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
      const prompt: string = JSON.parse(body).messages.at(-1).content
      prompts.push(prompt)
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: JSON.stringify(answer(prompt)) } }],
        }),
      )
    })
  })
  await new Promise<void>((resolve) => lmStudio.listen(0, '127.0.0.1', resolve))
  process.env['ORDO_LMSTUDIO_URL'] = `http://127.0.0.1:${(lmStudio.address() as AddressInfo).port}`
})
afterAll(() => {
  boards.closeBoards()
  lmStudio.close()
})

const { initAi } = await import('./ai')
const boards = await import('./boards')
const calendar = await import('./calendar')

const ok = <T>(r: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw new Error(r.message)
  return r.value
}

describe('boards service', () => {
  it('creates a board from a template and lists it', async () => {
    const board = ok(await boards.createBoard({ name: 'Home', template: 'simple' }))
    expect(boards.list()).toEqual([
      expect.objectContaining({ id: board.id, name: 'Home', cards: 0, overdue: 0 }),
    ])
    const view = boards.board(board.id)!
    expect(view.columns.map((c) => c.name)).toEqual(['To do', 'Doing', 'Done'])
  })

  it('refuses bad input with a message, before touching anything', async () => {
    expect(await boards.createBoard({ name: 'x', template: 'nope' })).toMatchObject({
      ok: false,
      error: 'invalid',
    })
    expect(await boards.addCard({ boardId: 'missing', title: 'x' })).toMatchObject({
      ok: false,
      error: 'not-found',
    })
    expect(await boards.addCard(null)).toMatchObject({ ok: false, error: 'invalid' })
    expect(await boards.moveCard({ id: 'x', index: -1 })).toMatchObject({ ok: false, error: 'invalid' })
    expect(boards.board(42)).toBeNull()
    expect(await boards.card({})).toBeNull()
  })

  it('adds, moves and finds cards by name', async () => {
    const card = ok(
      await boards.addCardByRef({
        board: 'home',
        column: 'to do',
        title: 'Fix the gate',
        labels: ['urgent'],
      }),
    )
    ok(await boards.addCardByRef({ board: 'Home', title: 'Clear gutters' }))
    expect(boards.cardRow(card)).toMatchObject({ board: 'Home', column: 'To do', labels: ['Urgent'] })
    const moved = ok(await boards.moveCardByRef({ card: 'fix the gate', column: 'Doing', position: 1 }))
    expect(boards.cardRow(moved).column).toBe('Doing')
    ok(await boards.moveCardByRef({ card: card.id.slice(0, 8), column: 'To do', position: 1 }))
    const rows = ok(boards.cardsByRef({ board: 'Home' }))
    expect(rows.map((c) => c.title)).toEqual(['Fix the gate', 'Clear gutters'])
    expect(ok(boards.cardsByRef({ board: 'Home', label: 'URGENT' })).map((c) => c.title)).toEqual([
      'Fix the gate',
    ])
    expect(boards.cardsByRef({ board: 'Nowhere' })).toMatchObject({ ok: false, error: 'not-found' })
    expect(boards.cardsByRef({ column: 'Doing' })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await boards.moveCardByRef({ card: 'Nope' })).toMatchObject({ ok: false, error: 'not-found' })
    expect(await boards.addCardByRef({ board: 'Home', title: 'x', labels: ['Nope'] })).toMatchObject({
      ok: false,
    })
  })

  it('deletes with undo', async () => {
    const [card] = ok(boards.cardsByRef({ board: 'Home' }))
    const token = ok(await boards.deleteCard(card!.id))
    expect(ok(boards.cardsByRef({ board: 'Home' }))).toHaveLength(1)
    ok(await boards.restore(token))
    expect(ok(boards.cardsByRef({ board: 'Home' }))).toHaveLength(2)
    expect(await boards.restore(token)).toMatchObject({ ok: false, error: 'not-found' })
  })

  it('waits for nobody: refuses changes while another Ordo holds the write lock', async () => {
    const lock = join(dir.path, 'ordo-write.lock')
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.ppid, owner: 'mcp', task: 'sorting', since: new Date().toISOString() }),
    )
    try {
      const r = await boards.createBoard({ name: 'Blocked' })
      expect(r).toMatchObject({ ok: false, error: 'locked' })
      expect(r.ok ? '' : r.message).toMatch(/AI agent/)
      expect(boards.list().map((b) => b.name)).toEqual(['Home'])
    } finally {
      const { rmSync } = await import('node:fs')
      rmSync(lock, { force: true })
    }
  })

  it('shows dated cards on the Calendar, as a range when there is one', async () => {
    const today = toISODate()
    const [gate] = ok(boards.cardsByRef({ board: 'Home' }))
    ok(await boards.updateCard({ id: gate!.id, start: today, due: addDays(today, 2) }))
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const items = boards.dueDates({ start, end: new Date(start.getTime() + 7 * 86_400_000) })
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'card',
        title: 'Fix the gate',
        detail: 'Home',
        route: `boards?card=${gate!.id}`,
        until: expect.any(Date),
      }),
    ])
    expect(boards.dueDates({ start, end: new Date(start.getTime() + 500 * 86_400_000) })).toEqual([])
    expect(boards.dueDates('nonsense')).toEqual([])
  })

  it('links to calendar events and other cards, and resolves them again', async () => {
    const day = addDays(toISODate(), 5).replace(/-/g, '')
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ordo test//EN',
      'X-WR-CALNAME:Family',
      'BEGIN:VEVENT',
      'UID:locksmith-1',
      'DTSTAMP:20261101T000000Z',
      `DTSTART:${day}T090000`,
      `DTEND:${day}T100000`,
      'SUMMARY:Locksmith visit for the gate',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    expect(await calendar.addIcsText(ics, 'family.ics')).toMatchObject({ ok: true })

    const [gate, gutters] = ok(boards.cardsByRef({ board: 'Home' }))
    const events = await boards.linkCandidates({ cardId: gate!.id, kind: 'event', query: 'locksmith' })
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event).toMatchObject({ title: 'Locksmith visit for the gate', detail: 'Family · 09:00' })
    ok(
      await boards.addLink({
        cardId: gate!.id,
        target: event.target,
        title: event.title,
        detail: event.detail,
        date: event.date,
      }),
    )
    const cards = await boards.linkCandidates({ cardId: gate!.id, kind: 'card', query: '' })
    expect(cards.map((c) => c.title)).toEqual(['Clear gutters'])
    ok(await boards.addLink({ cardId: gate!.id, target: cards[0]!.target, title: 'Clear gutters' }))
    // Already linked things aren't offered again.
    expect(await boards.linkCandidates({ cardId: gate!.id, kind: 'event', query: '' })).toEqual([])

    const detail = (await boards.card(gate!.id))!
    expect(detail.links.map((l) => [l.title, l.found])).toEqual([
      ['Locksmith visit for the gate', true],
      ['Clear gutters', true],
    ])
    expect((await boards.card(gutters!.id))!.backlinks).toEqual([
      { cardId: gate!.id, title: 'Fix the gate', boardName: 'Home', columnName: 'To do' },
    ])

    // The event's calendar goes: the link stays, shown from its snapshot.
    const cal = calendar.calendars().find((c) => c.name === 'Family')!
    await calendar.removeCalendar(cal.id)
    expect((await boards.card(gate!.id))!.links[0]).toMatchObject({
      found: false,
      title: 'Locksmith visit for the gate',
    })
  })

  it('creates a card from an event, linked to it', async () => {
    const view = boards.board(boards.list()[0]!.id)!
    const card = ok(
      await boards.addCard({
        boardId: view.board.id,
        title: 'Prepare for dentist',
        due: toISODate(),
        link: {
          target: { kind: 'event', calendarId: 'cal', uid: 'u', start: new Date().toISOString() },
          title: 'Dentist',
        },
      }),
    )
    expect(card.links).toBe(1)
  })
})

const writeAi = (ai: Record<string, unknown>) => {
  writeFileSync(
    join(dir.path, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      ai: {
        provider: 'lmstudio',
        model: 'test-model',
        sortSenders: false,
        money: false,
        boards: false,
        cloudConsent: null,
        ...ai,
      },
    }),
  )
  initAi()
}

describe('Suggest', () => {
  it('needs a model first', async () => {
    const [card] = ok(boards.cardsByRef({ board: 'Home' }))
    expect(await boards.suggest(card!.id)).toMatchObject({ ok: false, error: 'no-ai' })
    expect(boards.suggestInfo()).toMatchObject({ ready: false, error: 'no-ai', provider: null })
  })

  it('needs AI for Boards turned on, and asks nothing until it is', async () => {
    writeAi({ boards: false })
    const asked = prompts.length
    const [card] = ok(boards.cardsByRef({ board: 'Home' }))
    expect(await boards.suggest(card!.id)).toMatchObject({ ok: false, error: 'off' })
    expect(prompts.length).toBe(asked)
    expect(boards.suggestInfo()).toEqual({
      ready: false,
      error: 'off',
      message: 'Turn on AI for Boards in Settings → AI first.',
      provider: { label: 'LM Studio', kind: 'local' },
      sends: ['event', 'card'],
    })
  })

  it('draws on bills only with AI for Money on, and emails only with sender sorting on', () => {
    writeAi({ boards: true, money: true })
    expect(boards.suggestInfo().sends).toEqual(['event', 'bill', 'card'])
    writeAi({ boards: true, sortSenders: true })
    expect(boards.suggestInfo().sends).toEqual(['event', 'email', 'card'])
  })

  it('asks the chosen local model and returns only checked picks, for that card', async () => {
    writeAi({ boards: true })
    const [card] = ok(boards.cardsByRef({ board: 'Home' }))
    // A card that shares a word with "Fix the gate", so it is offered as c1.
    const related = ok(await boards.addCardByRef({ board: 'Home', title: 'Order gate hinges' }))
    const due = addDays(toISODate(), 3)
    answer = () => ({
      due: { date: due, basedOn: 'zz' },
      checklist: ['Buy a new latch'],
      labels: ['l2', 'l99'],
      links: ['c1'],
    })
    const r = await boards.suggest(card!.id)
    if (!r.ok) throw new Error(r.message)
    expect(r.cardId).toBe(card!.id)
    expect(r.provider).toEqual({ label: 'LM Studio', kind: 'local' })
    expect(r.suggestions.due).toEqual({ date: due, basedOn: null })
    expect(r.suggestions.checklist).toEqual(['Buy a new latch'])
    expect(r.suggestions.labels.map((l) => l.name)).toEqual(['Waiting'])
    expect(r.suggestions.links.map((l) => l.target)).toEqual([{ kind: 'card', cardId: related.id }])
    const prompt = prompts.at(-1)!
    expect(prompt).toContain('{"id":"c1","kind":"card","title":"Order gate hinges"')
    expect(prompt).toContain('"title":"Fix the gate"')
    // Neither bills nor emails with those switches off.
    expect(prompt).not.toContain('"kind":"bill"')
    expect(prompt).not.toContain('"kind":"email"')
    expect(prompt).not.toContain('@')
  })

  it('says so when the model replies badly', async () => {
    const [card] = ok(boards.cardsByRef({ board: 'Home' }))
    answer = () => ({ nonsense: true })
    expect(await boards.suggest(card!.id)).toMatchObject({ ok: false, error: 'failed' })
    expect(await boards.suggest('missing')).toMatchObject({ ok: false, error: 'not-found' })
  })
})

describe('tidying deleted things', () => {
  it('never happens when the store is only opened to read', async () => {
    const [card] = ok(boards.cardsByRef({ board: 'Home' }))
    const token = ok(await boards.deleteCard(card!.id))
    boards.closeBoards()
    // Reading again, a week later, removes nothing.
    vi.setSystemTime(new Date(Date.now() + 7 * 86_400_000))
    try {
      boards.list()
      expect(boards.cardsByRef({ board: 'Home' }).ok).toBe(true)
      ok(await boards.restore(token))
      expect(ok(boards.cardsByRef({ board: 'Home' })).map((c) => c.id)).toContain(card!.id)
    } finally {
      vi.useRealTimers()
    }
    // The app tidies up, holding the write lock, a day after a delete.
    ok(await boards.deleteCard(card!.id))
    vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000))
    try {
      await boards.tidyBoards()
      expect(await boards.restore(token)).toMatchObject({ ok: false, error: 'not-found' })
    } finally {
      vi.useRealTimers()
    }
  })
})
