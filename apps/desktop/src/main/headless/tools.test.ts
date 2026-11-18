import { describe, expect, it, vi } from 'vitest'
import { CHANGE_COMMANDS } from './args'
import { fakeServices } from './fake-services'
import { previewTool, runTool, strictArgs, toolByName, TOOLS } from './tools'

const t = (name: string) => toolByName(name)!
const allow = { allowChanges: true, confirm: true }

describe('the tool registry', () => {
  it('has unique ordo_ names, a label and a description for every tool', () => {
    const names = TOOLS.map((x) => x.name)
    expect(new Set(names).size).toBe(names.length)
    for (const x of TOOLS) {
      expect(x.name).toMatch(/^ordo_[a-z_]+$/)
      expect(x.label.length).toBeGreaterThan(3)
      expect(x.description.length).toBeGreaterThan(20)
    }
  })

  it('marks every headless change command as a change tool, with a preview and intent words', () => {
    for (const x of TOOLS) {
      if (x.command) expect(x.kind === 'change').toBe(CHANGE_COMMANDS.has(x.command))
      if (x.kind === 'change') {
        expect(x.preview).toBeTypeOf('function')
        expect(x.intent).toBeInstanceOf(RegExp)
      }
    }
    const covered = TOOLS.filter((x) => x.kind === 'change').map((x) => x.command)
    expect(new Set(covered)).toEqual(CHANGE_COMMANDS)
  })

  it('never lets a model pass confirm: it is not an argument of any tool', () => {
    for (const x of TOOLS) {
      expect(Object.keys(x.input)).not.toContain('confirm')
      expect(strictArgs(x).safeParse({ confirm: true }).success).toBe(false)
    }
  })
})

describe('runTool', () => {
  it('runs a read tool with defaults filled in', async () => {
    const r = await runTool(fakeServices(), t('ordo_senders'), {}, { allowChanges: false, confirm: false })
    expect(r).toMatchObject({ ok: true, data: { total: 2, shown: 2 } })
  })

  it('refuses a change without permission or confirmation, and calls nothing', async () => {
    const services = fakeServices()
    expect(
      await runTool(services, t('ordo_undo'), { id: 2 }, { allowChanges: false, confirm: true }),
    ).toMatchObject({ ok: false, code: 'changes_not_allowed' })
    expect(
      await runTool(services, t('ordo_undo'), { id: 2 }, { allowChanges: true, confirm: false }),
    ).toMatchObject({ ok: false, code: 'confirm_required' })
    expect(services.cleanup.undo).not.toHaveBeenCalled()
    expect(await runTool(services, t('ordo_undo'), { id: 2 }, allow)).toMatchObject({ ok: true })
    expect(services.cleanup.undo).toHaveBeenCalledWith(2)
  })

  it('turns bad arguments into a usage error', async () => {
    const r = await runTool(fakeServices(), t('ordo_undo'), { id: 'x' }, allow)
    expect(r).toMatchObject({ ok: false, code: 'usage' })
    const cli = await runTool(
      fakeServices(),
      t('ordo_calendar_events'),
      { from: '2026-12-01', to: '2026-11-01' },
      allow,
    )
    expect(cli).toEqual({ ok: false, code: 'usage', message: '--to must be on or after --from' })
  })

  it('hides unexpected errors behind a fixed message', async () => {
    const services = fakeServices()
    services.money.overview = async () => {
      throw new Error('/secret/path exploded')
    }
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const r = await runTool(services, t('ordo_bills'), {}, allow)
    write.mockRestore()
    expect(r).toEqual({ ok: false, code: 'internal', message: 'Something went wrong inside Ordo.' })
  })
})

describe('change previews', () => {
  it('shows a clean-up plan from Ordo’s own dry run, with what was left out', async () => {
    const services = fakeServices()
    services.cleanup.plan = vi.fn(() => ({
      ok: true as const,
      plan: {
        senders: [
          {
            address: 'digest@news.example',
            name: 'Daily Digest',
            category: 'newsletters' as const,
            count: 12,
            unsubscribe: { kind: 'one-click' as const, url: 'https://news.example/u', post: 'x' },
            insecureLinkConfirmed: false,
            mailto: null,
            trash: true,
          },
        ],
        rejected: [{ address: 'sam@friend.example', reason: 'You’ve written to this person' }],
      },
    })) as never
    const p = await previewTool(services, t('ordo_cleanup_run'), {
      senders: ['digest@news.example', 'sam@friend.example'],
    })
    expect(p.title).toBe('Move 12 emails to Trash and unsubscribe from 1 sender')
    expect(p.details).toEqual([
      'Daily Digest <digest@news.example>: 12 emails to Trash, unsubscribe in one click',
    ])
    expect(p.notes[0]).toBe('Left out sam@friend.example: You’ve written to this person.')
    expect(p.blocked).toBeUndefined()
  })

  it('blocks a clean-up when nothing in it can be cleared', async () => {
    const p = await previewTool(fakeServices(), t('ordo_cleanup_run'), { senders: ['x@y.example'] })
    expect(p.blocked).toBe('None of these senders can be cleared.')
  })

  it('describes an import from the file itself', async () => {
    const p = await previewTool(fakeServices(), t('ordo_import_statement'), { path: '/tmp/monzo.csv' })
    expect(p).toMatchObject({
      title: 'Import 3 transactions into Monzo',
      details: ['File: /tmp/monzo.csv', 'Monzo statement, 2026-10-01 to 2026-10-31'],
    })
  })

  it('blocks an undo of a clean-up that does not exist', async () => {
    const p = await previewTool(fakeServices(), t('ordo_undo'), { id: 9 })
    expect(p.blocked).toBe('There’s no clean-up 9.')
  })

  it('says where AI sorting sends data, and blocks without a model', async () => {
    const off = await previewTool(fakeServices(), t('ordo_ai_sort'), {})
    expect(off.blocked).toBe('Choose a model in Settings → AI first.')
    const services = fakeServices()
    services.ai.settings = () => ({
      provider: 'claude-cli',
      model: null,
      sortSenders: true,
      money: false,
      cloudConsent: 'claude-cli',
    })
    const cloud = await previewTool(services, t('ordo_ai_sort'), {})
    expect(cloud.details).toEqual([
      'Sender names, addresses and subject lines go to Anthropic under your own account.',
    ])
    const money = await previewTool(services, t('ordo_money_sort'), {})
    expect(money.blocked).toBe('Turn on AI for Money in Settings → AI first.')
  })

  it('a bad argument blocks the card instead of throwing', async () => {
    const p = await previewTool(fakeServices(), t('ordo_undo'), { id: -1 })
    expect(p.blocked).toMatch(/couldn’t work out/)
  })
})
