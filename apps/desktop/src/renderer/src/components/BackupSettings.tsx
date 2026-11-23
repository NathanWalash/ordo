import { useCallback, useEffect, useId, useState } from 'react'
import {
  ArchiveRestore,
  CircleAlert,
  CircleCheck,
  HardDriveUpload,
  KeyRound,
  ShieldCheck,
} from 'lucide-react'
import {
  BACKUP_KEEP_CHOICES,
  MIN_PASSPHRASE_LENGTH,
  RESTORE_CONFIRM_WORD,
  type BackupActionResult,
  type BackupStatus,
  type RestorePreview,
} from '@ordo/shared'
import { Button } from './Button'
import { Row, Section } from './SettingsSection'
import { Sheet } from './Sheet'
import { Switch } from './Switch'
import { TextField } from './TextField'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** Settings → Backup: an encrypted copy of Ordo's data in a folder you choose, and restoring one. */
export function BackupSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'passphrase' | 'unlock' | 'restore' | null>(null)
  const [running, setRunning] = useState(false)

  const refresh = useCallback(async () => setStatus(await window.ordo.backup.status()), [])
  useEffect(() => {
    let live = true
    void window.ordo.backup.status().then((s) => live && setStatus(s))
    return () => {
      live = false
    }
  }, [])

  const apply = (r: BackupActionResult) => {
    if (r.ok) {
      setStatus(r.status)
      setError(null)
    } else setError(r.message)
  }

  /** Back up; resolves with a message for the passphrase sheet when the typed one is wrong. */
  const backUpNow = async (passphrase?: string): Promise<string | undefined> => {
    setRunning(true)
    setError(null)
    try {
      const r = await window.ordo.backup.run(passphrase === undefined ? {} : { passphrase })
      if (!r.ok && r.error === 'needs-passphrase') {
        setSheet('unlock')
        return undefined
      }
      if (!r.ok && r.error === 'wrong-passphrase') return r.message
      if (!r.ok) setError(r.message)
      if (passphrase !== undefined) setSheet(null)
    } finally {
      setRunning(false)
      await refresh()
    }
    return undefined
  }

  if (!status) return null
  const ready = status.folder !== null && status.passphraseSet
  const last = status.last

  return (
    <Section title="Backup">
      <Row
        label="Backup folder"
        detail={
          status.folder ?? (
            <>
              Choose a folder iCloud Drive, Google Drive or Dropbox syncs. Ordo saves one encrypted file
              there, so the cloud only ever sees scrambled data.
            </>
          )
        }
        control={
          <Button onClick={() => void window.ordo.backup.chooseFolder().then(apply)}>
            {status.folder ? 'Change…' : 'Choose…'}
          </Button>
        }
      />
      <Row
        label="Passphrase"
        detail={
          status.passphraseSet
            ? status.remembered
              ? 'Set, and remembered in this computer’s keychain.'
              : 'Set. Not remembered: Ordo asks for it after each restart.'
            : 'Backups are locked with a passphrase. Without it nobody, including you, can open them, so keep it somewhere safe.'
        }
        control={
          <span className="flex gap-2">
            {status.remembered && (
              <Button onClick={() => void window.ordo.backup.forgetPassphrase().then(apply)}>Forget</Button>
            )}
            <Button
              variant={status.passphraseSet ? 'secondary' : 'primary'}
              onClick={() => setSheet('passphrase')}
            >
              {status.passphraseSet ? 'Change…' : 'Set passphrase…'}
            </Button>
          </span>
        }
      />
      <Row
        label="Back up automatically"
        detail={
          status.auto && ready && !status.unlocked
            ? 'Waiting for your passphrase: back up now once to resume until Ordo quits.'
            : 'Once a day while Ordo is open, and when you quit if the last backup is more than a day old.'
        }
        control={
          <Switch
            label="Back up automatically"
            checked={status.auto}
            onChange={(auto) => void window.ordo.backup.update({ auto }).then(apply)}
          />
        }
      />
      <Row
        label="Keep"
        detail="Older backups Ordo made in this folder go to the Trash. Other files are never touched."
        control={
          <select
            aria-label="Backups to keep"
            value={status.keep}
            onChange={(e) =>
              void window.ordo.backup
                .update({ keep: Number(e.target.value) as (typeof BACKUP_KEEP_CHOICES)[number] })
                .then(apply)
            }
            className="no-drag h-7 rounded-md border border-sep bg-field px-2 text-[13px] text-ink outline-none focus:border-accent"
          >
            {BACKUP_KEEP_CHOICES.map((n) => (
              <option key={n} value={n}>
                Last {n}
              </option>
            ))}
            {!(BACKUP_KEEP_CHOICES as readonly number[]).includes(status.keep) && (
              <option value={status.keep}>Last {status.keep}</option>
            )}
          </select>
        }
      />
      <Row
        label="Last backup"
        detail={
          <span role="status" className="flex items-start gap-1.5">
            {running || status.running ? (
              'Backing up…'
            ) : error ? (
              <span className="text-danger">{error}</span>
            ) : !last ? (
              'None yet.'
            ) : last.ok ? (
              <>
                <CircleCheck size={13} className="mt-px shrink-0 text-success" />
                {when(last.at)} · {formatBytes(last.size)}
              </>
            ) : (
              <>
                <CircleAlert size={13} className="mt-px shrink-0 text-danger" />
                <span>
                  {when(last.at)}: {last.message}
                  {status.lastSuccessAt && ` Last successful backup ${when(status.lastSuccessAt)}.`}
                </span>
              </>
            )}
          </span>
        }
        control={
          <Button
            icon={<HardDriveUpload size={13} />}
            disabled={!ready || running || status.running}
            onClick={() => void backUpNow()}
          >
            Back Up Now
          </Button>
        }
      />
      <Row
        label="Passwords aren’t backed up"
        detail="Your iCloud app-specific password stays in this computer’s keychain. After restoring on another computer, connect iCloud again."
      />
      <Row
        label="Restore from a backup"
        detail="Replaces all of Ordo’s data with a backup. Your current data is moved aside, never deleted."
        control={
          <Button icon={<ArchiveRestore size={13} />} onClick={() => setSheet('restore')}>
            Restore…
          </Button>
        }
      />

      {sheet === 'passphrase' && (
        <PassphraseSheet
          status={status}
          onClose={() => setSheet(null)}
          onSaved={(s) => {
            setStatus(s)
            setError(null)
            setSheet(null)
          }}
        />
      )}
      {sheet === 'unlock' && (
        <UnlockSheet onClose={() => setSheet(null)} onSubmit={(p) => backUpNow(p)} busy={running} />
      )}
      {sheet === 'restore' && <RestoreSheet onClose={() => setSheet(null)} />}
    </Section>
  )
}

function PassphraseSheet({
  status,
  onClose,
  onSaved,
}: {
  status: BackupStatus
  onClose: () => void
  onSaved: (s: BackupStatus) => void
}) {
  const [current, setCurrent] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [again, setAgain] = useState('')
  const [remember, setRemember] = useState(status.canRemember)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rememberId = useId()

  const save = async () => {
    if (status.passphraseSet && !current) return setError('Enter your current passphrase.')
    if (passphrase.length < MIN_PASSPHRASE_LENGTH)
      return setError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words work well.`)
    if (passphrase !== again) return setError('The two passphrases don’t match.')
    setBusy(true)
    try {
      const r = await window.ordo.backup.setPassphrase({
        passphrase,
        remember,
        ...(status.passphraseSet ? { current } : {}),
      })
      if (r.ok) onSaved(r.status)
      else setError(r.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={status.passphraseSet ? 'Change backup passphrase' : 'Set a backup passphrase'}
      subtitle="Every backup is encrypted with it. Ordo can’t recover it for you."
      icon={<KeyRound size={22} />}
      onClose={onClose}
      onSubmit={() => void save()}
      busy={busy}
      footer={
        <>
          <span className="flex-1" />
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      {status.passphraseSet && (
        <TextField
          label="Current passphrase"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      )}
      <TextField
        label={status.passphraseSet ? 'New passphrase' : 'Passphrase'}
        type="password"
        autoComplete="new-password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        hint={`At least ${MIN_PASSPHRASE_LENGTH} characters.`}
      />
      <TextField
        label="Type it again"
        type="password"
        autoComplete="new-password"
        value={again}
        onChange={(e) => setAgain(e.target.value)}
      />
      <label htmlFor={rememberId} className="flex items-start gap-2 text-[13px]">
        <input
          id={rememberId}
          type="checkbox"
          checked={remember}
          disabled={!status.canRemember}
          onChange={(e) => setRemember(e.target.checked)}
          className="mt-0.5 size-3.5 accent-[var(--accent)]"
        />
        <span>
          Remember on this computer
          <span className="block text-[11px] leading-snug text-ink-2">
            Kept in the keychain, so automatic backups carry on after Ordo restarts. Otherwise Ordo asks once
            each time it opens.
          </span>
        </span>
      </label>
      {status.passphraseSet && (
        <p className="text-[12px] leading-snug text-ink-2">
          Backups you already have still open with the passphrase they were made with.
        </p>
      )}
      <p role="alert" className="text-[12px] leading-snug text-danger empty:hidden">
        {error}
      </p>
    </Sheet>
  )
}

function UnlockSheet({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void
  onSubmit: (passphrase: string) => Promise<string | undefined>
  busy: boolean
}) {
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async () => setError((await onSubmit(passphrase)) ?? null)
  return (
    <Sheet
      title="Enter your backup passphrase"
      subtitle="Ordo keeps it until it quits, for this and the automatic backups."
      icon={<KeyRound size={22} />}
      onClose={onClose}
      onSubmit={() => void submit()}
      busy={busy}
      footer={
        <>
          <span className="flex-1" />
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !passphrase}>
            {busy ? 'Backing up…' : 'Back Up'}
          </Button>
        </>
      }
    >
      <TextField
        label="Passphrase"
        type="password"
        autoComplete="current-password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        error={error ?? undefined}
      />
    </Sheet>
  )
}

type RestoreStep =
  { step: 'pick' } | { step: 'passphrase'; fileName: string } | { step: 'preview'; preview: RestorePreview }

/**
 * Restore in steps: choose a file, unlock it (Ordo decrypts and checks it, changing nothing),
 * read what's in it, then type "restore" and confirm.
 */
function RestoreSheet({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<RestoreStep>({ step: 'pick' })
  const [passphrase, setPassphrase] = useState('')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    void window.ordo.backup.restoreCancel()
    onClose()
  }

  const pick = async () => {
    setError(null)
    const r = await window.ordo.backup.restorePick()
    if (r.ok) setState({ step: 'passphrase', fileName: r.fileName })
  }

  const open = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.ordo.backup.restoreOpen({ passphrase })
      if (r.ok) setState({ step: 'preview', preview: r.preview })
      else setError(r.message)
    } finally {
      setBusy(false)
    }
  }

  const confirm = async () => {
    if (state.step !== 'preview' || typed.trim().toLowerCase() !== RESTORE_CONFIRM_WORD) return
    setBusy(true)
    setError(null)
    // Resolves only if the restore couldn't go ahead; otherwise Ordo restarts.
    const r = await window.ordo.backup.restoreConfirm({ id: state.preview.id, confirm: RESTORE_CONFIRM_WORD })
    setBusy(false)
    setError(r.message)
  }

  const submit = () => {
    if (state.step === 'pick') void pick()
    else if (state.step === 'passphrase') void open()
    else void confirm()
  }

  const confirmed = typed.trim().toLowerCase() === RESTORE_CONFIRM_WORD

  return (
    <Sheet
      title="Restore from a backup"
      subtitle={
        state.step === 'preview'
          ? 'Check this is the backup you want.'
          : 'Ordo checks the backup before anything changes.'
      }
      icon={<ArchiveRestore size={22} />}
      iconTone={state.step === 'preview' ? 'warning' : 'accent'}
      width={520}
      onClose={close}
      onSubmit={submit}
      busy={busy}
      footer={
        <>
          <span className="flex-1" />
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          {state.step === 'pick' && (
            <Button type="submit" variant="primary">
              Choose Backup…
            </Button>
          )}
          {state.step === 'passphrase' && (
            <Button type="submit" variant="primary" disabled={busy || !passphrase}>
              {busy ? 'Checking…' : 'Open Backup'}
            </Button>
          )}
          {state.step === 'preview' && (
            <Button type="submit" variant="destructive" disabled={busy || !confirmed}>
              {busy ? 'Restoring…' : 'Restore and Restart'}
            </Button>
          )}
        </>
      }
    >
      {state.step === 'pick' && (
        <p className="text-[13px] leading-snug">
          Choose an Ordo backup file (it ends in .ordobackup). If it’s in a cloud folder, make sure it has
          finished downloading.
        </p>
      )}

      {state.step === 'passphrase' && (
        <>
          <p className="text-[13px] leading-snug">
            <span className="font-medium">{state.fileName}</span>
          </p>
          <TextField
            label="Backup passphrase"
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            hint="The passphrase this backup was made with."
          />
        </>
      )}

      {state.step === 'preview' && (
        <RestorePreviewView preview={state.preview} typed={typed} onType={setTyped} />
      )}

      <p role="alert" className="text-[12px] leading-snug text-danger empty:hidden">
        {error}
      </p>
    </Sheet>
  )
}

function RestorePreviewView({
  preview,
  typed,
  onType,
}: {
  preview: RestorePreview
  typed: string
  onType: (s: string) => void
}) {
  return (
    <>
      <div className="rounded-lg border border-sep px-3 py-2 text-[13px]">
        <div className="font-medium">Backup from {when(preview.createdAt)}</div>
        <div className="text-[12px] text-ink-2">
          {preview.fileName} · made by Ordo {preview.appVersion}
        </div>
        <ul className="mt-2 flex flex-col gap-0.5 text-[12px]">
          {preview.files.map((f) => (
            <li key={f.name} className="flex justify-between gap-4">
              <span>{f.label}</span>
              <span className="shrink-0 text-ink-2">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2 rounded-lg bg-selected px-2.5 py-2 text-[12px] leading-snug text-ink-2">
        <ShieldCheck size={14} className="mt-px shrink-0" />
        <span>
          {preview.keepsAccount
            ? 'You’ll stay connected to iCloud on this computer.'
            : 'Passwords aren’t in backups, so connect iCloud again after restoring.'}
        </span>
      </div>
      <p className="text-[13px] leading-snug">
        Restoring <span className="font-semibold">replaces all of Ordo’s data on this computer</span> with
        this backup: mail Ordo has downloaded, calendars, money, boards and settings. Anything you’ve done
        since {when(preview.createdAt)} won’t be in Ordo afterwards. Your current data is moved to{' '}
        <span className="break-all font-medium">{preview.asideFolder}</span>, not deleted. Ordo then restarts.
      </p>
      <TextField
        label={`Type “${RESTORE_CONFIRM_WORD}” to confirm`}
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(e) => onType(e.target.value)}
      />
    </>
  )
}
