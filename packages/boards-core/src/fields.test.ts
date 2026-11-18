import { describe, expect, it } from 'vitest'
import { addDays, daysBetween, isISODate, toISODate } from './dates'
import { fieldText, normaliseFieldValue, safeUrl } from './fields'
import type { FieldDef } from './types'

const def = (type: FieldDef['type'], extra: Partial<FieldDef> = {}) => ({
  name: 'Field',
  type,
  options: [
    { id: 'o1', name: 'Low', color: 'grey' as const },
    { id: 'o2', name: 'High', color: 'red' as const },
  ],
  ...extra,
})

describe('normaliseFieldValue', () => {
  it('clears on null, undefined and empty text', () => {
    for (const v of [null, undefined, '', '   '])
      expect(normaliseFieldValue(def('text'), v)).toEqual({ ok: true, value: null })
  })

  it('checks each type', () => {
    expect(normaliseFieldValue(def('text'), '  hi ')).toEqual({ ok: true, value: 'hi' })
    expect(normaliseFieldValue(def('text'), 'x'.repeat(501)).ok).toBe(false)
    expect(normaliseFieldValue(def('person'), ' Sam ')).toEqual({ ok: true, value: 'Sam' })
    expect(normaliseFieldValue(def('number'), 3)).toEqual({ ok: true, value: 3 })
    expect(normaliseFieldValue(def('number'), '-2.5')).toEqual({ ok: true, value: -2.5 })
    expect(normaliseFieldValue(def('number'), '1e3').ok).toBe(false)
    expect(normaliseFieldValue(def('number'), Number.NaN).ok).toBe(false)
    expect(normaliseFieldValue(def('date'), '2026-11-30')).toEqual({ ok: true, value: '2026-11-30' })
    expect(normaliseFieldValue(def('date'), '2026-11-31').ok).toBe(false)
    expect(normaliseFieldValue(def('select'), 'o2')).toEqual({ ok: true, value: 'o2' })
    expect(normaliseFieldValue(def('select'), 'low')).toEqual({ ok: true, value: 'o1' })
    expect(normaliseFieldValue(def('select'), 'Medium').ok).toBe(false)
    expect(normaliseFieldValue(def('checkbox'), true)).toEqual({ ok: true, value: true })
    expect(normaliseFieldValue(def('checkbox'), false)).toEqual({ ok: true, value: null })
    expect(normaliseFieldValue(def('checkbox'), 'yes')).toEqual({ ok: true, value: true })
    expect(normaliseFieldValue(def('checkbox'), 'maybe').ok).toBe(false)
  })

  it('only takes https web links', () => {
    expect(normaliseFieldValue(def('url'), 'example.com')).toEqual({
      ok: true,
      value: 'https://example.com/',
    })
    expect(normaliseFieldValue(def('url'), 'https://a.example/x?y=1')).toEqual({
      ok: true,
      value: 'https://a.example/x?y=1',
    })
    for (const bad of [
      'javascript:alert(1)',
      'http://a.example',
      'file:///x',
      'https://u:p@a.example',
      'https://',
    ])
      expect(normaliseFieldValue(def('url'), bad).ok, bad).toBe(false)
    expect(safeUrl('mailto:a@b.example')).toBeNull()
  })
})

describe('fieldText', () => {
  it('shows select names and ticked checkboxes', () => {
    expect(fieldText(def('select'), 'o2')).toBe('High')
    expect(fieldText(def('select'), 'gone')).toBe('')
    expect(fieldText(def('checkbox'), true)).toBe('Yes')
    expect(fieldText(def('number'), 4)).toBe('4')
    expect(fieldText(def('text'), undefined)).toBe('')
  })
})

describe('dates', () => {
  it('checks and does arithmetic on calendar days', () => {
    expect(isISODate('2028-02-29')).toBe(true)
    expect(isISODate('2026-02-29')).toBe(false)
    expect(isISODate('26-1-1')).toBe(false)
    expect(isISODate(20261101)).toBe(false)
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-11-18', '2026-11-25')).toBe(7)
    expect(daysBetween('2026-11-25', '2026-11-18')).toBe(-7)
    expect(toISODate(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
