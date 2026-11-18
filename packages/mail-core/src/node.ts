// Node-only parts of mail-core (IMAP, SQLite and network). Import from '@ordo/mail-core/node'
// in the Electron main process; never in the renderer.
export {
  ImapMailProvider,
  ICLOUD_IMAP,
  MailAuthError,
  MailConnectionError,
  MailUnavailableError,
  classifyImapError,
  serverWords,
  testImapLogin,
  type ImapConfig,
  type MailConnectionReason,
} from './imap'
export { MailStore, type MailboxState, type NewCleanup } from './store'
export { scanMailbox, type ScanOptions } from './scan'
export { BlockedAddressError, createGuardedFetch, createGuardedLookup, type Resolver } from './net-guard'
export { runCleanup, undoCleanup, type CleanupOptions } from './cleanup'
export {
  buildMessage,
  checkOutgoing,
  RecipientsRefused,
  createMailtoSender,
  ICLOUD_SMTP,
  sendMessage,
  type OutgoingMessage,
  type SendTransport,
  type SmtpConfig,
} from './smtp'
export { READ_LIMITS, messageIds } from './imap'
export type { FlagUpdate, MessageQuery, SearchQuery } from './store'
export {
  FOLDER_SYNC_DEFAULTS,
  reconcileFolder,
  syncFolder,
  toUidSet,
  type FolderSource,
  type FolderSyncOptions,
  type FolderSyncResult,
} from './sync'
export {
  IMAGE_LIMITS,
  loadRemoteImages,
  type ImageFetch,
  type LoadedImages,
  type LoadImagesOptions,
} from './images'
