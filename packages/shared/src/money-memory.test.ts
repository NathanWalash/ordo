import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS, moneyDetailsAllowed, type AiSettings } from './ai'
import { AnswerSchema, AskInputSchema, CompareSchema, SaveFactSchema } from './money-memory'

const ai = (o: Partial<AiSettings>): AiSettings => ({ ...DEFAULT_AI_SETTINGS, ...o })

describe('moneyDetailsAllowed', () => {
  it('never without a model', () => {
    expect(moneyDetailsAllowed(ai({}))).toBe(false)
  })

  it('always for a local model', () => {
    expect(moneyDetailsAllowed(ai({ provider: 'lmstudio' }))).toBe(true)
    expect(moneyDetailsAllowed(ai({ provider: 'ollama' }))).toBe(true)
  })

  it('a cloud model needs both consents, for that same provider', () => {
    const claude = { provider: 'claude-cli', cloudConsent: 'claude-cli' } as const
    expect(moneyDetailsAllowed(ai(claude))).toBe(false)
    expect(moneyDetailsAllowed(ai({ ...claude, moneyDetailsConsent: 'codex-cli' }))).toBe(false)
    expect(moneyDetailsAllowed(ai({ ...claude, moneyDetailsConsent: 'claude-cli' }))).toBe(true)
    // The Money details consent alone isn't enough.
    expect(
      moneyDetailsAllowed(
        ai({ provider: 'claude-cli', cloudConsent: null, moneyDetailsConsent: 'claude-cli' }),
      ),
    ).toBe(false)
  })
})

describe('memory IPC schemas', () => {
  it('SaveFactSchema checks the fact and refuses extra keys', () => {
    expect(SaveFactSchema.parse({ fact: { kind: 'income', from: 'Acme' } })).toEqual({
      fact: { kind: 'income', from: 'Acme' },
      source: 'you',
    })
    expect(SaveFactSchema.safeParse({ fact: { kind: 'income', from: '' } }).success).toBe(false)
    expect(SaveFactSchema.safeParse({ fact: { kind: 'income', from: 'A' }, extra: 1 }).success).toBe(false)
    // Questions are answered through AnswerSchema, never by claiming a source.
    expect(
      SaveFactSchema.safeParse({ fact: { kind: 'income', from: 'A' }, source: 'question' }).success,
    ).toBe(false)
  })

  it('AnswerSchema, CompareSchema and AskInputSchema bound their inputs', () => {
    expect(AnswerSchema.parse({ questionId: 'person:gabe', answerId: 'flatmate' }).via).toBe('question')
    expect(AnswerSchema.safeParse({ questionId: 'x', answerId: 'y'.repeat(41) }).success).toBe(false)
    expect(CompareSchema.parse({ category: ' Home ' })).toEqual({ category: 'Home' })
    expect(AskInputSchema.safeParse({ question: '   ' }).success).toBe(false)
    expect(AskInputSchema.safeParse({ question: 'x'.repeat(501) }).success).toBe(false)
    expect(AskInputSchema.parse({ question: 'How much was Italy?' })).toEqual({
      question: 'How much was Italy?',
      history: [],
    })
  })
})
