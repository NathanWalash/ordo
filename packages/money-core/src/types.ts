import type { Cadence, ISODate } from './dates'

export type { Cadence, ISODate }

/** One line of a bank statement. Amounts are pence: negative is money out. */
export interface Transaction {
  /** Stable hash of account, date, amount and description, so re-imports de-duplicate. */
  id: string
  accountName: string
  date: ISODate
  description: string
  amount: number
  category?: string
  /** Cleaned-up merchant name, e.g. `Netflix` for `CARD PAYMENT TO NETFLIX.COM ON 03-11`. */
  merchant?: string
}

/** A run of similar payments to the same merchant on a regular schedule. */
export interface RecurringCandidate {
  /** Unique: the merchant key, plus the amount when one merchant has several. */
  id: string
  merchant: string
  /** Normalised merchant key used for matching (`netflix`). */
  key: string
  cadence: Cadence
  /** The latest amount paid, in pence (positive). */
  typicalAmount: number
  lastDate: ISODate
  nextDue: ISODate
  /** 0 to 1: how regular the dates and amounts are, and how many payments back it up. */
  confidence: number
  transactionIds: string[]
  /** Set when the latest payment is higher than the one before. */
  priceIncrease?: { from: number; to: number; date: ISODate }
}

export type EmailHintKind = 'receipt' | 'renewal' | 'trial-ending' | 'price-change'

/** A subscription signal read from email headers (sender and subject only). */
export interface EmailHint {
  merchant: string
  /** Sender's domain, e.g. `netflix.com`. */
  domain: string
  kind: EmailHintKind
  lastSeen: ISODate
  /** How many emails of this kind came from this merchant. */
  count: number
  /** Subject of the latest one, for showing the reason. */
  subject: string
}

export type BillSource = 'bank' | 'email' | 'both' | 'manual'
export type BillStatus = 'active' | 'cancelled'

/** A bill or subscription as shown in the app. */
export interface Bill {
  id: string
  name: string
  /** Pence per cycle. */
  amount: number
  cadence: Cadence
  nextDue: ISODate
  source: BillSource
  status: BillStatus
  /** Normalised merchant key, for matching bank payments and emails. */
  merchantKey?: string
  lastPaid?: ISODate
  priceIncrease?: { from: number; to: number; date: ISODate }
  /** Date of an email saying a free trial is ending. */
  trialEnding?: ISODate
  /** Date of an email about a price change. */
  priceChangeEmail?: ISODate
}

/** A bill as saved: the due date is an anchor that rolls forward with time. */
export interface StoredBill {
  id: string
  name: string
  amount: number
  cadence: Cadence
  /** Any one due date; the next one is worked out from it. */
  anchorDate: ISODate
  source: BillSource
  status: BillStatus
  merchantKey?: string
  /** When the bill was marked cancelled; split charges stop after this. */
  cancelledOn?: ISODate
}

/** A recurring payment found in statements and/or email, waiting for the person to confirm or dismiss. */
export interface DetectedBill {
  /** Unique id (the candidate id); also what a dismissal remembers. */
  key: string
  merchantKey: string
  name: string
  /** Null when only email mentions it, so the amount is unknown. */
  amount: number | null
  cadence: Cadence
  nextDue: ISODate | null
  lastPaid?: ISODate
  source: 'bank' | 'email' | 'both'
  confidence: number
  transactionIds: string[]
  hints: EmailHint[]
  priceIncrease?: { from: number; to: number; date: ISODate }
}

/** Someone you split bills with. "Me" always exists with id `me`. */
export interface Person {
  id: string
  name: string
}

export const ME = 'me'

export type SplitMode = 'equal' | 'fixed' | 'percent'

export interface SplitShare {
  personId: string
  /** Ignored for `equal`; pence for `fixed`; basis points (100% = 10000) for `percent`. */
  value: number
}

/** Who pays a bill and how it's shared. */
export interface Split {
  billId: string
  paidBy: string
  mode: SplitMode
  shares: SplitShare[]
  /** First cycle the split applies to. */
  since: ISODate
}

export interface Allocation {
  personId: string
  amount: number
}

/** One cycle of a split bill: who paid, and what each person's share was. */
export interface Charge {
  billId: string
  date: ISODate
  amount: number
  paidBy: string
  shares: Allocation[]
  transactionId?: string
}

/** Money paid between people to settle up: `from` paid `to`. */
export interface Settlement {
  id: string
  from: string
  to: string
  amount: number
  date: ISODate
  note?: string
}

/** `from` owes `to` this many pence. */
export interface Debt {
  from: string
  to: string
  amount: number
}
