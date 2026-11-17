import { describe, expect, it } from 'vitest'
import { deadline, limitConcurrency } from './limit'
import { AiError, recommendedModel } from './types'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('limitConcurrency', () => {
  it('never runs more than the limit at once and runs everything', async () => {
    const run = limitConcurrency(2)
    let active = 0
    let peak = 0
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        run(async () => {
          active++
          peak = Math.max(peak, active)
          await tick()
          active--
          return n * 10
        }),
      ),
    )
    expect(results).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })

  it('frees the slot when a task fails', async () => {
    const run = limitConcurrency(1)
    await expect(run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await run(async () => 'next')).toBe('next')
  })

  it('rejects a limit below one', () => {
    expect(() => limitConcurrency(0)).toThrow(RangeError)
  })
})

describe('deadline', () => {
  it('aborts after the timeout and explains it as a timeout', async () => {
    const d = deadline(undefined, 20)
    await new Promise((r) => d.signal.addEventListener('abort', r))
    const err = d.explain(new Error('socket closed'), 'LM Studio') as AiError
    expect(err.code).toBe('timeout')
    expect(err.message).toBe("LM Studio didn't answer within 0 s.")
    d.dispose()
  })

  it("follows the caller's signal and explains it as aborted", () => {
    const c = new AbortController()
    const d = deadline(c.signal, 10_000)
    c.abort()
    expect(d.signal.aborted).toBe(true)
    expect((d.explain(new Error('x'), 'X') as AiError).code).toBe('aborted')
    d.dispose()
  })

  it('passes other errors through untouched', () => {
    const d = deadline(undefined, 10_000)
    const e = new Error('other')
    expect(d.explain(e, 'X')).toBe(e)
    const ai = new AiError('failed', 'nope')
    expect(d.explain(ai, 'X')).toBe(ai)
    d.dispose()
  })
})

describe('recommendedModel', () => {
  it('prefers gpt-oss-20b for local providers', () => {
    expect(recommendedModel('lmstudio', ['gemma-4-26b-a4b-qat', 'openai/gpt-oss-20b'])).toBe(
      'openai/gpt-oss-20b',
    )
    expect(recommendedModel('ollama', ['llama3:8b', 'gpt-oss:20b'])).toBe('gpt-oss:20b')
    expect(recommendedModel('lmstudio', ['gemma-4-26b-a4b-qat'])).toBe('gemma-4-26b-a4b-qat')
    expect(recommendedModel('lmstudio', [])).toBeNull()
  })

  it('uses haiku for Claude and the account default for Codex', () => {
    expect(recommendedModel('claude-cli', ['haiku', 'sonnet', 'opus'])).toBe('haiku')
    expect(recommendedModel('codex-cli', ['default'])).toBe('default')
  })
})
