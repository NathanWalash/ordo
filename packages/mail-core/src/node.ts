// Node-only parts of mail-core (IMAP, SQLite and network). Import from '@ordo/mail-core/node'
// in the Electron main process; never in the renderer.
export {
  ImapMailProvider,
  ICLOUD_IMAP,
  MailAuthError,
  MailConnectionError,
  MailUnavailableError,
  classifyImapError,
  testImapLogin,
  type ImapConfig,
  type MailConnectionReason,
} from './imap'
export { MailStore, type MailboxState, type NewCleanup } from './store'
export { scanMailbox, type ScanOptions } from './scan'
export { BlockedAddressError, createGuardedFetch, createGuardedLookup, type Resolver } from './net-guard'
export { runCleanup, undoCleanup, type CleanupOptions } from './cleanup'
export { createMailtoSender, ICLOUD_SMTP, type SmtpConfig } from './smtp'
