// Pure parts of boards-core: safe to import anywhere, including the renderer.
export * from './types'
export { addDays, daysBetween, fromISODate, isISODate, toISODate } from './dates'
export {
  MAX_RANK_LENGTH,
  RANK_DIGITS,
  evenRanks,
  isRank,
  planMove,
  rankAfter,
  rankBetween,
  sortByRank,
  type MovePlan,
  type Ranked,
} from './rank'
export {
  FIELD_TYPE_LABELS,
  MAX_PERSON_FIELD,
  MAX_TEXT_FIELD,
  MAX_URL_FIELD,
  fieldText,
  normaliseFieldValue,
  safeUrl,
  type FieldCheck,
} from './fields'
export { TEMPLATES, template, type BoardTemplate, type TemplateField } from './templates'
export { MAX_NOTES, parseInline, parseMarkdown, plainText, type Block, type Inline } from './markdown'
export {
  DUE_FILTERS,
  dueState,
  filterCards,
  isFiltering,
  matchesFilter,
  searchText,
  type CardFilter,
  type DueFilter,
  type DueState,
  type FilterContext,
} from './filter'
export {
  billCandidate,
  cardCandidate,
  emailCandidate,
  eventCandidate,
  keywords,
  occurrenceStart,
  pounds,
  relevance,
  resolveLinks,
  searchCandidates,
  targetKey,
  toCandidates,
  transactionCandidate,
  type BillSource,
  type CardSource,
  type EmailSource,
  type EventSource,
  type LinkSources,
  type TransactionSource,
} from './links'
export { cardsToCalendarItems, type CardCalendarItem } from './calendar'
export {
  SUGGEST_JSON_SCHEMA,
  SUGGEST_LIMITS,
  SUGGEST_SYSTEM_PROMPT,
  SuggestReplySchema,
  applyReply,
  buildSuggestPrompt,
  cleanLine,
  pickCandidates,
  suggestForCard,
  type CardSuggestions,
  type SuggestInput,
  type SuggestKind,
  type SuggestOptions,
  type SuggestReply,
} from './ai'
