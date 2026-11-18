import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiError, type CompleteRequest, type ModelProvider } from '@ordo/ai'
import { ASSISTANT_PAGES, type AiSettings, type AssistantEvent } from '@ordo/shared'

// The Electron and AI edges, faked. Everything else (the loop, the tools, the services' shapes) is real.
const state = vi.hoisted(() => ({
  userData: '',
  settings: null as unknown as AiSettings,
  provider: null as unknown as ModelProvider | null,
  resolveModel: async (): Promise<string | undefined> => 'fake-model',
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('../ai', () => ({
  aiSettings: () => state.settings,
  usableProvider: () => state.provider,
  resolveModel: () => state.resolveModel(),
}))
vi.mock('../headless/services', async () => {
  const { fakeServices } = await import('../headless/fake-services')
  const services = fakeServices()
  services.cleanup.history = () => [
    {
      id: 4,
      at: new Date('2026-11-10T10:00:00Z'),
      moved: 2,
      canUndo: true,
      undoneAt: null,
      restored: 0,
      error: null,
      senders: [],
    } as never,
  ]
  return { mainServices: () => services }
})

const { ask, clear, confirm, currentHistory, info, MAX_HISTORY, setCloudConsent, stop } =
  await import('./index')

type Reply = (req: CompleteRequest) => object | Promise<object>

/** A model that answers from a function, so a test can hold it mid-question. */
function model(reply: Reply, kind: 'local' | 'cloud' = 'local') {
  const requests: CompleteRequest[] = []
  const provider: ModelProvider = {
    id: kind === 'local' ? 'lmstudio' : 'claude-cli',
    label: kind === 'local' ? 'LM Studio' : 'Claude Code',
    kind,
    detect: async () => ({ available: true, state: 'ready' }),
    listModels: async () => ['fake-model'],
    complete: async (req) => {
      requests.push(req)
      return { text: JSON.stringify(await reply(req)) }
    },
  }
  state.provider = provider
  return requests
}

/** A stand-in for the window's WebContents. */
function window() {
  const w = Object.assign(new EventEmitter(), {
    events: [] as AssistantEvent[],
    destroyed: false,
    isDestroyed: () => w.destroyed,
    send: (_channel: string, e: AssistantEvent) => void w.events.push(e),
  })
  return w
}
type Win = ReturnType<typeof window>
const asWc = (w: Win) => w as never

const local: AiSettings = {
  provider: 'lmstudio',
  model: 'fake-model',
  sortSenders: false,
  money: false,
  boards: false,
  cloudConsent: null,
}

/** Wait until the window has seen a card, and return its id. */
async function cardOn(w: Win): Promise<string> {
  await vi.waitFor(() => expect(w.events.some((e) => e.type === 'confirm')).toBe(true))
  const card = w.events.find((e) => e.type === 'confirm')
  return (card as Extract<AssistantEvent, { type: 'confirm' }>).id
}

const undoThenAnswer = () => {
  let n = 0
  return () =>
    n++ === 0 ? { type: 'tool', tool: 'ordo_undo', args: { id: 4 } } : { type: 'answer', text: 'Done.' }
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'ordo-assistant-test-'))
  state.settings = local
  state.resolveModel = async () => 'fake-model'
  clear()
})
afterEach(() => clear())

describe('asking', () => {
  it('refuses a second question while one is running', async () => {
    let release!: () => void
    model(() => new Promise((r) => (release = () => r({ type: 'answer', text: 'First.' }))))
    const w = window()
    const first = ask({ text: 'one', page: 'home' }, asWc(w))
    await vi.waitFor(() => expect(info().busy).toBe(true))
    expect(await ask({ text: 'two', page: 'home' }, asWc(w))).toMatchObject({ ok: false, reason: 'busy' })
    release()
    expect(await first).toMatchObject({ ok: true, answer: 'First.' })
    expect(info().busy).toBe(false)
  })

  it('reads an unknown page as Home', async () => {
    const requests = model(() => ({ type: 'answer', text: 'ok' }))
    for (const page of ['__proto__', 'toString', 'constructor', 'file:///etc'])
      await ask({ text: 'hi', page }, asWc(window()))
    for (const r of requests)
      expect(r.system).toContain(`The user is looking at ${ASSISTANT_PAGES.home.about}.`)
  })

  it('keeps the last few questions and answers, cut short, and marks ones built on untrusted data', async () => {
    model((req) => ({
      type: 'answer',
      text: req.prompt.includes('<user_request>q9') ? 'x'.repeat(5000) : 'ok',
    }))
    for (let i = 0; i < 10; i++) await ask({ text: `q${i}`, page: 'home' }, asWc(window()))
    const h = currentHistory()
    expect(h).toHaveLength(MAX_HISTORY)
    expect(h[0]!.user).toBe('q2')
    expect(h.at(-1)!.answer).toHaveLength(2001)
    expect(h.every((t) => t.tainted === false)).toBe(true)

    let n = 0
    model(() =>
      n++ === 0 ? { type: 'tool', tool: 'ordo_senders', args: {} } : { type: 'answer', text: 'Sam.' },
    )
    await ask({ text: 'who emails me?', page: 'home' }, asWc(window()))
    expect(currentHistory().at(-1)).toMatchObject({ user: 'who emails me?', tainted: true })
  })

  it('surfaces a model that can’t be reached instead of hiding it', async () => {
    model(() => ({ type: 'answer', text: 'never' }))
    state.resolveModel = async () => {
      throw new AiError('unavailable', 'LM Studio isn’t running at 127.0.0.1:1234.')
    }
    expect(await ask({ text: 'hi', page: 'home' }, asWc(window()))).toEqual({
      ok: false,
      reason: 'failed',
      message: 'LM Studio isn’t running at 127.0.0.1:1234.',
    })
  })
})

describe('cards', () => {
  it('only the asking window can answer, only the open card, and only once', async () => {
    model(undoThenAnswer())
    const w = window()
    const other = window()
    const run = ask({ text: 'Undo clean-up 4', page: 'home' }, asWc(w))
    const id = await cardOn(w)
    confirm({ id: 'not-a-card', approve: true }, asWc(w))
    confirm({ id, approve: true }, asWc(other))
    expect(info().busy).toBe(true)
    confirm({ id, approve: false }, asWc(w))
    confirm({ id, approve: true }, asWc(w)) // too late: already answered
    expect(await run).toMatchObject({ ok: false, reason: 'cancelled' })
  })

  it('Stop while a card is open cancels it', async () => {
    model(undoThenAnswer())
    const w = window()
    const run = ask({ text: 'Undo clean-up 4', page: 'home' }, asWc(w))
    const id = await cardOn(w)
    stop()
    expect(await run).toMatchObject({ ok: false, reason: 'stopped' })
    expect(w.events).toContainEqual({ type: 'confirmed', id, approved: false })
  })

  it('a card nobody answers times out as Cancel', async () => {
    model(undoThenAnswer())
    const outcome = await ask({ text: 'Undo clean-up 4', page: 'home' }, asWc(window()), {
      confirmTimeoutMs: 10,
    })
    expect(outcome).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(info().busy).toBe(false)
  })
})

describe('the window going away', () => {
  it.each(['destroyed', 'render-process-gone'])(
    '%s stops the run and forgets the conversation',
    async (event) => {
      model(() => ({ type: 'answer', text: 'ok' }))
      await ask({ text: 'earlier', page: 'home' }, asWc(window()))
      expect(currentHistory()).toHaveLength(1)
      model(undoThenAnswer())
      const w = window()
      const run = ask({ text: 'Undo clean-up 4', page: 'home' }, asWc(w))
      await cardOn(w)
      w.emit(event)
      expect(await run).toMatchObject({ ok: false, reason: 'stopped' })
      expect(currentHistory()).toHaveLength(0)
      expect(info().busy).toBe(false)
    },
  )

  it('a reload stops it, but a page change inside the app does not', async () => {
    model(undoThenAnswer())
    const w = window()
    const run = ask({ text: 'Undo clean-up 4', page: 'home' }, asWc(w))
    const id = await cardOn(w)
    w.emit('did-start-navigation', { isSameDocument: true, isMainFrame: true })
    expect(info().busy).toBe(true)
    w.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true })
    expect(await run).toMatchObject({ ok: false, reason: 'stopped' })
    expect(w.events).toContainEqual({ type: 'confirmed', id, approved: false })
  })

  it('Clear during a run stops it and keeps nothing from it', async () => {
    let release!: () => void
    model(() => new Promise((r) => (release = () => r({ type: 'answer', text: 'Late.' }))))
    const run = ask({ text: 'one', page: 'home' }, asWc(window()))
    await vi.waitFor(() => expect(info().busy).toBe(true))
    clear()
    release()
    expect(await run).toMatchObject({ ok: false, reason: 'stopped' })
    expect(currentHistory()).toHaveLength(0)
  })
})

describe('cloud consent for the assistant', () => {
  const cloud: AiSettings = {
    provider: 'claude-cli',
    model: 'haiku',
    sortSenders: true,
    money: true,
    boards: false,
    cloudConsent: 'claude-cli',
  }

  it('sends nothing to a cloud model until the user agrees, separately from AI sorting', async () => {
    state.settings = cloud
    const requests = model(() => ({ type: 'answer', text: 'ok' }), 'cloud')
    expect(info()).toMatchObject({
      ready: true,
      kind: 'cloud',
      cloud: {
        vendor: 'Anthropic',
        consent: false,
        sends: expect.stringContaining('transactions with amounts and dates'),
      },
    })
    expect(await ask({ text: 'hi', page: 'home' }, asWc(window()))).toEqual({
      ok: false,
      reason: 'consent',
      message: 'The assistant needs your OK before it sends anything to Anthropic.',
    })
    expect(requests).toHaveLength(0)

    expect(setCloudConsent({ allow: true }).cloud?.consent).toBe(true)
    expect(await ask({ text: 'hi', page: 'home' }, asWc(window()))).toMatchObject({ ok: true })
    expect(requests).toHaveLength(1)

    expect(setCloudConsent({ allow: false }).cloud?.consent).toBe(false)
    expect(await ask({ text: 'hi', page: 'home' }, asWc(window()))).toMatchObject({ reason: 'consent' })
  })

  it('consent is for one provider: switching to another asks again', async () => {
    state.settings = cloud
    model(() => ({ type: 'answer', text: 'ok' }), 'cloud')
    setCloudConsent({ allow: true })
    state.settings = { ...cloud, provider: 'codex-cli', cloudConsent: 'codex-cli' }
    expect(info().cloud).toMatchObject({ vendor: 'OpenAI', consent: false })
  })

  it('local models need no consent, and none is recorded for them', async () => {
    model(() => ({ type: 'answer', text: 'ok' }))
    expect(info().cloud).toBeUndefined()
    expect(setCloudConsent({ allow: true }).cloud).toBeUndefined()
    expect(await ask({ text: 'hi', page: 'home' }, asWc(window()))).toMatchObject({ ok: true })
  })
})
