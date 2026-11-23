import { open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import {
  ME,
  aiCategoriseTransactions,
  buildLedger,
  heldSettlements,
  withMemoryBills,
  type Settlement,
  type Split,
  type SuggestedSplit,
  aiMatchBills,
  allocate,
  applyCategoryOverrides,
  applySuggestions,
  cachedMatchAdvisor,
  decodeStatement,
  merchantsNeedingCategory,
  balances,
  billsToCalendarItems,
  detectRecurring,
  emailHints,
  filterTransactions,
  linkBills,
  monthlyCost,
  monthOf,
  pairOwnTransfers,
  noAdvisor,
  parseStatement,
  resolveBills,
  splitStartDate,
  compareWithUsual,
  spendingTrends,
  summarise,
  toISODate,
  validateSplit,
  type DetectedBill,
  type MatchAdvisor,
  type StoredBill,
  type Transaction,
} from '@ordo/money-core'
import { MoneyStore } from '@ordo/money-core/node'
import {
  BillInputSchema,
  ConfirmBillSchema,
  MAX_STATEMENT_BYTES,
  MONEY_IPC,
  PersonInputSchema,
  SetCategorySchema,
  SettleInputSchema,
  SplitInputSchema,
  StatementInputSchema,
  TransactionQuerySchema,
  type BillView,
  type CalendarOverlayItem,
  type ImportOutcome,
  type MoneyAiOutcome,
  type MoneyAiProgress,
  type MoneyOverview,
  type MoneyResult,
  type StatementFile,
  type StatementInput,
  type StatementPreview,
  type TransactionPage,
} from '@ordo/shared'
import { aiSettings, message as aiMessage, resolveModel, usableProvider } from './ai'
import { cachedInboxHeaders } from './mail'
import { pathProblem } from './paths'
import { Locked, toRenderer, withWriteLock } from './writes'

let store: MoneyStore | null = null
export const moneyStore = () => (store ??= new MoneyStore(join(app.getPath('userData'), 'money.sqlite')))

/**
 * The model whose earlier answers apply to Money right now: AI for Money is on, the provider may
 * be used (cloud consent) and its model is known. Null otherwise, and then rules alone decide.
 */
async function moneyAi() {
  const ai = aiSettings()
  if (!ai.money) return null
  const provider = usableProvider(ai)
  if (!provider) return null
  try {
    return { provider, model: await resolveModel(ai) }
  } catch {
    return null
  }
}

/**
 * Transactions with your own category choices on top, then earlier AI answers from the cache.
 * Never asks a model; if anything goes wrong it falls back to the bank's and the rules' categories.
 */
async function categorised(txs: Transaction[]): Promise<Transaction[]> {
  const s = moneyStore()
  const mine = applyCategoryOverrides(txs, s.categoryOverrides())
  const ai = await moneyAi()
  if (!ai) return mine
  try {
    const r = await aiCategoriseTransactions(mine, ai.provider, {
      model: ai.model,
      cache: s,
      cacheOnly: true,
    })
    return r.transactions
  } catch {
    return mine
  }
}

/** Earlier AI bill matches from the cache when AI for Money is on; rules alone otherwise. */
async function advisor(): Promise<MatchAdvisor> {
  const ai = await moneyAi()
  return ai ? cachedMatchAdvisor(ai.provider, { model: ai.model, cache: moneyStore() }) : noAdvisor
}

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
  try {
    return { fileName, text: decodeStatement(await readFile(path)) }
  } catch {
    return { fileName, text: '', error: UNREADABLE }
  }
}

const UNREADABLE =
  'Ordo couldn’t read that file. Check you have permission to open it and that no other program is using it.'

/** Headless imports read a file named on the command line: a CSV export, never anything big. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024

type StatementRead = { ok: true; fileName: string; text: string } | { ok: false; message: string }

/**
 * Read a statement named by a path (headless mode and the assistant). The path must be local and
 * resolve to a regular `.csv` file under 5 MB.
 */
async function readStatementFile(path: string): Promise<StatementRead> {
  // Before any file-system call: a UNC or device path could reach the network or a device.
  const problem = pathProblem(path, { requireAbsolute: false })
  if (problem) return { ok: false, message: problem }
  let real: string
  try {
    real = await realpath(resolve(path))
  } catch {
    return { ok: false, message: 'That file doesn’t exist.' }
  }
  if (extname(real).toLowerCase() !== '.csv')
    return { ok: false, message: 'Choose a .csv bank statement export.' }
  // Check before opening: opening a FIFO or device could block or never end.
  if (!(await stat(real)).isFile()) return { ok: false, message: 'That isn’t a regular file.' }
  const tooBig = {
    ok: false,
    message: 'That file is too big to be a bank statement export (over 5 MB).',
  } as const
  let bytes: Buffer
  try {
    const file = await open(real, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile()) return { ok: false, message: 'That isn’t a regular file.' }
      if (info.size > MAX_IMPORT_FILE_BYTES) return tooBig
      bytes = await file.readFile()
    } finally {
      await file.close()
    }
  } catch {
    // No permission, or another program has it locked (EACCES, EPERM, EBUSY on Windows).
    return { ok: false, message: UNREADABLE }
  }
  if (bytes.length > MAX_IMPORT_FILE_BYTES) return tooBig
  return { ok: true, fileName: basename(real), text: decodeStatement(bytes) }
}

/**
 * Import a statement from a path (headless mode and the assistant). It is then parsed and saved
 * exactly like a file picked in the app.
 */
export async function importStatementFile(path: string, accountName?: string): Promise<ImportOutcome> {
  const read = await readStatementFile(path)
  if (!read.ok) return read
  return importStatement({ fileName: read.fileName, text: read.text, accountName })
}

/** Every imported transaction as stored, newest first: no categorising, for linking from Boards. */
export function storedTransactions(): Transaction[] {
  return moneyStore().transactions()
}

/** How much is stored, for `status`. */
export function counts(): { transactions: number; accounts: number; bills: number } {
  const s = moneyStore()
  return { transactions: s.transactions().length, accounts: s.accounts().length, bills: s.bills().length }
}

/** `Monzo` for a recognised Monzo export, otherwise the file name (`joint-account.csv` → `Joint account`). */
function accountNameFor(layout: string | null, fileName: string): string {
  if (layout && layout !== 'CSV' && layout !== 'Custom') return layout
  const base = basename(fileName, extname(fileName)).replace(/[_-]+/g, ' ').trim().slice(0, 60)
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Bank account'
}

export function previewStatement(raw: unknown): StatementPreview {
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

/** Save a statement's transactions. Re-imported transactions are skipped. */
export async function importStatement(raw: unknown): Promise<ImportOutcome> {
  const parsed = StatementInputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) }
  const result = await withWriteLock('importing a statement', async () => saveStatement(parsed.data))
  return result instanceof Locked ? { ok: false, error: 'locked', message: result.message } : result
}

function saveStatement(input: StatementInput): ImportOutcome {
  const detected = parseStatement(input.text, { accountName: 'preview', mapping: input.mapping })
  const accountName =
    input.accountName || accountNameFor(detected.ok ? detected.layout : null, input.fileName)
  const r = parseStatement(input.text, { accountName, mapping: input.mapping })
  if (!r.ok) return { ok: false, message: r.message }
  return { ok: true, accountName, ...moneyStore().addTransactions(r.transactions) }
}

/** Every transaction as Finances shows it: your categories, AI's, and transfers between your accounts paired. */
export async function allTransactions(): Promise<Transaction[]> {
  return pairOwnTransfers(await categorised(moneyStore().transactions()))
}

export async function transactions(raw: unknown): Promise<TransactionPage> {
  const q = TransactionQuerySchema.parse(raw ?? {})
  const s = moneyStore()
  const all = await allTransactions()
  const inAccount = filterTransactions(all, { account: q.account })
  const shown = filterTransactions(inAccount, { month: q.month })
  const months = [...new Set(inAccount.map((t) => monthOf(t.date)))]
  const latest = months.reduce<string | undefined>((a, m) => (!a || m > a ? m : a), undefined)
  const trendOpts = { excludeOwnTransfers: !q.account, today: toISODate() }
  return {
    transactions: shown,
    accounts: s.accounts(),
    months,
    // Viewing one account, a transfer out of it is still money out of that account.
    summary: summarise(shown, { excludeOwnTransfers: !q.account }),
    uncategorisedMerchants: merchantsNeedingCategory(all),
    charts: {
      trends: spendingTrends(inAccount, trendOpts),
      usual: latest ? compareWithUsual(inAccount, q.month ?? latest, trendOpts) : null,
    },
  }
}

/** Choose a transaction's category yourself, or (null) go back to the automatic one. */
function setCategory(raw: unknown): MoneyResult {
  const parsed = SetCategorySchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const { transactionId, category } = parsed.data
  return moneyStore().setCategoryOverride(transactionId, category)
    ? ok
    : fail('That transaction is no longer there.')
}

// Sort with AI

let aiRunning: AbortController | null = null

/**
 * Ask the model chosen in Settings → AI to categorise the merchants left in Other, then to match
 * bank payments to email senders the rules couldn't link. Same provider, model, cloud-consent
 * checks and write lock as sorting senders. Answers are cached; listing applies them without
 * asking again. A match only ever becomes a suggestion in Bills → Detected.
 */
export async function aiSort(onProgress?: (p: MoneyAiProgress) => void): Promise<MoneyAiOutcome> {
  const ai = aiSettings()
  if (ai.provider === 'none') return { ok: false, message: 'Choose a model in Settings → AI first.' }
  if (!ai.money) return { ok: false, message: 'Turn on AI for Money in Settings → AI first.' }
  const provider = usableProvider(ai)
  if (!provider) return { ok: false, message: 'Confirm that Ordo may use this provider first.' }
  if (aiRunning) return { ok: false, message: 'Sorting is already running.' }

  const ctrl = (aiRunning = new AbortController())
  try {
    const result = await withWriteLock('sorting money with AI', async () => {
      const s = moneyStore()
      const common = {
        model: await resolveModel(ai),
        cache: s,
        // A local model answers one request at a time anyway.
        concurrency: provider.kind === 'local' ? 1 : 2,
        timeoutMs: 180_000,
        signal: ctrl.signal,
      }
      const txs = s.transactions()
      const categories = await aiCategoriseTransactions(
        applyCategoryOverrides(txs, s.categoryOverrides()),
        provider,
        { ...common, onProgress: (p) => onProgress?.({ phase: 'categories', ...p }) },
      )
      const { hints, linked } = billEvidence(txs, toISODate())
      const bills = hints.length
        ? await aiMatchBills(linked, hints, provider, {
            ...common,
            onProgress: (p) => onProgress?.({ phase: 'bills', ...p }),
          })
        : null
      return { categories, bills }
    })
    if (result instanceof Locked) return { ok: false, error: 'locked', message: result.message }
    const { categories: c, bills: b } = result
    return {
      ok: true,
      merchants: c.merchants,
      checked: c.checked,
      changed: c.changed,
      cached: c.cached,
      failed: c.failed,
      billPairs: b?.pairs ?? 0,
      billsMatched: b?.matched ?? 0,
      errors: [...c.errors, ...(b?.errors ?? [])],
    }
  } catch (err) {
    return { ok: false, message: aiMessage(err) }
  } finally {
    aiRunning = null
  }
}

export function stopAiSort(): void {
  aiRunning?.abort()
}

// Bills

/** Recurring payments joined to email hints by the rules alone. */
function billEvidence(txs: Transaction[], today: string) {
  const headers = cachedInboxHeaders()
  const hints = headers ? emailHints(headers) : []
  return { headers, hints, linked: linkBills(detectRecurring(txs, today), hints) }
}

/**
 * Everything detected from statements and (if Mail is connected) cached email headers, plus any
 * earlier AI matches for what the rules couldn't link.
 */
async function detect(today: string) {
  const txs = moneyStore().transactions()
  const { headers, hints, linked } = billEvidence(txs, today)
  const suggestions = await (await advisor()).suggest(linked, hints).catch(() => [])
  const detected = learnedBills(applySuggestions(linked, hints, suggestions), txs, today)
  return { txs, hints, detected, mailConnected: headers !== null }
}

/**
 * Money a flatmate paid you that you hold for a shared bill's payee counts as their share being
 * paid (not shown as settlements you can delete). Never fails the overview.
 */
function heldPayments(txs: Transaction[], bills: StoredBill[], splits: Split[]): Settlement[] {
  try {
    const s = moneyStore()
    const facts = s.memoryFacts()
    if (!facts.some((f) => f.kind === 'held')) return []
    const paired = pairOwnTransfers(txs)
    return heldSettlements({
      transactions: paired,
      ledger: buildLedger(paired, facts),
      facts,
      people: s.people(),
      bills,
      splits,
    })
  } catch {
    return []
  }
}

/** Add what you taught Ordo: shared bills and splits it can now suggest. Never fails detection. */
function learnedBills(detected: DetectedBill[], txs: Transaction[], today: string): DetectedBill[] {
  try {
    const facts = moneyStore().memoryFacts()
    if (!facts.length) return detected
    const paired = pairOwnTransfers(txs)
    return withMemoryBills(detected, paired, buildLedger(paired, facts), facts, today)
  } catch {
    return detected
  }
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

export async function overview(): Promise<MoneyOverview> {
  const s = moneyStore()
  const c = await current()
  const splits = s.splits()
  const settlements = s.settlements()
  const { debts } = balances({
    bills: c.stored,
    splits,
    transactions: c.txs,
    settlements: [...settlements, ...heldPayments(c.txs, c.stored, splits)],
    today: c.today,
  })
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
export async function dueDates(raw: unknown): Promise<CalendarOverlayItem[]> {
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
  const s = moneyStore()
  const bill = s.saveBill({
    name: d.name,
    amount,
    cadence: d.cadence,
    anchorDate: d.nextDue ?? parsed.data.nextDue ?? today,
    source: d.source,
    status: 'active',
    merchantKey: d.merchantKey,
  })
  if (d.suggestedSplit && parsed.data.withSplit !== false) saveSuggestedSplit(bill, d.suggestedSplit, today)
  return ok
}

/**
 * Save the split Ordo suggested from what you taught it: fixed amounts, paid by you. People it
 * names are added to Bills if they aren't there yet. Skipped if the shares don't fit the bill.
 */
function saveSuggestedSplit(bill: StoredBill, suggested: SuggestedSplit, today: string): void {
  const s = moneyStore()
  const shares = suggested.shares.map((x) => ({
    personId: x.name === 'Me' ? ME : ensurePerson(x.name).id,
    value: x.amount,
  }))
  const split = { billId: bill.id, paidBy: ME, mode: 'fixed' as const, shares }
  if (validateSplit(split, bill.amount, s.people())) return
  s.saveSplit({ ...split, since: splitStartDate(bill, s.transactions(), today) })
}

/** Find someone on Bills by name, or add them. */
export function ensurePerson(name: string) {
  const s = moneyStore()
  const clean = name.trim().slice(0, 40)
  return s.people().find((p) => p.name.toLowerCase() === clean.toLowerCase()) ?? s.savePerson({ name: clean })
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
  ipcMain.handle(MONEY_IPC.setCategory, (_e, input: unknown) => setCategory(input))
  ipcMain.handle(MONEY_IPC.aiSort, (e) => aiSort(toRenderer(e.sender, MONEY_IPC.aiProgress)))
  ipcMain.handle(MONEY_IPC.aiStop, () => stopAiSort())
}

export function closeMoney(): void {
  stopAiSort()
  store?.close()
  store = null
}
