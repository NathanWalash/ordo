// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageSummary } from '@ordo/shared'
import { MessageList } from './MessageList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (uid: number): MessageSummary => ({
  account: 'acc-1',
  mailbox: 'INBOX',
  uid,
  date: new Date('2026-11-16T10:00:00Z'),
  from: { address: `p${uid}@x.example`, name: `Person ${uid}` },
  to: [],
  subject: `Message ${uid}`,
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: false,
})
const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => row(from + i))

/**
 * The list as the Mail page drives it: asking for more appends the next page, and a page with
 * nothing new leaves the rows exactly as they were (MailPage's loadMore keeps the same array).
 */
function Paged({ pages, onAsk }: { pages: MessageSummary[][]; onAsk: () => void }) {
  const [state, setState] = useState({ rows: pages[0]!, next: 1 })
  return createElement(MessageList, {
    label: 'Inbox messages',
    messages: state.rows,
    selected: null,
    onSelect: () => {},
    showRecipients: false,
    empty: null,
    onEndReached: () => {
      onAsk()
      setState((s) => {
        const more = pages[s.next]
        return more ? { rows: [...s.rows, ...more], next: s.next + 1 } : s
      })
    },
  })
}

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
  vi.unstubAllGlobals()
})

describe('MessageList paging', () => {
  it('asks on its own when the rows already reach the bottom, with no scroll event, and stops when nothing new comes', () => {
    // Only the rows changing can ask here: no observer, and no scroll event is ever fired.
    vi.stubGlobal('IntersectionObserver', undefined)
    const onAsk = vi.fn()
    act(() => root.render(createElement(Paged, { pages: [page(1, 3)], onAsk })))
    // At the bottom (a list this short is all in view): one ask on showing the first rows. That
    // page brings nothing new, so the rows stay the same and it doesn't ask again.
    expect(onAsk).toHaveBeenCalledTimes(1)
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(3)
  })

  it('a page that loads while at the bottom brings exactly one more ask', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const onAsk = vi.fn()
    act(() => root.render(createElement(Paged, { pages: [page(1, 3), page(4, 3)], onAsk })))
    // First ask loads the second page; the new rows ask once more; that brings nothing new.
    expect(onAsk).toHaveBeenCalledTimes(2)
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(6)
  })

  it('asks when the end marker comes into view, without any scroll event', () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null
    const observed: Element[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          seen = cb
        }
        observe(el: Element) {
          observed.push(el)
        }
        disconnect() {}
      },
    )
    const onEndReached = vi.fn()
    const list = (messages: MessageSummary[]) =>
      createElement(MessageList, {
        label: 'Inbox messages',
        messages,
        selected: null,
        onSelect: () => {},
        showRecipients: false,
        empty: null,
        onEndReached,
      })
    const rows = page(1, 3)
    act(() => root.render(list(rows)))
    const before = onEndReached.mock.calls.length
    // The marker sits after the last row.
    expect(observed).toHaveLength(1)
    expect(observed[0]!.previousElementSibling?.getAttribute('role')).toBe('listbox')
    act(() => seen!([{ isIntersecting: false }]))
    expect(onEndReached).toHaveBeenCalledTimes(before)
    act(() => seen!([{ isIntersecting: true }]))
    expect(onEndReached).toHaveBeenCalledTimes(before + 1)
    // The same rows again (a page with nothing new) don't ask by themselves.
    act(() => root.render(list(rows)))
    expect(onEndReached).toHaveBeenCalledTimes(before + 1)
  })
})
