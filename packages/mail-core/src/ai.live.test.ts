// Optional smoke test against a real model, with made-up senders. Skipped unless asked for:
//   AI_LIVE=lmstudio pnpm vitest run ai.live   (LM Studio's server on :1234, any model loaded)
//   AI_LIVE=ollama   pnpm vitest run ai.live
//   AI_LIVE=claude   pnpm vitest run ai.live   (sends the made-up senders to Anthropic)
// It never fails because the provider isn't running; it says so and passes.
import { describe, expect, it } from 'vitest'
import { recommendedModel, type ModelProvider } from '@ordo/ai'
import { ClaudeCliProvider, LmStudioProvider, OllamaProvider } from '@ordo/ai/node'
import { aiCategorise } from './ai-sort'
import type { CategorisedSender } from './analyse'

const live = process.env['AI_LIVE']

const sender = (address: string, name: string, subjects: string[], o: Partial<CategorisedSender> = {}) =>
  ({
    address,
    name,
    domain: address.split('@')[1]!,
    count: 5,
    unread: 2,
    firstSeen: new Date(0),
    lastSeen: new Date(0),
    sampleSubjects: subjects,
    unsubscribe: { kind: 'none' },
    bulk: false,
    automated: false,
    category: 'uncategorised',
    ...o,
  }) satisfies CategorisedSender

const SENDERS: CategorisedSender[] = [
  sender('offers@shoes.example', 'Shoe Shop', [
    'Black Friday: 40% off everything',
    'Last chance for free delivery',
  ]),
  sender('digest@weekly-reads.example', 'Weekly Reads', [
    'Issue 212: the best long reads',
    'Issue 211: on cities',
  ]),
  sender('security@bank.example', 'Bank Security', ['New sign-in from Chrome on Mac', 'Your one-time code']),
  sender('orders@bookstore.example', 'Bookstore', [
    'Your order #4411 has shipped',
    'Receipt for order #4411',
  ]),
  sender('jo.bloggs@example.com', 'Jo Bloggs', ['Dinner on Friday?', 'Re: photos from the trip']),
  sender('mum@family.example', 'Mum', ['Call me'], { category: 'people' }),
]

function provider(): ModelProvider | null {
  if (live === 'lmstudio') return new LmStudioProvider(process.env['AI_LIVE_URL'])
  if (live === 'ollama') return new OllamaProvider(process.env['AI_LIVE_URL'])
  if (live === 'claude') return new ClaudeCliProvider()
  return null
}

describe.skipIf(!live)(`live model smoke test (${live})`, () => {
  it('sorts made-up senders with a real model', { timeout: 600_000 }, async () => {
    const p = provider()!
    const found = await p.detect()
    if (!found.available) {
      console.log(`[ai.live] ${p.label} not available (${found.detail}) Skipping.`)
      return
    }
    const models = await p.listModels()
    const model = process.env['AI_LIVE_MODEL'] ?? recommendedModel(p.id, models) ?? undefined
    const started = Date.now()
    const r = await aiCategorise(SENDERS, p, { model, timeoutMs: 300_000 })
    console.log(`[ai.live] ${p.label} · ${model} · ${((Date.now() - started) / 1000).toFixed(1)} s`)
    for (const s of r.senders)
      console.log(
        `[ai.live]   ${s.address.padEnd(30)} ${s.category.padEnd(14)} ${s.sortedBy} ${s.confidence ?? ''}`,
      )
    console.log(`[ai.live] checked ${r.checked}, changed ${r.changed}, failed ${r.failed}`, r.errors)
    expect(r.senders.find((s) => s.address === 'mum@family.example')!.category).toBe('people')
  })
})
