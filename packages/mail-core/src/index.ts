export * from './types'
export {
  parseUnsubscribe,
  parseMailto,
  planMailto,
  registrableDomain,
  listIdHost,
  MAILTO_BODY_MAX,
  MAILTO_PER_CLEANUP_MAX,
  MAILTO_SUBJECT_MAX,
  type MailtoPlan,
  type ParsedMailto,
  isSecureUrl,
  unsubscribeRank,
  type MailtoMessage,
  type UnsubscribeParseOptions,
} from './unsubscribe'
export {
  executeUnsubscribe,
  BLOCKED_ADDRESS,
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
export { hostRefusal, isBlockedIp, type GuardOptions } from './url-guard'
export { groupBySender, isAutomated, isBulk } from './senders'
export { categorise } from './rules'
export { analyseSenders, type CategorisedSender } from './analyse'
export {
  STILL_EMAILING_AFTER_MS,
  stillEmailing,
  unsubscribedFromHistory,
  withUnsubscribed,
  type SenderUnsubscribed,
} from './unsubscribed'
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
export {
  parseHeaderBlock,
  toAddresses,
  toMessageHeader,
  SCAN_HEADER_FIELDS,
  type RawFetchedMessage,
} from './headers'
export { EMAIL_ADDRESS, hasControlChars } from './unsubscribe'
export {
  ADDRESS_MAX,
  displayName,
  formatAddress,
  formatAddressList,
  isEmailAddress,
  parseAddress,
  parseAddressList,
  personLabel,
  recipientList,
  splitAddressList,
  type ParsedAddressList,
} from './address'
export {
  COMPOSE_LIMITS,
  forwardBody,
  forwardSubject,
  ownAddresses,
  parseMailtoLink,
  referencesFor,
  replyBody,
  replyRecipients,
  replySubject,
  type MailtoDraft,
} from './compose'
export { checkLink, LINK_MAX, type CheckedLink } from './links'
export { archiveMailbox, ROLE_NAMES, toMailboxList, type RawMailbox } from './mailboxes'
export {
  guessProvider,
  imapSecureFor,
  PROVIDER_IDS,
  PROVIDERS,
  serversFor,
  smtpSecurityFor,
  type ImapServer,
  type ProviderId,
  type ProviderPreset,
  type SmtpServer,
} from './providers'
export { planBodyParts, referencedCids, safeFilename, type BodyNode, type BodyPlan } from './mime'
export { bodyText, decodeEntities, htmlToText, printable, tidy, type HtmlToTextOptions } from './text'
