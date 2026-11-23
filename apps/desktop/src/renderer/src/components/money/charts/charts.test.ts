// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CategorySeries, MonthFlow, UsualComparison } from '@ordo/money-core'
import { CategoryBars } from './CategoryBars'
import { CategoryTrendChart } from './CategoryTrendChart'
import { MonthlyFlowChart } from './MonthlyFlowChart'
import { barPath, formatAxisPence, labelEvery, niceTicks, visibleRange } from './scale'
import { usualTitle, VersusUsual } from './VersusUsual'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const render = (el: ReactElement) => act(() => root.render(el))
const all = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)]
const one = (sel: string) => host.querySelector<HTMLElement>(sel)!
const key = (el: Element, k: string) =>
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

const flow = (
  month: string,
  moneyIn: number,
  moneyOut: number,
  extra: Partial<MonthFlow> = {},
): MonthFlow => ({
  month,
  moneyIn,
  moneyOut,
  net: moneyIn - moneyOut,
  spent: moneyOut,
  ...extra,
})

describe('scale helpers', () => {
  it('makes round ticks that always include zero', () => {
    expect(niceTicks(0, 0)).toEqual({ lo: 0, hi: 1000, ticks: [0, 500, 1000] })
    expect(niceTicks(0, 245000)).toEqual({ lo: 0, hi: 300000, ticks: [0, 100000, 200000, 300000] })
    const neg = niceTicks(-180000, 320000)
    expect(neg.ticks).toContain(0)
    expect(neg.lo).toBeLessThanOrEqual(-180000)
    expect(neg.hi).toBeGreaterThanOrEqual(320000)
    // A big range still gets a handful of ticks.
    expect(niceTicks(0, 9_876_543_21).ticks.length).toBeLessThanOrEqual(7)
  })

  it('writes axis amounts short, in whole pounds', () => {
    expect(formatAxisPence(0)).toBe('£0')
    expect(formatAxisPence(45000)).toBe('£450')
    expect(formatAxisPence(150000)).toBe('£1.5k')
    expect(formatAxisPence(-1200000)).toBe('−£12k')
    expect(formatAxisPence(123_000_000)).toBe('£1.2m')
  })

  it('shows the latest two years, or two years ending at an older chosen month', () => {
    expect(visibleRange(10, -1)).toEqual([0, 10])
    expect(visibleRange(60, -1)).toEqual([36, 60])
    expect(visibleRange(60, 50)).toEqual([36, 60])
    expect(visibleRange(60, 30)).toEqual([7, 31])
    expect(visibleRange(60, 5)).toEqual([0, 24])
  })

  it('thins month labels so they fit', () => {
    expect(labelEvery(12, 600)).toBe(1)
    expect(labelEvery(24, 300)).toBe(4)
    expect(labelEvery(0, 300)).toBe(1)
  })

  it('draws a bar rounded at its data end, and nothing for zero', () => {
    expect(barPath(0, 10, 100, 100)).toBe('')
    expect(barPath(0, 10, 100, 40)).toBe('M0,100V44Q0,40 4,40H6Q10,40 10,44V100Z')
    expect(barPath(0, 10, 100, 160)).toBe('M0,100V156Q0,160 4,160H6Q10,160 10,156V100Z')
  })
})

describe('MonthlyFlowChart', () => {
  const months = [
    flow('2026-08', 250000, 180000),
    flow('2026-09', 120000, 175500),
    flow('2026-10', 245000, 90000, { partial: 'to-date' }),
  ]

  it('sums the chart up and labels every month, net included', () => {
    render(createElement(MonthlyFlowChart, { months }))
    const svg = one('svg')
    expect(svg.getAttribute('role')).toBe('group')
    expect(svg.getAttribute('aria-label')).toBe(
      'Money in and out by month, August 2026 to October 2026. More went out than came in for 1 of 3 months.',
    )
    expect(all('[aria-label^="September"]')[0]!.getAttribute('aria-label')).toBe(
      'September 2026: £1,200.00 in, £1,755.00 out, net −£555.00',
    )
    expect(one('[aria-label^="October"]').getAttribute('aria-label')).toContain('(so far)')
  })

  it('is one tab stop: the latest month, or the chosen one; arrows move between months', () => {
    render(createElement(MonthlyFlowChart, { months, selected: '2026-09', onSelect: () => {} }))
    const cols = all('svg [role="button"]')
    expect(cols).toHaveLength(3)
    expect(cols.map((c) => c.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    expect(cols[1]!.getAttribute('aria-pressed')).toBe('true')
    act(() => cols[1]!.focus())
    key(cols[1]!, 'ArrowRight')
    expect(document.activeElement).toBe(cols[2])
    expect(cols.map((c) => c.getAttribute('tabindex'))).toEqual(['-1', '-1', '0'])
    key(cols[2]!, 'Home')
    expect(document.activeElement).toBe(cols[0])
  })

  it('shows a tooltip on hover and on focus', () => {
    render(createElement(MonthlyFlowChart, { months }))
    const cols = all('svg [role="img"]')
    act(() => {
      cols[0]!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
      cols[0]!.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
    })
    expect(host.textContent).toContain('August 2026')
    expect(host.textContent).toContain('+£700.00')
    act(() => cols[2]!.focus())
    expect(host.textContent).toContain('October 2026')
    expect(host.textContent).toContain('Part month: so far')
  })

  it('picks a month by click or Return', () => {
    const onSelect = vi.fn()
    render(createElement(MonthlyFlowChart, { months, onSelect }))
    const cols = all('svg [role="button"]')
    click(cols[0]!)
    key(cols[1]!, 'Enter')
    expect(onSelect.mock.calls).toEqual([['2026-08'], ['2026-09']])
  })

  it('handles a single month where more went out, and no months at all', () => {
    render(createElement(MonthlyFlowChart, { months: [flow('2026-11', 0, 5000)] }))
    expect(one('svg').getAttribute('aria-label')).toBe(
      'Money in and out by month, November 2026. More went out than came in for 1 of 1 month.',
    )
    // The axis reaches below zero for the net.
    expect(host.textContent).toContain('−£')
    render(createElement(MonthlyFlowChart, { months: [] }))
    expect(host.querySelector('svg')).toBeNull()
    expect(host.textContent).toBe('No months to show yet.')
  })
})

describe('CategoryTrendChart', () => {
  const months = [flow('2026-08', 0, 0), flow('2026-09', 0, 0), flow('2026-10', 0, 0, { partial: 'to-date' })]
  const series: CategorySeries = {
    category: 'Groceries',
    total: 21000,
    monthly: [8000, 4000, 9000],
    usual: 6000,
  }

  it('marks the usual month and says how each whole month compares with it', () => {
    render(createElement(CategoryTrendChart, { series, months }))
    expect(one('svg').getAttribute('aria-label')).toBe(
      'Groceries spending by month. Usual month £60.00. Most in October 2026, £90.00.',
    )
    expect(host.textContent).toContain('Usual £60.00')
    expect(one('[aria-label^="August"]').getAttribute('aria-label')).toBe(
      'August 2026: £80.00, £20.00 more than usual',
    )
    // A partial month isn't compared.
    expect(one('[aria-label^="October"]').getAttribute('aria-label')).toBe('October 2026 (so far): £90.00')
  })

  it('draws no usual line before there is a whole month', () => {
    render(createElement(CategoryTrendChart, { series: { ...series, usual: null }, months }))
    expect(host.textContent).not.toContain('Usual £')
    expect(one('svg').getAttribute('aria-label')).toContain('Not enough whole months yet')
  })
})

describe('CategoryBars', () => {
  const cats = [
    { category: 'Groceries', amount: 42000 },
    { category: 'Eating out', amount: 12000 },
    { category: 'Shopping', amount: 1450 },
  ]

  it('lists categories largest first, and a click filters to one and back', () => {
    const onSelect = vi.fn()
    render(createElement(CategoryBars, { categories: cats, selected: 'Eating out', onSelect }))
    const items = all('li')
    expect(items.map((li) => li.textContent)).toEqual([
      'Groceries£420.00',
      'Eating out£120.00',
      'Shopping£14.50',
    ])
    const buttons = all('li button')
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    click(buttons[0]!)
    click(buttons[1]!)
    expect(onSelect.mock.calls).toEqual([['Groceries'], [null]])
  })

  it('shows eight at first, keeps the chosen one in view, and can show them all', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ category: `C${i}`, amount: 1000 - i }))
    render(createElement(CategoryBars, { categories: many, selected: 'C10' }))
    expect(all('li')).toHaveLength(9)
    const more = all('button').find((b) => b.textContent === 'Show all 11')!
    click(more)
    expect(all('li')).toHaveLength(11)
  })

  it('marks the usual month when given, and says so', () => {
    render(createElement(CategoryBars, { categories: cats, usual: new Map([['Groceries', 30000]]) }))
    expect(host.textContent).toContain('Your usual month')
    expect(all('li button')[0]!.getAttribute('title')).toContain('Usual month £300.00')
  })

  it('says when there was no spending', () => {
    render(createElement(CategoryBars, { categories: [] }))
    expect(host.textContent).toBe('No spending in this period.')
  })
})

describe('VersusUsual', () => {
  const comparison: UsualComparison = {
    month: '2026-11',
    throughDay: 23,
    baseline: ['2026-08', '2026-09', '2026-10'],
    total: { category: 'All spending', thisMonth: 50000, usual: 11000, difference: 39000 },
    categories: [
      { category: 'Groceries', thisMonth: 45000, usual: 6000, difference: 39000 },
      { category: 'Subscriptions', thisMonth: 0, usual: 2000, difference: -2000 },
      { category: 'Bills', thisMonth: 5000, usual: 5000, difference: 0 },
    ],
  }

  it('puts all spending first, then the categories that moved, in a table', () => {
    render(createElement(VersusUsual, { comparison }))
    expect(usualTitle(comparison)).toBe('November so far vs usual')
    const rows = all('tbody tr').map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent))
    expect(rows).toEqual([
      ['All spending', '£500.00', '£110.00', '+£390.00 more than usual'],
      ['Groceries', '£450.00', '£60.00', '+£390.00 more than usual'],
      ['Subscriptions', '£0.00', '£20.00', '−£20.00 less than usual'],
    ])
    expect(all('th').map((th) => th.textContent)).toEqual(['Category', 'So far', 'Usual', 'Change'])
    expect(host.textContent).toContain(
      'Usual is the middle (median) of 3 months, Aug 26 to Oct 26, up to day 23 of each.',
    )
  })

  it('explains when there is nothing to compare with', () => {
    render(createElement(VersusUsual, { comparison: null }))
    expect(host.textContent).toContain('needs at least one whole month')
  })
})
