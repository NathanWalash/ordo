import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ExternalLink, LogOut } from 'lucide-react'
import type { CalendarListItem, GoogleAccountStatus, GoogleFeedMatch, GoogleStatus } from '@ordo/shared'
import { Button } from './Button'
import { Row, Section } from './SettingsSection'
import { Sheet } from './Sheet'
import { TextField } from './TextField'

/** The step-by-step guide to creating your own OAuth client. */
const GUIDE = 'https://github.com/NathanWalash/ordo/blob/main/docs/google.md'

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Settings → Google: your own OAuth client (Ordo has no shared Google Cloud project), connected
 * accounts, which of their calendars to show and in what colour, and signing out. Also offers to
 * replace a calendar added by its Google link with the live, editable connection. An account can
 * also be Mail's (a Gmail account added with Sign in with Google): signing out of it asks first,
 * and removes those mail accounts too.
 */
export function GoogleSettings({
  onAccountsChanged,
  accountsKey,
}: {
  /** Signing out removed mail accounts. */
  onAccountsChanged?: () => void
  /** Changes when mail accounts are added or removed, so which Google sign-ins Mail uses is fresh. */
  accountsKey?: string
} = {}) {
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [calendars, setCalendars] = useState<CalendarListItem[]>([])
  const [matches, setMatches] = useState<GoogleFeedMatch[]>([])
  const [editingClient, setEditingClient] = useState(false)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [clientError, setClientError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  /** Signing out of an account that mail accounts use: confirm removing them first. */
  const [confirmSignOut, setConfirmSignOut] = useState<GoogleAccountStatus | null>(null)

  const load = useCallback(async () => {
    const [s, c, m] = await Promise.all([
      window.ordo.google.status(),
      window.ordo.calendar.calendars(),
      window.ordo.google.feedMatches(),
    ])
    setStatus(s)
    setCalendars(c.filter((x) => x.source === 'google'))
    setMatches(m)
  }, [])

  useEffect(() => {
    let live = true
    void Promise.all([
      window.ordo.google.status(),
      window.ordo.calendar.calendars(),
      window.ordo.google.feedMatches(),
    ]).then(([s, c, m]) => {
      if (!live) return
      setStatus(s)
      setCalendars(c.filter((x) => x.source === 'google'))
      setMatches(m)
    })
    const off = window.ordo.calendar.onChanged(() => void load())
    return () => {
      live = false
      off()
    }
  }, [load, accountsKey])

  if (!status) return null

  const saveClient = async () => {
    setClientError(null)
    const r = await window.ordo.google.setClient({ clientId, ...(secret.trim() && { clientSecret: secret }) })
    if (!r.ok) return setClientError(r.message)
    setEditingClient(false)
    setSecret('')
    await load()
  }

  const connect = async (accountId?: string, addCalendar = false) => {
    setBusy(accountId ?? 'new')
    setMessage(null)
    try {
      const r = await window.ordo.google.connect(
        accountId ? { accountId, ...(addCalendar && { addCalendar }) } : undefined,
      )
      if (!r.ok && r.error !== 'cancelled') setMessage(r.message)
    } finally {
      setBusy(null)
      await load()
    }
  }

  /** Sign out; the mail accounts listed (which the user confirmed) are removed too. */
  const signOut = async (a: GoogleAccountStatus, removeMail: string[] = []) => {
    setBusy(a.id)
    try {
      const r = await window.ordo.google.signOut(a.id, removeMail.length ? { removeMail } : undefined)
      if (!r.ok) setMessage(r.message)
      else if (removeMail.length) onAccountsChanged?.()
    } finally {
      setBusy(null)
      setConfirmSignOut(null)
      await load()
    }
  }

  const toggle = async (c: CalendarListItem, visible: boolean) => {
    setCalendars((cs) => cs.map((x) => (x.id === c.id ? { ...x, visible } : x)))
    await window.ordo.calendar.setVisible({ calendarId: c.id, visible })
  }

  const colour = async (c: CalendarListItem, color: string) => {
    setCalendars((cs) => cs.map((x) => (x.id === c.id ? { ...x, color } : x)))
    await window.ordo.google.setCalendarColor({ calendarId: c.id, color })
  }

  const replace = async (m: GoogleFeedMatch) => {
    const r = await window.ordo.google.replaceFeed({ feedId: m.feedId })
    if (!r.ok) setMessage(r.message)
    await load()
  }

  const showClientForm = editingClient || !status.client
  return (
    <Section title="Google">
      {!status.secureStorage && (
        <Row
          label="Secure storage isn’t available"
          detail="Ordo keeps Google sign-ins in your computer’s keychain, which isn’t available right now."
        />
      )}
      {showClientForm ? (
        <div className="flex flex-col gap-3 border-b border-sep px-4 py-3 last:border-b-0">
          <div className="text-[12px] leading-snug text-ink-2">
            Ordo has no shared Google project, so it signs in with an OAuth client you create in your own
            Google Cloud project (type “Desktop app”). It takes about ten minutes.{' '}
            <a
              href={GUIDE}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-accent"
            >
              Read the guide <ExternalLink size={11} />
            </a>
          </div>
          <TextField
            label="Client ID"
            placeholder="1234567890-abc….apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            error={clientError ?? undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <TextField
            label="Client secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            hint="Google gives desktop apps a secret too. It isn’t truly secret, but Ordo keeps it in your keychain anyway."
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex justify-end gap-2">
            {status.client && <Button onClick={() => setEditingClient(false)}>Cancel</Button>}
            <Button variant="primary" disabled={!clientId.trim()} onClick={() => void saveClient()}>
              Save client
            </Button>
          </div>
        </div>
      ) : (
        <Row
          label="OAuth client"
          detail={
            <span className="break-all">
              {status.client!.clientId}
              {status.client!.hasSecret ? ' · secret saved' : ''}
            </span>
          }
          control={
            <Button
              onClick={() => {
                setClientId(status.client!.clientId)
                setEditingClient(true)
              }}
            >
              Change…
            </Button>
          }
        />
      )}

      {status.accounts.map((a) => (
        <div key={a.id} className="border-b border-sep last:border-b-0">
          <Row
            label={a.email}
            detail={
              a.needsReauth ? (
                <span className="flex items-center gap-1 text-danger-text">
                  <AlertCircle size={12} /> Google stopped accepting Ordo’s sign-in. Sign in again to keep it
                  updating.
                </span>
              ) : (
                [
                  a.calendar
                    ? `${a.calendars} calendar${a.calendars === 1 ? '' : 's'}. Changes show up within a few minutes.`
                    : 'Calendar isn’t connected.',
                  a.mailAccounts.length ? `Mail: ${a.mailAccounts.map((m) => m.label).join(', ')}.` : '',
                ]
                  .filter(Boolean)
                  .join(' ')
              )
            }
            control={
              <span className="flex gap-2">
                {a.needsReauth && (
                  <Button variant="primary" disabled={busy !== null} onClick={() => void connect(a.id)}>
                    {busy === a.id ? 'Waiting for browser…' : 'Sign in again'}
                  </Button>
                )}
                {!a.needsReauth && !a.calendar && (
                  <Button disabled={busy !== null} onClick={() => void connect(a.id, true)}>
                    {busy === a.id ? 'Waiting for browser…' : 'Add Calendar'}
                  </Button>
                )}
                <Button
                  disabled={busy !== null}
                  onClick={() => (a.mailAccounts.length ? setConfirmSignOut(a) : void signOut(a))}
                >
                  Sign out
                </Button>
              </span>
            }
          />
          {calendars.some((c) => c.account === a.email) && (
            <ul className="px-4 pb-2" aria-label={`Calendars in ${a.email}`}>
              {calendars
                .filter((c) => c.account === a.email)
                .map((c) => (
                  <li key={c.id} className="flex h-8 items-center gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      checked={c.visible}
                      onChange={(e) => void toggle(c, e.target.checked)}
                      aria-label={`Show ${c.name}`}
                      className="size-3.5 shrink-0"
                      style={{ accentColor: c.color ?? 'var(--accent)' }}
                    />
                    <input
                      type="color"
                      value={c.color ?? '#007aff'}
                      onChange={(e) => void colour(c, e.target.value)}
                      aria-label={`Colour for ${c.name}`}
                      className="h-5 w-6 shrink-0 cursor-default rounded border border-sep bg-transparent p-0"
                    />
                    <span className="min-w-0 flex-1 truncate" title={c.name}>
                      {c.name}
                      {c.readOnly && <span className="text-ink-3"> · read only</span>}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-3" title={c.syncError}>
                      {c.syncError ? (
                        <span className="flex items-center gap-1 text-danger-text">
                          <AlertCircle size={11} /> Not updated
                        </span>
                      ) : c.syncedAt ? (
                        `Updated ${when(c.syncedAt)}`
                      ) : c.visible ? (
                        'Not synced yet'
                      ) : (
                        'Hidden'
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      ))}

      {matches.map((m) => (
        <Row
          key={m.feedId}
          label={`Replace “${m.feedName}” with the live calendar`}
          detail={`You added it by its link, which Google only refreshes every few hours and can’t be changed. “${m.calendarName}” in ${m.email} is the same calendar, live and editable.`}
          control={<Button onClick={() => void replace(m)}>Replace</Button>}
        />
      ))}

      {status.client && (
        <Row
          label={status.accounts.length ? 'Another Google account' : 'Google Calendar'}
          detail={
            busy === 'new'
              ? 'Finish signing in in your browser. Ordo asks only to see your calendar list and change events.'
              : 'Sign in in your browser to see your Google calendars here and change their events.'
          }
          control={
            busy === 'new' ? (
              <Button onClick={() => void window.ordo.google.cancelConnect()}>Cancel</Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy !== null || !status.secureStorage}
                onClick={() => void connect()}
              >
                Connect Google account
              </Button>
            )
          }
        />
      )}
      {message && (
        <p role="alert" className="border-t border-sep px-4 py-2.5 text-[12px] text-danger-text">
          {message}
        </p>
      )}
      {confirmSignOut && (
        <SignOutSheet
          account={confirmSignOut}
          busy={busy === confirmSignOut.id}
          onClose={() => setConfirmSignOut(null)}
          onConfirm={() =>
            void signOut(
              confirmSignOut,
              confirmSignOut.mailAccounts.map((m) => m.id),
            )
          }
        />
      )}
    </Section>
  )
}

/**
 * Signing out of a Google account that Mail uses: revoking Ordo's access ends the sign-in for Mail
 * too, so its mail accounts go as well, exactly as removing them in Settings → Accounts does.
 */
function SignOutSheet(props: {
  account: GoogleAccountStatus
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const a = props.account
  const many = a.mailAccounts.length > 1
  return (
    <Sheet
      title={`Sign out of ${a.email}?`}
      subtitle={many ? 'Mail accounts use this sign-in.' : 'A mail account uses this sign-in.'}
      icon={<LogOut size={20} />}
      iconTone="warning"
      busy={props.busy}
      onClose={props.onClose}
      onSubmit={props.onConfirm}
      initialFocus="[data-cancel]"
      footer={
        <>
          <span className="flex-1" />
          <Button data-cancel disabled={props.busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={props.busy}>
            {props.busy ? 'Signing out…' : many ? 'Sign out and remove them' : 'Sign out and remove it'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px] leading-snug">
        <p>
          Signing out takes away Ordo’s access to this Google account
          {a.calendar ? ', removes its calendars from Calendar' : ''} and removes{' '}
          {many ? 'these mail accounts' : 'this mail account'} from Ordo:
        </p>
        <ul className="list-disc pl-5 text-ink-2">
          {a.mailAccounts.map((m) => (
            <li key={m.id}>
              {m.label} ({m.email}): its downloaded mail and clean-up history
            </li>
          ))}
        </ul>
        <p>
          Nothing changes in Gmail: your mail stays where it is, and you can add the account again at any
          time.
        </p>
      </div>
    </Sheet>
  )
}
