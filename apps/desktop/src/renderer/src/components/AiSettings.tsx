import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { CircleCheck, Cloud, Cpu, Laptop, RefreshCw, ShieldAlert } from 'lucide-react'
import {
  AI_PROVIDERS,
  isCloudProvider,
  type AiProviderId,
  type AiProviderStatus,
  type AiSettings,
  type AiTestResult,
} from '@ordo/shared'
import { Button } from './Button'
import { Row, Section } from './SettingsSection'
import { Switch } from './Switch'

interface Props {
  ai: AiSettings
  onSave: (ai: AiSettings) => Promise<void>
}

type Choice = AiProviderId | 'none'

const dotColour = (s: AiProviderStatus | undefined) =>
  !s
    ? 'bg-ink-3'
    : s.available
      ? 'bg-success'
      : s.state === 'not-installed'
        ? 'bg-ink-3'
        : 'bg-[var(--promotions)]'

const vendorOf = (id: AiProviderId) => AI_PROVIDERS.find((p) => p.id === id)!

/** Settings → AI: choose a local model or a CLI you're signed in to, test it, and turn sorting on. */
export function AiSettings({ ai, onSave }: Props) {
  const [statuses, setStatuses] = useState<AiProviderStatus[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirming, setConfirming] = useState<AiProviderId | null>(null)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<AiTestResult | null>(null)
  const groupLabel = useId()

  const check = useCallback(async (refresh: boolean) => {
    setChecking(true)
    try {
      setStatuses(await window.ordo.ai.status(refresh))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    let live = true
    void window.ordo.ai.status().then((s) => live && setStatuses(s))
    return () => {
      live = false
    }
  }, [])

  const statusOf = (id: AiProviderId) => statuses?.find((s) => s.id === id)
  const current = ai.provider === 'none' ? undefined : statusOf(ai.provider)
  const model = ai.model ?? current?.recommended ?? null

  const save = async (next: AiSettings) => {
    setResult(null)
    await onSave(next)
  }

  const choose = (id: Choice) => {
    if (id === ai.provider) return
    if (id === 'none') return void save({ ...ai, provider: 'none', model: null, cloudConsent: null })
    if (isCloudProvider(id)) return setConfirming(id)
    void save({ ...ai, provider: id, model: statusOf(id)?.recommended ?? null, cloudConsent: null })
  }

  const confirm = (id: AiProviderId) => {
    setConfirming(null)
    void save({ ...ai, provider: id, model: statusOf(id)?.recommended ?? null, cloudConsent: id })
  }

  const runTest = async () => {
    if (ai.provider === 'none') return
    setTesting(true)
    setResult(null)
    try {
      setResult(await window.ordo.ai.test({ provider: ai.provider, model }))
    } finally {
      setTesting(false)
    }
  }

  const models = current?.models.length ? current.models : model ? [model] : []
  const cloud = ai.provider !== 'none' && isCloudProvider(ai.provider)

  return (
    <Section title="AI">
      <Row
        label="Sort with a model"
        detail="Ordo can ask a model to sort senders its rules aren't sure about. It sees sender names, addresses and subject lines, never message bodies."
        control={
          <Button icon={<RefreshCw size={13} />} disabled={checking} onClick={() => void check(true)}>
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        }
      />

      <div role="radiogroup" aria-labelledby={groupLabel} className="border-b border-sep py-1">
        <span id={groupLabel} className="sr-only">
          AI provider
        </span>
        <ProviderOption
          id="none"
          label="Off"
          detail="Sort with rules only"
          icon={<span className="size-2 shrink-0 translate-y-[-1px] rounded-full bg-ink-3" />}
          checked={ai.provider === 'none'}
          onChoose={choose}
        />
        {AI_PROVIDERS.map((p) => {
          const s = statusOf(p.id)
          return (
            <ProviderOption
              key={p.id}
              id={p.id}
              label={p.label}
              detail={s ? s.detail : 'Checking…'}
              dot={dotColour(s)}
              tag={
                p.kind === 'local' ? (
                  <span className="flex items-center gap-1">
                    <Laptop size={12} /> On this computer
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Cloud size={12} /> {p.vendor} · your account{p.experimental ? ' · experimental' : ''}
                  </span>
                )
              }
              checked={ai.provider === p.id}
              onChoose={choose}
            />
          )
        })}
      </div>

      {ai.provider !== 'none' && (
        <>
          <Row
            label="Model"
            detail={
              ai.provider === 'lmstudio' || ai.provider === 'ollama'
                ? 'gpt-oss-20b is recommended: accurate and fast enough on a laptop.'
                : undefined
            }
            control={
              <select
                aria-label="Model"
                value={model ?? ''}
                disabled={!models.length}
                onChange={(e) => void save({ ...ai, model: e.target.value })}
                className="no-drag h-7 max-w-64 rounded-md border border-sep bg-field px-2 text-[13px] text-ink outline-none focus:border-accent"
              >
                {!models.length && <option value="">No models</option>}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m === 'default' ? 'Account default' : m}
                  </option>
                ))}
              </select>
            }
          />
          <Row
            label="Test"
            detail={<TestResult testing={testing} result={result} />}
            control={
              <Button disabled={testing} onClick={() => void runTest()}>
                {testing ? 'Testing…' : 'Test'}
              </Button>
            }
          />
          <Row
            label="Use AI to sort senders Ordo isn't sure about"
            detail="People you've written to are never changed."
            control={
              <Switch
                label="Use AI to sort senders Ordo isn't sure about"
                checked={ai.sortSenders}
                onChange={(on) => void save({ ...ai, sortSenders: on })}
              />
            }
          />
          <Row
            label="Use AI for Money (categories and bill matching)"
            detail="For merchants left in Other and bank payments the rules couldn't match to an email: the merchant's name, a short description without numbers and a rough amount like £10–£20. Never balances, account details or dates. Categories you choose yourself always win."
            control={
              <Switch
                label="Use AI for Money (categories and bill matching)"
                checked={ai.money}
                onChange={(on) => void save({ ...ai, money: on })}
              />
            }
          />
          <div className="flex items-start gap-2 px-4 py-2.5 text-[12px] leading-snug text-ink-2">
            {cloud ? (
              <Cloud size={14} className="mt-px shrink-0" />
            ) : (
              <Cpu size={14} className="mt-px shrink-0" />
            )}
            {cloud
              ? `Sender names, addresses and subject lines${ai.money ? ', and merchant names with rough amounts,' : ''} are sent to ${vendorOf(ai.provider as AiProviderId).vendor} under your own account.`
              : 'Stays on this computer.'}
          </div>
        </>
      )}

      {confirming && (
        <CloudConfirm
          id={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={() => confirm(confirming)}
        />
      )}
    </Section>
  )
}

function ProviderOption(props: {
  id: Choice
  label: string
  detail: string
  dot?: string
  icon?: ReactNode
  tag?: ReactNode
  checked: boolean
  onChoose: (id: Choice) => void
}) {
  const labelId = useId()
  const detailId = useId()
  return (
    <label className="flex cursor-default items-center gap-3 px-4 py-1.5 hover:bg-hover">
      <input
        type="radio"
        name="ai-provider"
        aria-labelledby={labelId}
        aria-describedby={detailId}
        checked={props.checked}
        onChange={() => props.onChoose(props.id)}
        className="no-drag size-4 accent-[var(--accent)]"
      />
      <div className="flex-1">
        <div id={labelId} className="text-[13px] font-medium">
          {props.label}
        </div>
        <div id={detailId} className="flex items-baseline gap-1.5 text-[12px] text-ink-2">
          {props.icon ?? <span className={`size-2 shrink-0 translate-y-[-1px] rounded-full ${props.dot}`} />}
          {props.detail}
        </div>
      </div>
      {props.tag && <div className="text-[11px] text-ink-2">{props.tag}</div>}
    </label>
  )
}

function TestResult({ testing, result }: { testing: boolean; result: AiTestResult | null }) {
  if (testing) return <span role="status">Asking the model to say hello…</span>
  if (!result) return 'Sends a tiny prompt and shows the reply.'
  if (!result.ok)
    return (
      <span role="status" className="text-danger">
        {result.message}
      </span>
    )
  return (
    <span role="status" className="flex items-start gap-1.5">
      <CircleCheck size={14} className="mt-px shrink-0 text-success" />
      <span>
        <span className="text-ink">“{result.reply}”</span> · {(result.latencyMs / 1000).toFixed(1)} s
      </span>
    </span>
  )
}

function CloudConfirm({
  id,
  onCancel,
  onConfirm,
}: {
  id: AiProviderId
  onCancel: () => void
  onConfirm: () => void
}) {
  const info = vendorOf(id)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-30 flex justify-center bg-black/20 pt-24 dark:bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-confirm-title"
        aria-describedby="cloud-confirm-body"
        className="glass-panel flex h-fit w-[460px] flex-col gap-4 rounded-xl p-6 pb-5"
      >
        <div className="flex items-center gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-accent text-white">
            <Cloud size={22} />
          </span>
          <h2 id="cloud-confirm-title" className="text-[15px] font-semibold">
            Send sender details to {info.vendor}?
          </h2>
        </div>
        <div id="cloud-confirm-body" className="flex flex-col gap-2 text-[13px] leading-snug text-ink-2">
          <p>
            Sender names, addresses and subject lines will be sent to {info.vendor} under your own account,
            through {info.label}. Message bodies are never sent. Your account's terms and data settings apply.
          </p>
          <p>
            If you also turn on AI for Money, merchant names, short descriptions and rough amounts go too,
            never balances, account details or dates.
          </p>
          <p>Local models through LM Studio or Ollama keep everything on this computer.</p>
        </div>
        {info.experimental && (
          <div className="flex gap-2 rounded-lg bg-selected px-2.5 py-2 text-[12px] leading-snug text-ink-2">
            <ShieldAlert size={14} className="mt-px shrink-0" />
            Experimental: {info.label} is an agent that can run tools. Ordo turns its tools off and runs it in
            an empty folder, but can't guarantee none remain.
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button autoFocus onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Use {info.label}
          </Button>
        </div>
      </div>
    </div>
  )
}
