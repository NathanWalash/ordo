import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// What Ordo learns about money, through the same main-process functions the IPC handlers call.
// Electron is replaced by a temp profile; the statement is the made-up one the e2e tests use.
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: true, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: {},
  BrowserWindow: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

dir.path = mkdtempSync(join(tmpdir(), 'ordo-memory-'))
const ai = await import('./ai')
const money = await import('./money')
const memory = await import('./money-memory')

const MONZO = readFileSync(resolve(__dirname, '../../../../e2e/fixtures/memory-monzo.csv'), 'utf8')
let id: (text: string) => string

beforeAll(async () => {
  ai.initAi()
  expect(
    await money.importStatement({ fileName: 'monzo.csv', text: MONZO, accountName: 'Monzo' }),
  ).toMatchObject({
    ok: true,
  })
  const page = await money.transactions({})
  id = (text) =>
    page.transactions.find((t) => `${t.description} ${t.merchant ?? ''}`.toUpperCase().includes(text))!.id
})
afterAll(() => money.closeMoney())

describe('the same money in is only ever one payback or pass-through', () => {
  it('a second payback or pass-through for it is refused', async () => {
    const payback = { kind: 'payback', inId: id('GENEST'), outIds: [id('PARTY SHOP')] }
    expect(await memory.saveFact({ fact: payback })).toMatchObject({ ok: true })
    expect(await memory.saveFact({ fact: payback })).toEqual({
      ok: false,
      message: 'Ordo already knows what that money in was. Forget the old fact first.',
    })
    expect(
      await memory.saveFact({ fact: { kind: 'pass-through', inId: id('GENEST'), outId: id('SAM SELLER') } }),
    ).toMatchObject({ ok: false })
    const v = await memory.view()
    expect(v.facts.filter((f) => f.kind === 'payback')).toHaveLength(1)
  })

  it('changing the same fact is still fine', async () => {
    const v = await memory.view()
    const p = v.facts.find((f) => f.kind === 'payback')!
    expect(
      await memory.saveFact({
        id: p.id,
        fact: { kind: 'payback', inId: id('GENEST'), outIds: [id('PARTY SHOP')], person: 'Genest J' },
      }),
    ).toMatchObject({ ok: true })
  })
})

describe('forgetting an event keeps the paybacks and money owed for it', () => {
  it('unlinks them, pointing them at the event’s payments instead, and says so', async () => {
    expect(
      await memory.saveFact({ fact: { kind: 'event', name: 'Italy', from: '2026-08-28', to: '2026-09-04' } }),
    ).toMatchObject({ ok: true })
    const event = (await memory.view()).facts.find((f) => f.kind === 'event')!
    expect(
      await memory.saveFact({
        fact: { kind: 'payback', inId: id('LUCA'), eventId: event.id, person: 'Luca B' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      await memory.saveFact({
        fact: { kind: 'owed', person: 'Luca B', amount: 1000, date: '2026-09-05', eventId: event.id },
      }),
    ).toMatchObject({ ok: true })

    const r = await memory.deleteFact(event.id)
    expect(r).toEqual({
      ok: true,
      message: 'Forgot Italy. 1 payback and 1 amount owed for it are kept, now linked to its payments.',
    })
    const facts = (await memory.view()).facts
    expect(facts.some((f) => f.kind === 'event')).toBe(false)
    const luca = facts.find((f) => f.kind === 'payback' && f.inId === id('LUCA'))
    expect(luca).toMatchObject({ outIds: expect.arrayContaining([id('TRENITALIA')]) })
    expect(luca).not.toHaveProperty('eventId')
    const owed = facts.find((f) => f.kind === 'owed')
    expect(owed).toMatchObject({ outIds: expect.arrayContaining([id('RISTORANTE')]) })
    expect(owed).not.toHaveProperty('eventId')
  })
})

describe('questions', () => {
  it('are worked out once per change, and answering one updates them', async () => {
    const first = (await memory.view()).questions
    expect((await memory.view()).questions).toEqual(first)
    const q = first.find((x) => x.kind === 'regular-in')!
    expect(await memory.answer({ questionId: q.id, answerId: 'later' })).toMatchObject({ ok: true })
    expect((await memory.view()).questions.some((x) => x.id === q.id)).toBe(false)
  })
})
