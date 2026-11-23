import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The Finances charts' data, through the same function the IPC handler calls. Electron is replaced
// by a temp profile; the statement is the made-up Monzo export the e2e tests import.
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: true, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: {},
  BrowserWindow: {},
  safeStorage: { isEncryptionAvailable: () => false },
}))

dir.path = mkdtempSync(join(tmpdir(), 'ordo-charts-'))
const money = await import('./money')

const MONZO = readFileSync(
  resolve(__dirname, '../../../../packages/money-core/src/fixtures/monzo.csv'),
  'utf8',
)

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-23T12:00:00'))
  expect(
    await money.importStatement({ fileName: 'monzo.csv', text: MONZO, accountName: 'Monzo' }),
  ).toMatchObject({ ok: true })
})
afterAll(() => {
  vi.useRealTimers()
  money.closeMoney()
})

describe('Finances charts', () => {
  it('cover every month of the account whatever month is chosen, and compare the chosen month', async () => {
    const page = await money.transactions({ month: '2026-09' })
    expect(page.transactions.every((t) => t.date.startsWith('2026-09'))).toBe(true)
    const { trends, usual } = page.charts!
    expect(trends.months.map((m) => [m.month, m.partial])).toEqual([
      ['2026-07', 'start'],
      ['2026-08', undefined],
      ['2026-09', undefined],
      ['2026-10', undefined],
      ['2026-11', 'to-date'],
    ])
    // The totals for September match the chart's September.
    const sep = trends.months.find((m) => m.month === '2026-09')!
    expect(sep).toMatchObject({ moneyIn: page.summary.moneyIn, moneyOut: page.summary.moneyOut })
    // July starts on the 28th, so only August is a whole month before September.
    expect(usual).toMatchObject({ month: '2026-09', throughDay: null, baseline: ['2026-08'] })
  })

  it('compare the latest month, so far, when no month is chosen', async () => {
    const { usual } = (await money.transactions({})).charts!
    expect(usual).toMatchObject({
      month: '2026-11',
      throughDay: 23,
      baseline: ['2026-08', '2026-09', '2026-10'],
    })
    expect(usual!.total.thisMonth).toBeGreaterThan(0)
  })

  it('follow the account filter', async () => {
    const page = await money.transactions({ account: 'Nobody' })
    expect(page.charts).toEqual({ trends: { months: [], categories: [] }, usual: null })
  })
})
