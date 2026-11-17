import { categorise } from './rules'
import { groupBySender } from './senders'
import type { Category, MessageHeader, SenderSummary } from './types'
import type { UnsubscribeParseOptions } from './unsubscribe'

export interface CategorisedSender extends SenderSummary {
  category: Category
}

/** Group headers by sender and sort each sender into a category. */
export function analyseSenders(
  headers: Iterable<MessageHeader>,
  repliedTo: ReadonlySet<string>,
  unsubscribeOptions: UnsubscribeParseOptions = {},
): CategorisedSender[] {
  return groupBySender(headers, 5, unsubscribeOptions).map((s) => ({
    ...s,
    category: categorise(s, repliedTo),
  }))
}
