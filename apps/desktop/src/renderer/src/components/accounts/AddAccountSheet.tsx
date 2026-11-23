import { useEffect, useState, type ReactNode } from 'react'
import { CircleCheck, Info, KeyRound, Mail, ShieldCheck } from 'lucide-react'
import {
  guessProvider,
  imapSecureFor,
  PROVIDER_IDS,
  PROVIDERS,
  smtpSecurityFor,
  type ProviderId,
} from '@ordo/mail-core'
import {
  AddAccountSchema,
  type AccountResult,
  type AddAccountInput,
  type GoogleMailOptions,
} from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'

interface Props {
  onClose: () => void
  onAdded: (result: Extract<AccountResult, { ok: true }>) => void
  /** Go to Settings → Google to add an OAuth client (Sign in with Google needs one). */
  onSetUpGoogle?: () => void
}

/** How a Gmail account signs in. */
type GmailMethod = 'google' | 'password'

type Security = 'tls' | 'starttls'

/** What the form holds, before it's checked. */
interface Fields {
  email: string
  password: string
  label: string
  imapHost: string
  imapPort: string
  imapSecurity: Security
  smtpHost: string
  smtpPort: string
  smtpSecurity: Security
}

const EMPTY: Fields = {
  email: '',
  password: '',
  label: '',
  imapHost: '',
  imapPort: '993',
  imapSecurity: 'tls',
  smtpHost: '',
  smtpPort: '465',
  smtpSecurity: 'tls',
}

/** The form as the main process wants it. */
export function toInput(provider: ProviderId, f: Fields): AddAccountInput {
  const port = (v: string) => Number(v.trim())
  return {
    provider,
    email: f.email,
    password: f.password,
    ...(f.label.trim() && { label: f.label.trim() }),
    ...(provider === 'other' && {
      imap: { host: f.imapHost.trim(), port: port(f.imapPort), secure: f.imapSecurity === 'tls' },
      smtp: {
        host: f.smtpHost.trim(),
        port: port(f.smtpPort),
        secure: f.smtpSecurity === 'tls',
        requireTLS: f.smtpSecurity === 'starttls',
      },
    }),
  }
}

/**
 * Add a mail account: pick the provider (iCloud, Gmail, Yahoo, Fastmail, or Other with the
 * servers typed in), then its address and app password, or for Gmail, Sign in with Google (the
 * recommended way). Ordo signs in before saving anything.
 */
export function AddAccountSheet({ onClose, onAdded, onSetUpGoogle }: Props) {
  const [provider, setProvider] = useState<ProviderId>('gmail')
  const [picked, setPicked] = useState(false)
  const [f, setF] = useState<Fields>(EMPTY)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'test' | 'add' | 'google' | null>(null)
  const [result, setResult] = useState<AccountResult | null>(null)
  const [method, setMethod] = useState<GmailMethod>('google')
  const [google, setGoogle] = useState<GoogleMailOptions | null>(null)
  /** The connected Google account to use, or `new` for another sign-in. */
  const [googleChoice, setGoogleChoice] = useState<string>('new')
  const preset = PROVIDERS[provider]
  const viaGoogle = provider === 'gmail' && method === 'google'

  useEffect(() => {
    let live = true
    void window.ordo.accounts.googleOptions().then((o) => {
      if (!live) return
      setGoogle(o)
      setGoogleChoice(o.accounts.find((a) => !a.inUse)?.id ?? 'new')
    })
    return () => {
      live = false
    }
  }, [])

  const signInWithGoogle = async () => {
    setResult(null)
    setBusy('google')
    try {
      const res = await window.ordo.accounts.addGoogle({
        ...(googleChoice !== 'new' && { googleAccountId: googleChoice }),
        ...(f.label.trim() && { label: f.label.trim() }),
      })
      if (!res.ok && res.error === 'cancelled') return
      setResult(res)
      if (res.ok) onAdded(res)
    } finally {
      setBusy(null)
    }
  }

  const set = (k: keyof Fields, v: string) => {
    setF((x) => ({ ...x, [k]: v }))
    setResult(null)
    if (errors[k]) setErrors((e) => ({ ...e, [k]: '' }))
  }

  /** Typing an address picks the provider it belongs to, until you pick one yourself. */
  const setEmail = (v: string) => {
    set('email', v)
    if (!picked && v.includes('@')) {
      const guess = guessProvider(v)
      if (guess !== 'other' || /@[^@]+\.[a-z]{2,}$/i.test(v))
        setProvider(guess === 'outlook' ? 'outlook' : guess)
    }
  }

  const validate = (): AddAccountInput | null => {
    const input = toInput(provider, f)
    const parsed = AddAccountSchema.safeParse(input)
    if (parsed.success) {
      setErrors({})
      return input
    }
    const errs: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const [top, field] = issue.path.map(String)
      const key =
        top === 'imap'
          ? field === 'port'
            ? 'imapPort'
            : 'imapHost'
          : top === 'smtp'
            ? field === 'port'
              ? 'smtpPort'
              : 'smtpHost'
            : (top ?? 'form')
      errs[key] ||= issue.message
    }
    setErrors(errs)
    return null
  }

  const run = async (kind: 'test' | 'add') => {
    setResult(null)
    const input = validate()
    if (!input) return
    setBusy(kind)
    try {
      const res = await window.ordo.accounts[kind](input)
      setResult(res)
      if (res.ok && kind === 'add') onAdded(res)
    } finally {
      setBusy(null)
    }
  }

  const security = (value: Security, onChange: (v: Security) => void, label: string) => (
    <label className="flex flex-col gap-1.5 text-[13px] font-semibold">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Security)}
        className="h-7 rounded-md border border-sep bg-field px-1.5 text-[13px] font-normal text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
      >
        <option value="tls">SSL/TLS</option>
        <option value="starttls">STARTTLS</option>
      </select>
    </label>
  )

  return (
    <Sheet
      title="Add a mail account"
      subtitle={
        viaGoogle
          ? 'Ordo signs in with your Google account in your browser. No password is saved.'
          : 'Ordo signs in with an app password, saved in your Keychain.'
      }
      icon={<Mail size={22} />}
      width={560}
      fit
      busy={busy !== null}
      onClose={onClose}
      onSubmit={() => (viaGoogle ? void signInWithGoogle() : void run('add'))}
      footer={
        viaGoogle ? (
          <>
            <span className="flex-1" />
            {busy === 'google' ? (
              // Stops waiting for the browser; the sheet stays open.
              <Button onClick={() => void window.ordo.accounts.cancelGoogle()}>Cancel sign-in</Button>
            ) : (
              <Button onClick={onClose}>Cancel</Button>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={busy !== null || !google?.configured || !google.secureStorage}
            >
              {busy === 'google' ? 'Waiting for browser…' : 'Sign in with Google'}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy !== null || !preset.supported} onClick={() => void run('test')}>
              {busy === 'test' ? 'Testing…' : 'Test connection'}
            </Button>
            <span className="flex-1" />
            <Button disabled={busy !== null} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy !== null || !preset.supported}>
              {busy === 'add' ? 'Adding…' : 'Add account'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3.5">
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold">Provider</legend>
          <div role="radiogroup" aria-label="Provider" className="grid grid-cols-3 gap-1.5">
            {PROVIDER_IDS.map((id) => {
              const p = PROVIDERS[id]
              const on = id === provider
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setProvider(id)
                    setPicked(true)
                    setResult(null)
                    setErrors({})
                  }}
                  className={`flex h-12 flex-col items-start justify-center rounded-lg border px-2.5 text-left text-[13px] ${
                    on ? 'border-accent bg-accent-tint' : 'border-sep hover:bg-hover'
                  }`}
                >
                  <span className="font-medium">{p.name}</span>
                  {!p.supported && <span className="text-[11px] text-ink-2">Not supported yet</span>}
                  {id === 'other' && <span className="text-[11px] text-ink-2">Any IMAP server</span>}
                </button>
              )
            })}
          </div>
        </fieldset>

        {provider === 'gmail' && (
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-semibold">Sign in</legend>
            <div role="radiogroup" aria-label="How to sign in" className="grid grid-cols-2 gap-1.5">
              {(
                [
                  ['google', 'Sign in with Google', 'Recommended. Works for work accounts too.'],
                  ['password', 'App password', 'Needs 2-Step Verification.'],
                ] as const
              ).map(([id, name, detail]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={method === id}
                  disabled={busy !== null}
                  onClick={() => {
                    setMethod(id)
                    setResult(null)
                    setErrors({})
                  }}
                  className={`flex h-12 flex-col items-start justify-center rounded-lg border px-2.5 text-left text-[13px] ${
                    method === id ? 'border-accent bg-accent-tint' : 'border-sep hover:bg-hover'
                  }`}
                >
                  <span className="font-medium">{name}</span>
                  <span className="text-[11px] text-ink-2">{detail}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {viaGoogle && google && (
          <GoogleSignIn
            options={google}
            choice={googleChoice}
            onChoose={(c) => {
              setGoogleChoice(c)
              setResult(null)
            }}
            busy={busy !== null}
            label={f.label}
            onLabel={(v) => set('label', v)}
            labelError={errors['label']}
            onSetUp={onSetUpGoogle}
          />
        )}

        {!viaGoogle && preset.notes.length > 0 && (
          <Note icon={<Info size={14} className="mt-px shrink-0" />}>
            {preset.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </Note>
        )}

        {!viaGoogle && preset.supported && (
          <>
            <TextField
              label="Email address"
              type="email"
              autoComplete="username"
              placeholder={provider === 'icloud' ? 'you@icloud.com' : 'you@example.com'}
              value={f.email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors['email']}
            />
            <TextField
              label={preset.passwordLabel}
              type="password"
              autoComplete="off"
              placeholder={preset.passwordHint}
              value={f.password}
              onChange={(e) => set('password', e.target.value)}
              error={errors['password']}
              hint={preset.help}
            />
            {provider === 'other' && (
              <>
                <div className="grid grid-cols-[1fr_80px_110px] items-start gap-2">
                  <TextField
                    label="IMAP server"
                    placeholder="imap.example.com"
                    value={f.imapHost}
                    onChange={(e) => set('imapHost', e.target.value)}
                    error={errors['imapHost']}
                  />
                  <TextField
                    label="Port"
                    inputMode="numeric"
                    value={f.imapPort}
                    onChange={(e) => {
                      set('imapPort', e.target.value)
                      setF((x) => ({
                        ...x,
                        imapSecurity: imapSecureFor(Number(e.target.value)) ? 'tls' : 'starttls',
                      }))
                    }}
                    error={errors['imapPort']}
                  />
                  {security(f.imapSecurity, (v) => setF((x) => ({ ...x, imapSecurity: v })), 'Security')}
                </div>
                <div className="grid grid-cols-[1fr_80px_110px] items-start gap-2">
                  <TextField
                    label="SMTP server"
                    placeholder="smtp.example.com"
                    value={f.smtpHost}
                    onChange={(e) => set('smtpHost', e.target.value)}
                    error={errors['smtpHost']}
                  />
                  <TextField
                    label="Port"
                    inputMode="numeric"
                    value={f.smtpPort}
                    onChange={(e) => {
                      set('smtpPort', e.target.value)
                      setF((x) => ({
                        ...x,
                        smtpSecurity: smtpSecurityFor(Number(e.target.value)).secure ? 'tls' : 'starttls',
                      }))
                    }}
                    error={errors['smtpPort']}
                  />
                  {security(f.smtpSecurity, (v) => setF((x) => ({ ...x, smtpSecurity: v })), 'Security')}
                </div>
              </>
            )}
            <TextField
              label="Name (optional)"
              placeholder={`${preset.name}, Work, Personal…`}
              value={f.label}
              maxLength={40}
              onChange={(e) => set('label', e.target.value)}
              error={errors['label']}
              hint="Shown beside this account’s mail in the unified inbox."
            />
            <Note icon={<ShieldCheck size={14} className="mt-px shrink-0" />}>
              Saved in your Keychain. Ordo always uses an encrypted connection, and reads message headers
              until you open a message or choose to clean up.
            </Note>
          </>
        )}

        <p
          role="status"
          className={`flex items-start gap-1.5 text-[12px] leading-snug empty:hidden ${result?.ok ? 'text-ink-2' : 'text-danger'}`}
        >
          {result?.ok && <CircleCheck size={14} className="mt-px shrink-0 text-success" />}
          {result && (result.ok ? `Signed in as ${result.account.email}.` : result.message)}
          {!result && busy === 'google' && (
            <span className="text-ink-2">
              Finish signing in in your browser, then come back here. Allow Ordo to read and send your mail.
            </span>
          )}
          {!result && errors['provider']}
        </p>
      </div>
    </Sheet>
  )
}

/**
 * Gmail with Sign in with Google: which Google account (one already connected for Calendar, or
 * another), an optional name, and what Google will ask. Needs your own OAuth client first.
 */
function GoogleSignIn(props: {
  options: GoogleMailOptions
  choice: string
  onChoose: (choice: string) => void
  busy: boolean
  label: string
  onLabel: (label: string) => void
  labelError?: string
  onSetUp?: () => void
}) {
  const { options } = props
  if (!options.secureStorage)
    return (
      <Note icon={<Info size={14} className="mt-px shrink-0" />}>
        <p>Ordo keeps Google sign-ins in your computer’s keychain, which isn’t available right now.</p>
      </Note>
    )
  if (!options.configured)
    return (
      <Note icon={<KeyRound size={14} className="mt-px shrink-0" />}>
        <p>
          Ordo has no shared Google project, so Sign in with Google uses an OAuth client you create in your
          own Google Cloud project. It takes about ten minutes, once, and Calendar uses the same client.
        </p>
        {props.onSetUp && (
          <p>
            <Button onClick={props.onSetUp}>Set up in Settings → Google</Button>
          </p>
        )}
        <p>Or use an app password instead.</p>
      </Note>
    )
  const free = options.accounts.filter((a) => !a.inUse)
  const choices = [
    ...free.map((a) => ({
      id: a.id,
      name: a.email,
      detail: a.needsReauth
        ? 'Google needs you to sign in to it again.'
        : a.hasMail
          ? 'Already allows mail.'
          : 'Connected for Calendar. Ordo asks it for mail access too.',
    })),
    {
      id: 'new',
      name: free.length ? 'Another Google account' : 'Choose in your browser',
      detail: 'Google asks which account, then for mail access.',
    },
  ]
  return (
    <>
      <fieldset>
        <legend className="mb-1.5 text-[13px] font-semibold">Google account</legend>
        <div role="radiogroup" aria-label="Google account" className="flex flex-col gap-1.5">
          {choices.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={props.choice === o.id}
              disabled={props.busy}
              onClick={() => props.onChoose(o.id)}
              className={`flex min-h-11 flex-col items-start justify-center rounded-lg border px-2.5 py-1.5 text-left text-[13px] ${
                props.choice === o.id ? 'border-accent bg-accent-tint' : 'border-sep hover:bg-hover'
              }`}
            >
              <span className="font-medium">{o.name}</span>
              <span className="text-[11px] text-ink-2">{o.detail}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <TextField
        label="Name (optional)"
        placeholder="Gmail, Work, Personal…"
        value={props.label}
        maxLength={40}
        disabled={props.busy}
        onChange={(e) => props.onLabel(e.target.value)}
        error={props.labelError}
        hint="Shown beside this account’s mail in the unified inbox."
      />
      <Note icon={<ShieldCheck size={14} className="mt-px shrink-0" />}>
        <p>
          Google opens in your browser and asks to let Ordo read, send and delete your Gmail: that one
          permission is how mail apps reach Gmail over IMAP. Ordo keeps the sign-in in your Keychain and only
          talks to Google’s and Gmail’s own servers, always encrypted.
        </p>
        <p>Work and school accounts: your admin may need to allow Ordo, and may have turned IMAP off.</p>
      </Note>
    </>
  )
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-2 rounded-lg bg-selected px-2.5 py-2 text-[12px] leading-snug text-ink-2">
      {icon}
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  )
}
