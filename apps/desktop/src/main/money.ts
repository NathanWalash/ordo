import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import {
  ME,
  allocate,
  applySuggestions,
  balances,
  billsToCalendarItems,
  detectRecurring,
  emailHints,
  filterTransactions,
  linkBills,
  monthlyCost,
  monthOf,
  noAdvisor,
  parseStatement,
  resolveBills,
  splitStartDate,
  summarise,
  toISODate,
  validateSplit,
  type DetectedBill,
  type MatchAdvisor,
  type StoredBill,
} from '@ordo/money-core'
import { MoneyStore } from '@ordo/money-core/node'
import {
  BillInputSchema,
  ConfirmBillSchema,
  MAX_STATEMENT_BYTES,
  MONEY_IPC,
  PersonInputSchema,
  SettleInputSchema,
  SplitInputSchema,
  StatementInputSchema,
  TransactionQuerySchema,
  type BillView,
  type CalendarOverlayItem,
  type ImportOutcome,
  type MoneyOverview,
  type MoneyResult,
  type StatementFile,
  type StatementPreview,
  type TransactionPage,
} from '@ordo/shared'
import { cachedInboxHeaders } from './mail'

let store: MoneyStore | null = null
const moneyStore = () => (store ??= new MoneyStore(join(app.getPath('userData'), 'money.sqlite')))

/** Rules decide for now; a local-model advisor plugs in here in a later milestone. */
const advisor: MatchAdvisor = noAdvisor

const ok: MoneyResult = { ok: true }
const fail = (message: string): MoneyResult => ({ ok: false, message })
const firstIssue = (e: { issues: { message: string }[] }) => e.issues[0]?.message ?? 'Check the details.'

// Statements

async function pickStatement(win: BrowserWindow | null): Promise<StatementFile | null> {
  const options: OpenDialogOptions = {
    title: 'Import a bank statement',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: [{ name: 'CSV statements', extensions: ['csv', 'txt'] }],
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const path = r.filePaths[0]
  if (r.canceled || !path) return null
  const fileName = basename(path)
  if ((await stat(path)).size > MAX_STATEMENT_BYTES)
    return { fileName, text: '', error: 'That file is too big to be a bank statement export.' }
  return { fileName, text: await readFile(path, 'utf8') }
}

/** `Monzo` for a recognised Monzo export, otherwise the file name (`joint-account.csv` → `Joint account`). */
function accountNameFor(layout: string | null, fileName: string): string {
  if (layout && layout !== 'CSV' && layout !== 'Custom') return layout
  const base = basename(fileName, extname(fileName)).replace(/[_-]+/g, ' ').trim().slice(0, 60)
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Bank account'
}

function previewStatement(raw: unknown): StatementPreview {
  const input = StatementInputSchema.parse(raw)
  const r = parseStatement(input.text, { accountName: 'preview', mapping: input.mapping })
  if (!r.ok) return { ...r, suggestedAccount: accountNameFor(null, input.fileName) }
  const dates = r.transactions.map((t) => t.date).sort()
  return {
    ok: true,
    layout: r.layout,
    suggestedAccount: accountNameFor(r.layout, input.fileName),
    mapping: r.mapping,
    headers: r.headers,
    count: r.transactions.length,
    skipped: r.skipped,
    from: dates[0]!,
    to: dates[dates.length - 1]!,
    sample: r.transactions.slice(0, 5),
  }
}

function importStatement(raw: unknown): ImportOutcome {
  const parsed = StatementInputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) }
  const input = parsed.data
  const detected = parseStatement(input.text, { accountName: 'preview', mapping: input.mapping })
  const accountName =
    input.accountName || accountNameFor(detected.ok ? detected.layout : null, input.fileName)
  const r = parseStatement(input.text, { accountName, mapping: input.mapping })
  if (!r.ok) return { ok: false, message: r.message }
  return { ok: true, accountName, ...moneyStore().addTransactions(r.transactions) }
}

function transactions(raw: unknown): TransactionPage {
  const q = TransactionQuerySchema.parse(raw ?? {})
  const s = moneyStore()
  const all = s.transactions()
  const inAccount = filterTransactions(all, { account: q.account })
  const shown = filterTransactions(inAccount, { month: q.month })
  return {
    transactions: shown,
    accounts: s.accounts(),
    months: [...new Set(inAccount.map((t) => monthOf(t.date)))],
    summary: summarise(shown),
  }
}

// Bills

/** Everything detected from statements and (if Mail is connected) cached email headers. */
async function detect(today: string) {
  const s = moneyStore()
  const txs = s.transactions()
  const headers = cachedInboxHeaders()
  const hints = headers ? emailHints(headers) : []
  const linked = linkBills(detectRecurring(txs, today), hints)
  const detected = applySuggestions(linked, await advisor.suggest(linked))
  return { txs, hints, detected, mailConnected: headers !== null }
}

async function current() {
  const today = toISODate()
  const s = moneyStore()
  const found = await detect(today)
  const stored = s.bills()
  const resolved = resolveBills({
    stored,
    detected: found.detected,
    hints: found.hints,
    dismissed: s.dismissed(),
    today,
  })
  // Keep saved bank bills at the latest price, so split charges keep matching payments.
  for (const b of resolved.bills) {
    const saved = stored.find((x) => x.id === b.id)
    if (saved && saved.amount !== b.amount) Object.assign(saved, s.saveBill({ ...saved, amount: b.amount }))
  }
  return { today, stored, ...found, ...resolved }
}

async function overview(): Promise<MoneyOverview> {
  const s = moneyStore()
  const c = await current()
  const splits = s.splits()
  const settlements = s.settlements()
  const { debts } = balances({ bills: c.stored, splits, transactions: c.txs, settlements, today: c.today })
  const bySplit = new Map(splits.map((x) => [x.billId, x]))
  const bills = c.bills.map((b): BillView => {
    const split = bySplit.get(b.id)
    return split ? { ...b, split, shares: allocate(b.amount, split) } : b
  })
  return {
    bills,
    review: c.review,
    people: s.people(),
    debts,
    settlements,
    monthlyTotal: c.bills
      .filter((b) => b.status === 'active')
      .reduce((n, b) => n + monthlyCost(b.amount, b.cadence), 0),
    hasTransactions: c.txs.length > 0,
    mailConnected: c.mailConnected,
  }
}

const DAY_MS = 86_400_000
const isDate = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime())

/** Bills, renewals and trial ends in `[start, end)` as Calendar overlay items. Amounts are GBP. */
async function dueDates(raw: unknown): Promise<CalendarOverlayItem[]> {
  const r = raw as { start?: unknown; end?: unknown } | null
  if (!isDate(r?.start) || !isDate(r?.end)) return []
  const { start, end } = r as { start: Date; end: Date }
  // The calendar asks for a month or a week at a time; refuse anything absurd.
  if (end <= start || end.getTime() - start.getTime() > 400 * DAY_MS) return []
  const { bills } = await current()
  const items = billsToCalendarItems(bills, {
    from: toISODate(start),
    to: toISODate(new Date(end.getTime() - 1)),
  })
  return items.map((i) => {
    const [y, m, d] = i.date.split('-').map(Number) as [number, number, number]
    return {
      id: `money:${i.id}`,
      date: new Date(y, m - 1, d),
      title: i.title,
      kind: i.kind,
      ...(i.amount !== undefined && { amount: { value: i.amount / 100, currency: 'GBP' } }),
    }
  })
}

async function confirmBill(raw: unknown): Promise<MoneyResult> {
  const parsed = ConfirmBillSchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const today = toISODate()
  const { detected } = await detect(today)
  const d: DetectedBill | undefined = detected.find((x) => x.key === parsed.data.key)
  if (!d) return fail('That suggestion is no longer there.')
  const amount = d.amount ?? parsed.data.amount
  if (amount === undefined) return fail('Enter how much this costs.')
  moneyStore().saveBill({
    name: d.name,
    amount,
    cadence: d.cadence,
    anchorDate: d.nextDue ?? parsed.data.nextDue ?? today,
    source: d.source,
    status: 'active',
    merchantKey: d.merchantKey,
  })
  return ok
}

function saveBill(raw: unknown): MoneyResult {
  const parsed = BillInputSchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const input = parsed.data
  const s = moneyStore()
  const today = toISODate()
  const existing = input.id ? s.bill(input.id) : undefined
  if (input.id && !existing) return fail('That bill no longer exists.')
  const status = input.status ?? existing?.status ?? 'active'
  const cancelledOn =
    status === 'cancelled' ? (existing?.status === 'cancelled' ? existing.cancelledOn : today) : undefined
  // Bank bills take their amount and dates from statements; only the name and status are editable.
  const fromBank = existing && (existing.source === 'bank' || existing.source === 'both')
  const bill: Omit<StoredBill, 'id'> & { id?: string } = {
    ...existing,
    id: existing?.id,
    name: input.name,
    amount: fromBank ? existing.amount : input.amount,
    cadence: fromBank ? existing.cadence : input.cadence,
    anchorDate: fromBank ? existing.anchorDate : input.nextDue,
    source: existing?.source ?? 'manual',
    status,
    ...(cancelledOn ? { cancelledOn } : { cancelledOn: undefined }),
  }
  s.saveBill(bill)
  return ok
}

// People, splits and settlements

function savePerson(raw: unknown): MoneyResult {
  const parsed = PersonInputSchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const s = moneyStore()
  const { id, name } = parsed.data
  if (s.people().some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase()))
    return fail(`You already have someone called ${name}.`)
  s.savePerson({ id, name })
  return ok
}

async function deletePerson(id: string): Promise<MoneyResult> {
  const s = moneyStore()
  const person = s.people().find((p) => p.id === id)
  if (!person) return ok
  if (id === ME) return fail("You can't remove yourself.")
  const bills = s.bills()
  const inSplit = s.splits().find((x) => x.paidBy === id || x.shares.some((sh) => sh.personId === id))
  if (inSplit) {
    const bill = bills.find((b) => b.id === inSplit.billId)
    return fail(
      `${person.name} is part of the split on ${bill?.name ?? 'a bill'}. Take them out of it first.`,
    )
  }
  const { net } = balances({
    bills,
    splits: s.splits(),
    transactions: s.transactions(),
    settlements: s.settlements(),
  })
  if (net.get(id)) return fail(`Settle up with ${person.name} first.`)
  s.deletePerson(id)
  return ok
}

async function saveSplit(raw: unknown): Promise<MoneyResult> {
  const parsed = SplitInputSchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const input = parsed.data
  const s = moneyStore()
  const c = await current()
  const bill = c.stored.find((b) => b.id === input.billId)
  const shown = c.bills.find((b) => b.id === input.billId)
  if (!bill || !shown) return fail('That bill no longer exists.')
  const error = validateSplit(input, shown.amount, s.people())
  if (error) return fail(error)
  const existing = s.splits().find((x) => x.billId === bill.id)
  s.saveSplit({ ...input, since: existing?.since ?? splitStartDate(bill, c.txs, c.today) })
  return ok
}

function settle(raw: unknown): MoneyResult {
  const parsed = SettleInputSchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const { from, to, amount, note } = parsed.data
  const ids = new Set(
    moneyStore()
      .people()
      .map((p) => p.id),
  )
  if (from === to || !ids.has(from) || !ids.has(to)) return fail('Choose two different people.')
  moneyStore().addSettlement({ from, to, amount, date: toISODate(), ...(note && { note }) })
  return ok
}

/** Register every Money IPC handler. Arguments from the renderer are validated with zod here. */
export function registerMoneyIpc(): void {
  ipcMain.handle(MONEY_IPC.pickStatement, (e) => pickStatement(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(MONEY_IPC.previewStatement, (_e, input: unknown) => previewStatement(input))
  ipcMain.handle(MONEY_IPC.importStatement, (_e, input: unknown) => importStatement(input))
  ipcMain.handle(MONEY_IPC.transactions, (_e, query: unknown) => transactions(query))
  ipcMain.handle(MONEY_IPC.removeAccount, (_e, name: unknown) => moneyStore().removeAccount(String(name)))
  ipcMain.handle(MONEY_IPC.overview, () => overview())
  ipcMain.handle(MONEY_IPC.confirmBill, (_e, input: unknown) => confirmBill(input))
  ipcMain.handle(MONEY_IPC.dismissBill, (_e, key: unknown) => moneyStore().dismiss(String(key)))
  ipcMain.handle(MONEY_IPC.saveBill, (_e, input: unknown) => saveBill(input))
  ipcMain.handle(MONEY_IPC.deleteBill, (_e, id: unknown) => moneyStore().deleteBill(String(id)))
  ipcMain.handle(MONEY_IPC.savePerson, (_e, input: unknown) => savePerson(input))
  ipcMain.handle(MONEY_IPC.deletePerson, (_e, id: unknown) => deletePerson(String(id)))
  ipcMain.handle(MONEY_IPC.saveSplit, (_e, input: unknown) => saveSplit(input))
  ipcMain.handle(MONEY_IPC.deleteSplit, (_e, billId: unknown) => moneyStore().deleteSplit(String(billId)))
  ipcMain.handle(MONEY_IPC.settle, (_e, input: unknown) => settle(input))
  ipcMain.handle(MONEY_IPC.dueDates, (_e, range: unknown) => dueDates(range))
  ipcMain.handle(MONEY_IPC.deleteSettlement, (_e, id: unknown) => moneyStore().deleteSettlement(String(id)))
}

export function closeMoney(): void {
  store?.close()
  store = null
}
