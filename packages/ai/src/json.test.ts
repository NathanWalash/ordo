import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { completeJson, parseModelJson } from './json'
import { AiError, type CompleteRequest, type CompleteResult, type ModelProvider } from './types'

/** A provider that replays canned replies and records each request. */
function fake(replies: (string | CompleteResult)[]) {
  const calls: CompleteRequest[] = []
  const provider: ModelProvider = {
    id: 'lmstudio',
    label: 'Fake',
    kind: 'local',
    detect: async () => ({ available: true, state: 'ready' }),
    listModels: async () => ['m'],
    complete: async (req) => {
      calls.push(req)
      const next = replies.shift()
      if (next === undefined) throw new Error('no more replies')
      return typeof next === 'string' ? { text: next } : next
    },
  }
  return { provider, calls }
}

const Reply = z.object({ word: z.enum(['yes', 'no']) })
const schema = { type: 'object', properties: { word: { enum: ['yes', 'no'] } }, required: ['word'] }
const ask = (provider: ModelProvider) =>
  completeJson(provider, { system: 's', prompt: 'p', jsonSchema: schema, validate: Reply })

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips ```json fences and chatter around the value', () => {
    expect(parseModelJson('Sure!\n```json\n{"a":[1,2]}\n```\nHope that helps')).toEqual({ a: [1, 2] })
    expect(parseModelJson('```\n[1]\n```')).toEqual([1])
    expect(parseModelJson('Here you go: {"a":1} — done.')).toEqual({ a: 1 })
  })

  it('throws when there is no JSON', () => {
    expect(() => parseModelJson('no idea')).toThrow()
    expect(() => parseModelJson('{"a":')).toThrow()
  })
})

describe('completeJson', () => {
  it('returns validated JSON and sends the schema', async () => {
    const { provider, calls } = fake(['```json\n{"word":"yes"}\n```'])
    expect(await ask(provider)).toEqual({ word: 'yes' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.schema).toEqual(schema)
  })

  it('prefers structured output when the provider returns it', async () => {
    const { provider } = fake([{ text: 'ignored', json: { word: 'no' } }])
    expect(await ask(provider)).toEqual({ word: 'no' })
  })

  it('retries once with the problem appended when the reply is not valid', async () => {
    const { provider, calls } = fake(['{"word":"maybe"}', '{"word":"no"}'])
    expect(await ask(provider)).toEqual({ word: 'no' })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.prompt).toMatch(/^p\n\nYour previous reply could not be used \(word: /)
  })

  it('retries after unparseable text too', async () => {
    const { provider, calls } = fake(['I think yes', '{"word":"yes"}'])
    expect(await ask(provider)).toEqual({ word: 'yes' })
    expect(calls[1]!.prompt).toContain('Your previous reply could not be used')
  })

  it('gives up after the retry with a bad-response error', async () => {
    const { provider, calls } = fake(['nope', '{"word":3}'])
    const err = await ask(provider).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AiError)
    expect((err as AiError).code).toBe('bad-response')
    expect(calls).toHaveLength(2)
  })

  it('does not retry provider errors', async () => {
    const calls: CompleteRequest[] = []
    const provider: ModelProvider = {
      ...fake([]).provider,
      complete: async (req) => {
        calls.push(req)
        throw new AiError('unavailable', 'down')
      },
    }
    await expect(ask(provider)).rejects.toThrow('down')
    expect(calls).toHaveLength(1)
  })
})
