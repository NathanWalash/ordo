export * from './types'
export {
  parseUnsubscribe,
  parseMailto,
  isSecureUrl,
  unsubscribeRank,
  type MailtoMessage,
  type UnsubscribeParseOptions,
} from './unsubscribe'
export {
  executeUnsubscribe,
  ONE_CLICK_BODY,
  type FetchLike,
  type UnsubscribeDeps,
  type UnsubscribeOutcome,
  type UnsubscribeRequestOptions,
  type UnsubscribeStatus,
} from './unsubscribe-run'
export {
  buildCleanupPlan,
  type CleanupPlan,
  type CleanupRequestItem,
  type PlannedSender,
} from './cleanup-plan'
export { groupBySender, isAutomated, isBulk } from './senders'
export { categorise } from './rules'
export { analyseSenders, type CategorisedSender } from './analyse'
export { parseHeaderBlock, toMessageHeader, SCAN_HEADER_FIELDS, type RawFetchedMessage } from './headers'
