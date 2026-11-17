import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CircleCheck, Mail, ShieldCheck } from 'lucide-react'
import { ConnectInputSchema, type ConnectResult } from '@ordo/shared'
import { Button } from './Button'
import { TextField } from './TextField'

interface Props {
  onClose: () => void
  onConnected: (email: string) => void
}

type FieldErrors = { email?: string; password?: string }

/** Sheet for connecting an iCloud account with an app-specific password. */
export function ConnectSheet({ onClose, onConnected }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [busy, setBusy] = useState<'test' | 'connect' | null>(null)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => {
    first.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const validate = () => {
    const parsed = ConnectInputSchema.safeParse({ email, password })
    if (parsed.success) {
      setFieldErrors({})
      return true
    }
    const errs: FieldErrors = {}
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof FieldErrors
      errs[key] ??= issue.message
    }
    setFieldErrors(errs)
    return false
  }

  const run = async (kind: 'test' | 'connect') => {
    setResult(null)
    if (!validate()) return
    setBusy(kind)
    try {
      const res = await window.ordo.account[kind]({ email, password })
      setResult(res)
      if (res.ok && kind === 'connect') onConnected(res.email)
    } finally {
      setBusy(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void run('connect')
  }

  return (
    <div className="absolute inset-0 z-20 flex justify-center bg-black/20 pt-16 dark:bg-black/40">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        onSubmit={submit}
        className="glass-panel flex h-fit w-[480px] flex-col gap-4 rounded-xl p-6 pb-5"
      >
        <div className="flex items-center gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-accent text-white">
            <Mail size={22} />
          </span>
          <div>
            <h2 id="connect-title" className="text-[15px] font-semibold">
              Connect iCloud Mail
            </h2>
            <p className="text-[12px] leading-snug text-ink-2">
              Ordo signs in with an app-specific password, never your Apple ID password.
            </p>
          </div>
        </div>

        <TextField
          ref={first}
          label="Apple ID email"
          type="email"
          autoComplete="username"
          placeholder="you@icloud.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
        />
        <TextField
          label="App-specific password"
          type="password"
          autoComplete="off"
          placeholder="abcd-efgh-ijkl-mnop"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          hint="Create one at account.apple.com, under Sign-In and Security."
        />

        <div className="flex gap-2 rounded-lg bg-selected px-2.5 py-2 text-[12px] leading-snug text-ink-2">
          <ShieldCheck size={14} className="mt-px shrink-0" />
          Saved in your Keychain. Ordo only reads message headers until you choose to clean up.
        </div>

        {result && (
          <p
            role="status"
            className={`flex items-center gap-1.5 text-[12px] ${result.ok ? 'text-ink-2' : 'text-danger'}`}
          >
            {result.ok && <CircleCheck size={14} className="text-success" />}
            {result.ok ? `Signed in as ${result.email}.` : result.message}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button disabled={busy !== null} onClick={() => void run('test')}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
          <span className="flex-1" />
          <Button disabled={busy !== null} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy !== null}>
            {busy === 'connect' ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </form>
    </div>
  )
}
