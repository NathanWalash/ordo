import type { Category, SenderSummary } from './types'

const RECEIPT =
  /\b(receipt|invoice|order|payment|paid|statement|booking|reservation|confirmation|confirmed|refund|subscription renewal|your bill)\b/i
const PROMO =
  /(\d+\s?% off|\bsale\b|\bdeals?\b|\boffers?\b|\bdiscount|\bfree (shipping|delivery)\b|\blast chance\b|\blimited time\b|\bends (today|tonight|soon)\b|\bshop now\b|\bnew arrivals\b|\bcoupon\b|\bvoucher\b)/i

const share = (subjects: string[], re: RegExp) =>
  subjects.length ? subjects.filter((s) => re.test(s)).length / subjects.length : 0

/**
 * Sort a sender with cheap, explainable rules. Returns `uncategorised` when the
 * rules aren't confident; a model can take those later.
 *
 * Anyone you've written to is a person, whatever else their mail looks like, so
 * bulk actions can never reach them.
 */
export function categorise(sender: SenderSummary, repliedTo: ReadonlySet<string>): Category {
  if (repliedTo.has(sender.address)) return 'people'
  const subjects = sender.sampleSubjects
  if (share(subjects, RECEIPT) >= 0.5) return 'receipts'
  if (sender.bulk && share(subjects, PROMO) >= 0.3) return 'promotions'
  if (sender.bulk) return 'newsletters'
  if (sender.automated) return 'notifications'
  return 'uncategorised'
}
