import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, PenLine, Trash2 } from 'lucide-react'
import { PROVIDERS } from '@ordo/mail-core'
import { ACCOUNT_COLORS, type AccountColor, type AccountResult, type AccountSummary } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'
import { Section } from '../SettingsSection'
import { AccountDot, ACCOUNT_HEX, COLOR_NAMES } from './AccountChip'
import { AddAccountSheet } from './AddAccountSheet'

interface Props {
  /** Connect an iCloud account with the first-run sheet. */
  onConnectIcloud: () => void
  /** Accounts changed (added, renamed, removed): the rest of the app reloads them. */
  onChanged: () => void
}

const providerName = (a: AccountSummary) =>
  a.provider === 'other' ? a.imap.host : PROVIDERS[a.provider].name

/**
 * Settings → Accounts: every mail account, with what it is and how its last check went. Add one,
 * rename or recolour it, enter its password again, test it, or remove it.
 */
export function AccountsSection({ onConnectIcloud, onChanged }: Props) {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AccountSummary | null>(null)
  const [removing, setRemoving] = useState<AccountSummary | null>(null)

  const load = useCallback(async () => setAccounts(await window.ordo.accounts.list()), [])
  useEffect(() => {
    let live = true
    void window.ordo.accounts.list().then((a) => live && setAccounts(a))
    return () => {
      live = false
    }
  }, [])

  const changed = async () => {
    await load()
    onChanged()
  }

  if (!accounts) return null
  return (
    <Section title="Accounts">
      {accounts.length === 0 ? (
        <div className="flex min-h-12 items-center gap-4 px-4 py-2.5">
          <div className="flex-1">
            <div className="text-[13px] font-medium">Mail accounts</div>
            <div className="text-[12px] leading-snug text-ink-2">
              Not connected. Connect iCloud (Mail and Calendar), or add Gmail, Yahoo, Fastmail or any IMAP
              account with an app password.
            </div>
          </div>
          <Button onClick={() => setAdding(true)}>Add account…</Button>
          <Button variant="primary" onClick={onConnectIcloud}>
            Connect iCloud
          </Button>
        </div>
      ) : (
        <>
          <ul aria-label="Mail accounts">
            {accounts.map((a) => (
              <li key={a.id} className="flex min-h-12 items-start gap-3 border-b border-sep px-4 py-2.5">
                <span className="pt-1">
                  <AccountDot color={a.color} size={10} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{a.label}</div>
                  <div className="truncate text-[12px] leading-snug text-ink-2">
                    {a.email} · {providerName(a)}
                    {a.messageCount > 0 && ` · ${a.messageCount.toLocaleString()} in the inbox`}
                    {a.provider === 'icloud' && accounts.find((x) => x.provider === 'icloud')?.id === a.id
                      ? ' · Calendar'
                      : ''}
                  </div>
                  {a.sync.message && (
                    <p className="mt-1 flex items-start gap-1 text-[12px] leading-snug text-danger-text">
                      <CircleAlert size={13} className="mt-px shrink-0" />
                      <span>{a.sync.message}</span>
                    </p>
                  )}
                </div>
                <Button
                  icon={<PenLine size={13} />}
                  aria-label={`Edit ${a.label}`}
                  onClick={() => setEditing(a)}
                >
                  {a.sync.error === 'auth' ? 'Enter password…' : 'Edit…'}
                </Button>
                <Button
                  icon={<Trash2 size={13} />}
                  aria-label={`Remove ${a.label}`}
                  onClick={() => setRemoving(a)}
                >
                  Remove…
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end px-4 py-2.5">
            <Button onClick={() => setAdding(true)}>Add account…</Button>
          </div>
        </>
      )}
      {adding && (
        <AddAccountSheet
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            void changed()
          }}
        />
      )}
      {editing && (
        <EditAccountSheet
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void changed()
          }}
        />
      )}
      {removing && (
        <RemoveAccountSheet
          account={removing}
          calendar={accounts.find((x) => x.provider === 'icloud')?.id === removing.id}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null)
            void changed()
          }}
        />
      )}
    </Section>
  )
}

/** Rename, recolour, enter the password again, or test the connection. */
function EditAccountSheet(props: { account: AccountSummary; onClose: () => void; onSaved: () => void }) {
  const a = props.account
  const preset = PROVIDERS[a.provider]
  const [label, setLabel] = useState(a.label)
  const [color, setColor] = useState<AccountColor>(a.color)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [result, setResult] = useState<AccountResult | null>(null)
  const [tested, setTested] = useState(false)

  const save = async () => {
    setResult(null)
    setBusy('save')
    try {
      if (password.trim()) {
        const r = await window.ordo.accounts.setPassword({ id: a.id, password })
        if (!r.ok) return setResult(r)
      }
      const r = await window.ordo.accounts.update({ id: a.id, label, color })
      if (!r.ok) return setResult(r)
      props.onSaved()
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setResult(null)
    setBusy('test')
    try {
      setResult(await window.ordo.accounts.test({ id: a.id }))
      setTested(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet
      title={`Edit ${a.label}`}
      subtitle={`${a.email} · ${a.provider === 'other' ? a.imap.host : preset.name}`}
      icon={<PenLine size={20} />}
      busy={busy !== null}
      onClose={props.onClose}
      onSubmit={() => void save()}
      footer={
        <>
          <Button disabled={busy !== null} onClick={() => void test()}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
          <span className="flex-1" />
          <Button disabled={busy !== null} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <TextField label="Name" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-semibold">Colour</legend>
        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
          {ACCOUNT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={COLOR_NAMES[c]}
              title={COLOR_NAMES[c]}
              onClick={() => setColor(c)}
              className={`size-6 rounded-full ring-offset-2 ring-offset-sheet ${c === color ? 'ring-2 ring-accent' : ''}`}
              style={{ background: ACCOUNT_HEX[c] }}
            />
          ))}
        </div>
      </fieldset>
      <TextField
        label={`New ${preset.passwordLabel.toLowerCase()}`}
        type="password"
        autoComplete="off"
        placeholder={preset.passwordHint || 'Leave empty to keep the saved one'}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={`Only if it changed or stopped working. Ordo signs in with it before saving it. ${preset.help}`}
      />
      <p
        role="status"
        className={`flex items-start gap-1.5 text-[12px] leading-snug empty:hidden ${result?.ok ? 'text-ink-2' : 'text-danger'}`}
      >
        {result?.ok && <CircleCheck size={14} className="mt-px shrink-0 text-success" />}
        {result && (result.ok ? (tested ? `Signed in as ${result.account.email}.` : '') : result.message)}
      </p>
    </Sheet>
  )
}

/** Say exactly what removing an account forgets, and that nothing changes on the server. */
function RemoveAccountSheet(props: {
  account: AccountSummary
  /** It's the iCloud account Calendar uses. */
  calendar: boolean
  onClose: () => void
  onRemoved: () => void
}) {
  const a = props.account
  const [busy, setBusy] = useState(false)
  const where = a.provider === 'other' ? a.imap.host : PROVIDERS[a.provider].name
  const remove = async () => {
    setBusy(true)
    try {
      await window.ordo.accounts.remove(a.id)
      props.onRemoved()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      title={`Remove ${a.label}?`}
      subtitle={a.email}
      icon={<Trash2 size={20} />}
      iconTone="warning"
      busy={busy}
      onClose={props.onClose}
      onSubmit={() => void remove()}
      initialFocus="[data-cancel]"
      footer={
        <>
          <span className="flex-1" />
          <Button data-cancel disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={busy}>
            {busy ? 'Removing…' : 'Remove account'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-[13px] leading-snug">
        <p>Ordo forgets this account’s password and everything it downloaded for it:</p>
        <ul className="list-disc pl-5 text-ink-2">
          <li>
            {a.messageCount > 0
              ? `${a.messageCount.toLocaleString()} cached inbox messages`
              : 'Its cached mail'}
            , its folders and the text of messages you opened
          </li>
          <li>Its clean-up history, so those clean-ups can’t be undone from Ordo</li>
          {props.calendar && <li>Its iCloud calendars in Calendar (calendars added by link stay)</li>}
        </ul>
        <p>
          Nothing changes on the server: your mail stays in {where}. You can add the account again at any
          time.
        </p>
      </div>
    </Sheet>
  )
}
