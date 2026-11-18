import type { MailboxInfo, MailboxRole } from './types'

/** The slice of an IMAP LIST entry we use; matches imapflow's ListResponse. */
export interface RawMailbox {
  path: string
  name: string
  delimiter: string
  flags: Set<string>
  specialUse?: string
  /** "extension" when the server said so, "name" when guessed from a well-known name. */
  specialUseSource?: string
  status?: { messages?: number; unseen?: number }
}

const ROLE_OF: Record<string, MailboxRole> = {
  '\\Inbox': 'inbox',
  '\\Drafts': 'drafts',
  '\\Sent': 'sent',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\Trash': 'trash',
}

const ORDER: MailboxRole[] = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash']

/**
 * The folders to show, from an IMAP LIST: selectable ones only, one folder per role (the
 * server's own SPECIAL-USE flag wins over a guess from the name), the special ones first in
 * Mail's order (Inbox, Drafts, Sent, Archive, Junk, Bin), then the rest by path.
 */
export function toMailboxList(raw: readonly RawMailbox[]): MailboxInfo[] {
  const usable = raw.filter((m) => !m.flags.has('\\Noselect') && !m.flags.has('\\NonExistent'))
  const roleFor = (m: RawMailbox): MailboxRole | null =>
    m.path.toUpperCase() === 'INBOX' ? 'inbox' : (m.specialUse && ROLE_OF[m.specialUse]) || null
  const claimed = new Map<MailboxRole, RawMailbox>()
  // Server-declared roles first, then guesses by name, so a declared one is never displaced.
  for (const pass of ['extension', 'other'] as const)
    for (const m of usable) {
      const role = roleFor(m)
      if (!role || claimed.has(role)) continue
      const declared = m.specialUseSource !== 'name' || role === 'inbox'
      if ((pass === 'extension') === declared) claimed.set(role, m)
    }
  const owner = new Map([...claimed].map(([role, m]) => [m.path, role]))
  const info = (m: RawMailbox): MailboxInfo => ({
    path: m.path,
    name: m.path.toUpperCase() === 'INBOX' ? 'Inbox' : m.name,
    role: owner.get(m.path) ?? null,
    delimiter: m.delimiter || '/',
    total: m.status?.messages ?? 0,
    unread: m.status?.unseen ?? 0,
  })
  const special = ORDER.flatMap((role) => (claimed.has(role) ? [info(claimed.get(role)!)] : []))
  const rest = usable
    .filter((m) => !owner.has(m.path))
    .map(info)
    .sort((a, b) => a.path.localeCompare(b.path))
  return [...special, ...rest]
}

/** What the app calls each special folder. iCloud's Trash is "Bin" in British English. */
export const ROLE_NAMES: Record<MailboxRole, string> = {
  inbox: 'Inbox',
  drafts: 'Drafts',
  sent: 'Sent',
  archive: 'Archive',
  junk: 'Junk',
  trash: 'Bin',
}
