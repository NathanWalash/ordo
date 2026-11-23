import { ipcMain } from 'electron'
import { PROVIDERS, serversFor } from '@ordo/mail-core'
import { testImapLogin } from '@ordo/mail-core/node'
import {
  ACCOUNTS_IPC,
  AccountIdSchema,
  AddAccountSchema,
  defaultLabel,
  FIRST_ACCOUNT_ID,
  nextColor,
  SetPasswordSchema,
  TestAccountSchema,
  UpdateAccountSchema,
  type AccountResult,
  type AccountSummary,
  type AccountSyncState,
  type MailAccount,
} from '@ordo/shared'
import {
  addStoredAccount,
  canStoreSecrets,
  getAccount,
  listAccounts,
  setSecret,
  updateStoredAccount,
} from './account'
import {
  accountStore,
  explain,
  imapConfigFor,
  imapConfigForTest,
  INBOX,
  removeAccount,
  syncSchedule,
} from './mail'

/**
 * Settings → Accounts: add, test, rename, recolour, re-enter a password, remove. Every input from
 * the window is checked with zod here. Adding an account or a new password signs in first, so
 * nothing is saved that doesn't work.
 */

const invalid = (message: string): AccountResult => ({ ok: false, error: 'invalid', message })
const NO_KEYCHAIN: AccountResult = {
  ok: false,
  error: 'unavailable',
  message: "This computer can't store passwords securely, so Ordo won't save yours.",
}

/** How an account's last check went, from the schedule. */
function syncState(id: string): AccountSyncState {
  const r = syncSchedule.get(id)
  if (!r.last) return {}
  return {
    failedAt: new Date(r.last.at).toISOString(),
    message: r.last.message,
    error: r.last.kind,
    ...(r.retryAt && { retryAt: new Date(r.retryAt).toISOString() }),
  }
}

export function list(): AccountSummary[] {
  return listAccounts().map((a) => ({
    ...a,
    messageCount: accountStore(a.id).count(INBOX),
    sync: syncState(a.id),
  }))
}

/** The account a new one would be: servers from the preset (or typed, for Other), label, colour. */
function draftAccount(
  input: ReturnType<typeof AddAccountSchema.parse>,
): Omit<MailAccount, 'id' | 'lastScan'> | null {
  const servers = serversFor(
    input.provider,
    input.imap && input.smtp ? { imap: input.imap, smtp: input.smtp } : undefined,
  )
  if (!servers) return null
  const others = listAccounts()
  return {
    label:
      input.label?.trim() ||
      defaultLabel(
        input.provider,
        others.map((a) => a.label),
      ),
    email: input.email,
    color: input.color ?? nextColor(others.map((a) => a.color)),
    provider: input.provider,
    imap: servers.imap,
    smtp: servers.smtp,
    auth: { kind: 'password' },
  }
}

/** Sign in to an account's IMAP server and out again. */
async function signIn(
  account: Omit<MailAccount, 'id' | 'lastScan'>,
  password: string,
): Promise<AccountResult | null> {
  try {
    await testImapLogin(imapConfigForTest(account.imap, account.email, password))
    return null
  } catch (err) {
    return { ok: false, ...explain(err, account.email, account) }
  }
}

/** Test new details, or a saved account, without saving anything. */
export async function test(input: unknown): Promise<AccountResult> {
  const parsed = TestAccountSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message || 'Check the details.')
  if ('id' in parsed.data) {
    const account = getAccount(parsed.data.id)
    if (!account) return invalid('There’s no such account.')
    try {
      await testImapLogin(await imapConfigFor(account))
      syncSchedule.reset(account.id)
      return { ok: true, account }
    } catch (err) {
      return { ok: false, ...explain(err, account.email, account) }
    }
  }
  const draft = draftAccount(parsed.data)
  if (!draft) return invalid(PROVIDERS[parsed.data.provider].notes[0] ?? 'Ordo can’t connect to this yet.')
  const problem = await signIn(draft, parsed.data.password)
  return problem ?? { ok: true, account: { ...draft, id: 'acc-new', lastScan: null } }
}

/** Sign in with the details, then save the account with its password encrypted. */
export async function add(input: unknown): Promise<AccountResult> {
  if (!canStoreSecrets()) return NO_KEYCHAIN
  const parsed = AddAccountSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message || 'Check the details.')
  const draft = draftAccount(parsed.data)
  if (!draft) return invalid(PROVIDERS[parsed.data.provider].notes[0] ?? 'Ordo can’t connect to this yet.')
  const email = draft.email.toLowerCase()
  if (listAccounts().some((a) => a.email.toLowerCase() === email && a.imap.host === draft.imap.host))
    return invalid('That account is already in Ordo. Enter its password again from its row instead.')
  const problem = await signIn(draft, parsed.data.password)
  if (problem) return problem
  // An empty profile's first account gets the id an old mail cache's rows already belong to.
  const account = addStoredAccount(
    draft,
    parsed.data.password,
    listAccounts().length === 0 ? FIRST_ACCOUNT_ID : undefined,
  )
  return { ok: true, account }
}

export function update(input: unknown): AccountResult {
  const parsed = UpdateAccountSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message || 'Check the details.')
  const { id, label, color } = parsed.data
  const account = updateStoredAccount(id, {
    ...(label !== undefined && label.trim() && { label: label.trim() }),
    ...(color && { color }),
  })
  return account ? { ok: true, account } : invalid('There’s no such account.')
}

/** Check a new password by signing in with it, then save it. */
export async function setPassword(input: unknown): Promise<AccountResult> {
  if (!canStoreSecrets()) return NO_KEYCHAIN
  const parsed = SetPasswordSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message || 'Check the password.')
  const account = getAccount(parsed.data.id)
  if (!account) return invalid('There’s no such account.')
  const problem = await signIn(account, parsed.data.password)
  if (problem) return problem
  setSecret(account.id, parsed.data.password)
  syncSchedule.reset(account.id)
  return { ok: true, account }
}

/** Forget the account, its password and everything downloaded for it. */
export async function remove(input: unknown): Promise<void> {
  const id = AccountIdSchema.safeParse(input)
  if (!id.success || !getAccount(id.data)) return
  await removeAccount(id.data)
}

export function registerAccountsIpc(onRemoved?: (id: string) => void): void {
  ipcMain.handle(ACCOUNTS_IPC.list, () => list())
  ipcMain.handle(ACCOUNTS_IPC.test, (_e, input: unknown) => test(input))
  ipcMain.handle(ACCOUNTS_IPC.add, (_e, input: unknown) => add(input))
  ipcMain.handle(ACCOUNTS_IPC.update, (_e, input: unknown) => update(input))
  ipcMain.handle(ACCOUNTS_IPC.setPassword, (_e, input: unknown) => setPassword(input))
  ipcMain.handle(ACCOUNTS_IPC.remove, async (_e, id: unknown) => {
    await remove(id)
    if (typeof id === 'string') onRemoved?.(id)
  })
}
