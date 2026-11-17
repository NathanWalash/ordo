// Node-only parts of mail-core (IMAP and SQLite). Import from '@ordo/mail-core/node'
// in the Electron main process; never in the renderer.
export {
  ImapMailProvider,
  ICLOUD_IMAP,
  MailAuthError,
  MailConnectionError,
  testImapLogin,
  type ImapConfig,
} from './imap'
export { MailStore, type MailboxState } from './store'
export { scanMailbox, type ScanOptions } from './scan'
