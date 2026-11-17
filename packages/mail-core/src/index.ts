export * from './types'
export { parseUnsubscribe } from './unsubscribe'
export { groupBySender, isAutomated, isBulk } from './senders'
export { categorise } from './rules'
export { analyseSenders, type CategorisedSender } from './analyse'
export {
  aiCategorise,
  AI_CATEGORIES,
  type AiCategory,
  type AiCategoryCache,
  type AiCategoryRecord,
  type AiSortedSender,
  type AiSortOptions,
  type AiSortProgress,
  type AiSortResult,
} from './ai-sort'
export { parseHeaderBlock, toMessageHeader, SCAN_HEADER_FIELDS, type RawFetchedMessage } from './headers'
