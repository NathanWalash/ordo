import type { CalendarOverlayItem, DateRange } from './calendar'
import { z } from 'zod'
import {
  SPENDING_CATEGORIES,
  isISODate,
  type Allocation,
  type Bill,
  type ColumnMapping,
  type Debt,
  type DetectedBill,
  type Person,
  type Settlement,
  type SpendingTrends,
  type Split,
  type Transaction,
  type TransactionSummary,
  type UsualComparison,
} from '@ordo/money-core'

export type {
  Allocation,
  Bill,
  ColumnMapping,
  Debt,
  DetectedBill,
  Person,
  Settlement,
  Split,
  Transaction,
  TransactionSummary,
}

/** IPC channels for the Money module. */
export const MONEY_IPC = {
  pickStatement: 'money:pick-statement',
  previewStatement: 'money:preview-statement',
  importStatement: 'money:import-statement',
  transactions: 'money:transactions',
  removeAccount: 'money:remove-account',
  overview: 'money:overview',
  confirmBill: 'money:confirm-bill',
  dismissBill: 'money:dismiss-bill',
  saveBill: 'money:save-bill',
  deleteBill: 'money:delete-bill',
  savePerson: 'money:save-person',
  deletePerson: 'money:delete-person',
  saveSplit: 'money:save-split',
  deleteSplit: 'money:delete-split',
  settle: 'money:settle',
  deleteSettlement: 'money:delete-settlement',
  dueDates: 'money:due-dates',
  setCategory: 'money:set-category',
  aiSort: 'money:ai-sort',
  aiStop: 'money:ai-stop',
  aiProgress: 'money:ai-progress',
} as const

/** Statements bigger than this are almost certainly not a CSV export. */
export const MAX_STATEMENT_BYTES = 20 * 1024 * 1024

const isoDate = z.string().refine(isISODate, 'Choose a date.')
const pence = z.number().int().min(0).max(100_000_000_00)
const id = z.string().min(1).max(100)
const column = z.number().int().min(0).max(500)

export const ColumnMappingSchema = z.object({
  headerRow: z.number().int().min(-1).max(50),
  date: column,
  description: column,
  amount: column.optional(),
  debit: column.optional(),
  credit: column.optional(),
  balance: column.optional(),
  category: column.optional(),
  dateOrder: z.enum(['dmy', 'mdy']).optional(),
}) satisfies z.ZodType<ColumnMapping>

export const StatementInputSchema = z.object({
  fileName: z.string().max(500),
  text: z.string().max(MAX_STATEMENT_BYTES),
  accountName: z.string().trim().max(60).optional(),
  mapping: ColumnMappingSchema.optional(),
})
export type StatementInput = z.input<typeof StatementInputSchema>

export interface StatementFile {
  fileName: string
  text: string
  /** Set when the file couldn't be read (too big, say). */
  error?: string
}

export type StatementPreview =
  | {
      ok: true
      layout: string
      suggestedAccount: string
      mapping: ColumnMapping
      headers: string[]
      count: number
      skipped: number
      from: string
      to: string
      /** The first few transactions, to check the columns look right. */
      sample: Transaction[]
    }
  | {
      ok: false
      error: 'empty' | 'unrecognised' | 'no-rows'
      message: string
      suggestedAccount: string
      sample: string[][]
      suggested: ColumnMapping
    }

export type ImportOutcome =
  | { ok: true; accountName: string; added: number; duplicates: number }
  /** `locked`: another Ordo process (the app, a headless command or an agent) is writing. */
  | { ok: false; message: string; error?: 'locked' }

export const TransactionQuerySchema = z.object({
  account: z.string().max(60).optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
})
export type TransactionQuery = z.input<typeof TransactionQuerySchema>

export interface TransactionPage {
  transactions: Transaction[]
  /** Every imported account, for the filter. */
  accounts: string[]
  /** Every month with transactions (`YYYY-MM`), newest first, for the filter. */
  months: string[]
  summary: TransactionSummary
  /** Merchants (in any account or month) still in Other that a model could categorise. */
  uncategorisedMerchants: number
  /**
   * For the charts: every month of the account filter (whatever the month filter), and the chosen
   * month (or the latest) against the usual month. Optional so older callers and fakes still fit.
   */
  charts?: { trends: SpendingTrends; usual: UsualComparison | null }
}

/** Your own category for a transaction; null goes back to the bank's, the rules' or AI's. */
export const SetCategorySchema = z.object({
  transactionId: id,
  category: z.enum(SPENDING_CATEGORIES).nullable(),
})
export type SetCategoryInput = z.input<typeof SetCategorySchema>

/** Progress of Sort with AI on Finances: categories first, then matching bills to email. */
export interface MoneyAiProgress {
  phase: 'categories' | 'bills'
  done: number
  total: number
}

export type MoneyAiOutcome =
  | {
      ok: true
      /** Merchants that needed a category. */
      merchants: number
      /** Merchants answered by the model or from earlier answers. */
      checked: number
      /** Merchants moved out of Other. */
      changed: number
      cached: number
      failed: number
      /** Bank and email pairs the rules couldn't link, and how many the model matched. */
      billPairs: number
      billsMatched: number
      /** Fixed, Ordo-written messages; never text from a model. */
      errors: string[]
    }
  /** `locked`: another Ordo process is writing. */
  | { ok: false; message: string; error?: 'locked' }

/** A bill plus its split and each person's share of the current amount. */
export type BillView = Bill & { split?: Split; shares?: Allocation[] }

export interface MoneyOverview {
  bills: BillView[]
  /** Detected from statements and email, waiting to be confirmed or dismissed. */
  review: DetectedBill[]
  people: Person[]
  /** Who owes whom, simplified. */
  debts: Debt[]
  settlements: Settlement[]
  /** Active bills as a monthly cost, in pence. */
  monthlyTotal: number
  hasTransactions: boolean
  mailConnected: boolean
}

export const BillInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'Give the bill a name.').max(80),
  amount: pence,
  cadence: z.enum(['weekly', 'monthly', 'yearly']),
  nextDue: isoDate,
  status: z.enum(['active', 'cancelled']).optional(),
})
export type BillInput = z.input<typeof BillInputSchema>

export const ConfirmBillSchema = z.object({
  key: z.string().min(1).max(200),
  /** Needed when only email found the bill, so the amount and due date are unknown. */
  amount: pence.optional(),
  nextDue: isoDate.optional(),
  /** False to save the bill without the split Ordo suggested from what you taught it. */
  withSplit: z.boolean().optional(),
})
export type ConfirmBillInput = z.input<typeof ConfirmBillSchema>

export const PersonInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'Enter a name.').max(40, 'That name is too long.'),
})
export type PersonInput = z.input<typeof PersonInputSchema>

export const SplitInputSchema = z.object({
  billId: id,
  paidBy: id,
  mode: z.enum(['equal', 'fixed', 'percent']),
  shares: z.array(z.object({ personId: id, value: z.number().int().min(0) })).max(50),
})
export type SplitInput = z.input<typeof SplitInputSchema>

export const SettleInputSchema = z.object({
  from: id,
  to: id,
  amount: pence.refine((n) => n > 0, 'Enter an amount.'),
  note: z.string().trim().max(200).optional(),
})
export type SettleInput = z.input<typeof SettleInputSchema>

export type MoneyResult = { ok: true } | { ok: false; message: string }

/** `window.ordo.money`. Every call runs in the main process; data stays in `money.sqlite`. */
export interface MoneyApi {
  /** Show the native open dialog and read the chosen CSV. Null when cancelled. */
  pickStatement(): Promise<StatementFile | null>
  /** Parse without saving, to show what will be imported (or ask for a column mapping). */
  previewStatement(input: StatementInput): Promise<StatementPreview>
  importStatement(input: StatementInput): Promise<ImportOutcome>
  transactions(query?: TransactionQuery): Promise<TransactionPage>
  removeAccount(name: string): Promise<void>
  overview(): Promise<MoneyOverview>
  confirmBill(input: ConfirmBillInput): Promise<MoneyResult>
  dismissBill(key: string): Promise<void>
  saveBill(input: BillInput): Promise<MoneyResult>
  deleteBill(id: string): Promise<void>
  savePerson(input: PersonInput): Promise<MoneyResult>
  deletePerson(id: string): Promise<MoneyResult>
  saveSplit(input: SplitInput): Promise<MoneyResult>
  deleteSplit(billId: string): Promise<void>
  settle(input: SettleInput): Promise<MoneyResult>
  deleteSettlement(id: string): Promise<void>
  /** Active bills' due dates, renewals and trial ends in `range`, for the Calendar. */
  dueDates(range: DateRange): Promise<CalendarOverlayItem[]>
  /** Choose a transaction's category yourself (null to undo). Wins over the bank, rules and AI. */
  setCategory(input: SetCategoryInput): Promise<MoneyResult>
  /**
   * Sort with AI: ask the model chosen in Settings → AI to categorise merchants in Other, then to
   * match bank payments to email senders the rules couldn't. Needs AI for Money turned on.
   */
  aiSort(): Promise<MoneyAiOutcome>
  aiStop(): Promise<void>
  /** Subscribe to Sort with AI progress; returns an unsubscribe function. */
  onAiProgress(listener: (p: MoneyAiProgress) => void): () => void
}
