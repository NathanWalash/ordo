import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { parseInvocation, UsageError } from './args'
import { runCli, type CliIo } from './cli'
import { runCommand } from './commands'
import { fakeServices } from './fake-services'
import { createMcpServer } from './mcp'
import { previewTool, runTool, toolByName, TOOLS } from './tools'

async function cli(services: ReturnType<typeof fakeServices>, ...args: string[]) {
  const inv = parseInvocation(args)
  if (inv.kind === 'mcp') throw new Error('not here')
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (t) => void out.push(t), err: (t) => void err.push(t), errIsTTY: false }
  const code = await runCli(inv, services, io)
  return { code, stdout: out.join(''), stderr: err.join('') }
}

describe('money memory commands', () => {
  it('parse, with the question and fact ids as positional arguments', () => {
    expect(
      parseInvocation(['money', 'answer', 'person:gabe', '--answer', 'flatmate', '--confirm']),
    ).toMatchObject({
      command: { name: 'money answer', question: 'person:gabe', answer: 'flatmate', confirm: true },
    })
    expect(parseInvocation(['money', 'compare', '--category', 'Home'])).toMatchObject({
      command: { name: 'money compare', category: 'Home' },
    })
    expect(() => parseInvocation(['money', 'answer', 'person:gabe'])).toThrow(UsageError)
    expect(() => parseInvocation(['money', 'knows', '--answer', 'x'])).toThrow(UsageError)
  })

  it('money knows lists facts and how banks date payments', async () => {
    const r = await cli(fakeServices(), 'money', 'knows')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('f1  held  Money from Gabe is rent you hold for Patrick, not your income.')
    expect(r.stdout).toContain('HSBC shows the day a payment cleared.')
  })

  it('money loose-ends says what is held and owed, in pounds for people and pence in JSON', async () => {
    const human = await cli(fakeServices(), 'money', 'loose-ends')
    expect(human.stdout).toBe(
      "Holding £298.50 of Gabe's money for Patrick (not passed on yet)\nSomeone owes you £30.00 for Halloween\n",
    )
    const json = JSON.parse((await cli(fakeServices(), 'money', 'loose-ends', '--json')).stdout)
    expect(json.held[0]).toMatchObject({ from: 'Gabe', for: 'Patrick', holdingPence: 29850 })
    expect(json.owed[0]).toMatchObject({ person: 'Someone', outstandingPence: 3000, from: 'you told Ordo' })
  })

  it('money events and money compare', async () => {
    expect((await cli(fakeServices(), 'money', 'events')).stdout).toContain(
      'Italy  £423.99   £5.00      £418.99',
    )
    const services = fakeServices()
    const r = await cli(services, 'money', 'compare', '--category', 'Home')
    expect(services.money.compare).toHaveBeenCalledWith({ category: 'Home', account: undefined })
    expect(r.stdout).toBe(
      '£50.00 from 2026-11-01 to 2026-11-18, against £80.00 from 2026-10-01 to 2026-10-18 (£30.00 less).\n' +
        'HSBC shows posting dates, so the last few days may not be in yet.\n',
    )
  })

  it('money questions shows ids to answer with', async () => {
    const r = await cli(fakeServices(), 'money', 'questions')
    expect(r.stdout).toContain('id: pass-through:m1>m2')
    expect(r.stdout).toContain('answers: yes (Yes, passing through), no (No)')
  })

  it('money answer and money forget need --allow-changes and --confirm', async () => {
    const services = fakeServices()
    expect((await cli(services, 'money', 'answer', 'q', '--answer', 'yes', '--confirm')).code).toBe(3)
    expect((await cli(services, 'money', 'forget', 'f1', '--allow-changes')).code).toBe(3)
    expect(services.money.answer).not.toHaveBeenCalled()
    expect(services.money.forget).not.toHaveBeenCalled()
    const r = await cli(services, 'money', 'answer', 'q', '--answer', 'yes', '--allow-changes', '--confirm')
    expect(r).toMatchObject({ code: 0, stdout: 'Answered. Ordo saved 1 fact.\n' })
    expect(services.money.answer).toHaveBeenCalledWith({ questionId: 'q', answerId: 'yes' })
    expect((await cli(services, 'money', 'forget', 'f1', '--allow-changes', '--confirm')).code).toBe(0)
    expect(services.money.forget).toHaveBeenCalledWith('f1')
  })

  it('a refused answer is a failure, and locked exits 4', async () => {
    const services = fakeServices()
    services.money.answer = vi.fn(async () => ({
      ok: false as const,
      message: 'That question has already been answered.',
    }))
    expect(
      await runCommand(
        services,
        { name: 'money answer', question: 'q', answer: 'yes', confirm: true },
        { allowChanges: true },
      ),
    ).toEqual({ ok: false, code: 'failed', message: 'That question has already been answered.' })
    services.money.forget = vi.fn(async () => ({
      ok: false as const,
      error: 'locked' as const,
      message: 'Busy',
    }))
    expect((await cli(services, 'money', 'forget', 'f1', '--allow-changes', '--confirm')).code).toBe(4)
  })
})

describe('money memory over MCP', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    await close?.()
    close = null
  })
  async function connect(allowChanges: boolean, services = fakeServices()) {
    const server = createMcpServer(services, { allowChanges })
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1.0.0' })
    await Promise.all([server.connect(a), client.connect(b)])
    close = async () => {
      await client.close()
      await server.close()
    }
    return { client, services }
  }
  const json = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text)

  it('read tools are always there and marked untrusted; change tools only with --allow-changes', async () => {
    const ro = await connect(false)
    const names = (await ro.client.listTools()).tools.map((t) => t.name)
    for (const n of [
      'ordo_money_knows',
      'ordo_money_questions',
      'ordo_money_loose_ends',
      'ordo_money_events',
      'ordo_money_compare',
    ])
      expect(names).toContain(n)
    expect(names).not.toContain('ordo_money_answer')
    expect(names).not.toContain('ordo_money_forget')
    const tools = (await ro.client.listTools()).tools
    expect(tools.find((t) => t.name === 'ordo_money_questions')!.description).toMatch(/untrusted data/)
    await close?.()
    const rw = await connect(true)
    const all = (await rw.client.listTools()).tools
    expect(all.find((t) => t.name === 'ordo_money_answer')!.inputSchema.properties).toHaveProperty('confirm')
  })

  it('ordo_money_answer needs confirm: true', async () => {
    const { client, services } = await connect(true)
    const refused = await client.callTool({
      name: 'ordo_money_answer',
      arguments: { question: 'q', answer: 'yes' },
    })
    expect(json(refused).error.code).toBe('confirm_required')
    expect(services.money.answer).not.toHaveBeenCalled()
    const r = await client.callTool({
      name: 'ordo_money_answer',
      arguments: { question: 'q', answer: 'yes', confirm: true },
    })
    expect(json(r)).toEqual({ question: 'q', answer: 'yes', saved: 1 })
  })

  it('ordo_money_loose_ends returns pence', async () => {
    const { client } = await connect(false)
    const r = json(await client.callTool({ name: 'ordo_money_loose_ends', arguments: {} }))
    expect(r.held[0].holdingPence).toBe(29850)
  })
})

describe('money memory in the shared tool registry', () => {
  const t = (name: string) => toolByName(name)!
  const NAMES = [
    'ordo_money_knows',
    'ordo_money_questions',
    'ordo_money_loose_ends',
    'ordo_money_events',
    'ordo_money_compare',
    'ordo_money_answer',
    'ordo_money_forget',
  ]

  it('registers the read tools as untrusted and the changes with previews and intent', () => {
    for (const name of NAMES) {
      const x = t(name)
      expect(x.moneyDetails).toBe(true)
      if (x.kind === 'read') expect(x.untrusted).toBe(true)
      else {
        expect(x.kind).toBe('change')
        expect(x.preview).toBeTypeOf('function')
        expect(x.intent).toBeInstanceOf(RegExp)
      }
    }
    expect(
      TOOLS.filter((x) => x.moneyDetails)
        .map((x) => x.name)
        .sort(),
    ).toEqual([...NAMES].sort())
  })

  it('the answer card shows Ordo’s own question and the chosen answer', async () => {
    const p = await previewTool(fakeServices(), t('ordo_money_answer'), {
      question: 'pass-through:m1>m2',
      answer: 'yes',
    })
    expect(p).toEqual({
      title: 'Answer one of Ordo’s questions',
      details: [
        "H Bennie's £50.00 on 5 Oct went out again the same day to Sam. Was it just passing through?",
        'Answer: Yes, passing through',
      ],
      notes: ['Ordo saves what this answer means. You can forget it on Money → Ask Ordo.'],
    })
    const no = await previewTool(fakeServices(), t('ordo_money_answer'), {
      question: 'pass-through:m1>m2',
      answer: 'no',
    })
    expect(no.notes).toEqual(['Ordo won’t ask this again. Nothing else changes.'])
    expect(
      (await previewTool(fakeServices(), t('ordo_money_answer'), { question: 'gone', answer: 'yes' }))
        .blocked,
    ).toBe('That question has already been answered.')
    expect(
      (
        await previewTool(fakeServices(), t('ordo_money_answer'), {
          question: 'pass-through:m1>m2',
          answer: 'maybe',
        })
      ).blocked,
    ).toBe('That isn’t one of the question’s answers.')
  })

  it('the forget card shows the fact in Ordo’s words', async () => {
    expect(await previewTool(fakeServices(), t('ordo_money_forget'), { fact: 'f1' })).toEqual({
      title: 'Forget something Ordo learned',
      details: ['Money from Gabe is rent you hold for Patrick, not your income.'],
      notes: ['Ordo will work things out without it, and may ask about it again.'],
    })
    expect((await previewTool(fakeServices(), t('ordo_money_forget'), { fact: 'nope' })).blocked).toBe(
      'Ordo doesn’t know that fact any more.',
    )
  })

  it('changes only run when allowed and confirmed', async () => {
    const services = fakeServices()
    const args = { question: 'q', answer: 'yes' }
    expect(
      await runTool(services, t('ordo_money_answer'), args, { allowChanges: true, confirm: false }),
    ).toMatchObject({
      ok: false,
      code: 'confirm_required',
    })
    expect(services.money.answer).not.toHaveBeenCalled()
    expect(
      await runTool(services, t('ordo_money_answer'), args, { allowChanges: true, confirm: true }),
    ).toMatchObject({
      ok: true,
    })
    expect(services.money.answer).toHaveBeenCalledWith({ questionId: 'q', answerId: 'yes' })
  })

  it('intent words match plain requests', () => {
    expect(t('ordo_money_answer').intent!.test('yes, Gabe is my flatmate')).toBe(true)
    expect(t('ordo_money_forget').intent!.test('forget the Italy trip')).toBe(true)
    expect(t('ordo_money_forget').intent!.test('what do you know?')).toBe(false)
  })
})
