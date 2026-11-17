import { categorise } from './rules'
import { groupBySender } from './senders'
import type { Category, MessageHeader, SenderSummary } from './types'

export interface CategorisedSender extends SenderSummary {
  category: Category
}

/** Group headers by sender and sort each sender into a category. */
export function analyseSenders(
  headers: Iterable<MessageHeader>,
  repliedTo: ReadonlySet<string>,
): CategorisedSender[] {
  return groupBySender(headers).map((s) => ({ ...s, category: categorise(s, repliedTo) }))
}
