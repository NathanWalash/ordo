import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MailStore } from './store'
import type { CleanupSenderResult, CleanupSummary } from './types'
import { unsubscribedFromHistory, withUnsubscribed, type SenderUnsubscribed } from './unsubscribed'

const sender = (address: string, unsubscribe: CleanupSenderResult['unsubscribe']): CleanupSenderResult => ({
  address,
  name: 'Deals',
  category: 'promotions',
  trash: false,
  moved: 0,
  unsubscribe,
})
const cleanup = (at: string, senders: CleanupSenderResult[]): Pick<CleanupSummary, 'at' | 'senders'> => ({
  at: new Date(at),
  senders,
})

describe('unsubscribed senders from clean-up history', () => {
  it('counts a one-click, an email sent and a page opened, but not a failure or a skip', () => {
    const map = unsubscribedFromHistory([
      cleanup('2026-11-10T10:00:00Z', [
        sender('deals@shop.example', { status: 'done', method: 'one-click' }),
        sender('news@club.example', { status: 'done', method: 'mailto' }),
        sender('offers@web.example', { status: 'opened', method: 'link' }),
        sender('broken@shop.example', { status: 'failed', method: 'one-click', detail: 'HTTP 500' }),
        sender('plain@shop.example', { status: 'skipped', method: 'link' }),
        sender('kept@shop.example', null),
      ]),
    ])
    expect([...map.keys()].sort()).toEqual(['deals@shop.example', 'news@club.example', 'offers@web.example'])
    expect(map.get('deals@shop.example')).toEqual({
      at: new Date('2026-11-10T10:00:00Z'),
      status: 'done',
      method: 'one-click',
    })
    expect(map.get('offers@web.example')).toMatchObject({ status: 'opened', method: 'link' })
  })

  it('keeps the newest, and a later failure never cancels an earlier unsubscribe', () => {
    const map = unsubscribedFromHistory([
      // Newest first, as History lists them.
      cleanup('2026-11-12T10:00:00Z', [
        sender('deals@shop.example', { status: 'failed', method: 'one-click', detail: 'timeout' }),
      ]),
      cleanup('2026-11-11T10:00:00Z', [
        sender('deals@shop.example', { status: 'done', method: 'one-click' }),
      ]),
      cleanup('2026-11-09T10:00:00Z', [sender('deals@shop.example', { status: 'opened', method: 'link' })]),
    ])
    expect(map.get('deals@shop.example')).toEqual({
      at: new Date('2026-11-11T10:00:00Z'),
      status: 'done',
      method: 'one-click',
    })
  })

  it('ignores malformed history entries', () => {
    const bad = [
      { at: new Date('nope'), senders: [sender('a@x.example', { status: 'done', method: 'one-click' })] },
      {
        at: '2026-11-10T10:00:00Z',
        senders: [sender('b@x.example', { status: 'done', method: 'one-click' })],
      },
      { at: new Date('2026-11-10T10:00:00Z'), senders: 'not a list' },
      {
        at: new Date('2026-11-10T10:00:00Z'),
        senders: [
          null,
          'c@x.example',
          { address: 42, unsubscribe: { status: 'done', method: 'one-click' } },
          { address: '', unsubscribe: { status: 'done', method: 'one-click' } },
          { address: 'd@x.example', unsubscribe: { status: 'done', method: 'none' } },
          { address: 'e@x.example', unsubscribe: { status: 'unsubscribed', method: 'one-click' } },
          { address: 'f@x.example', unsubscribe: 'done' },
        ],
      },
    ] as unknown as Pick<CleanupSummary, 'at' | 'senders'>[]
    expect(unsubscribedFromHistory(bad).size).toBe(0)
  })

  it('marks matching senders, whatever the case of the address, and leaves the rest alone', () => {
    const senders = [
      { address: 'Deals@Shop.example', category: 'promotions' },
      { address: 'sam@friend.example', category: 'people' },
    ]
    const out = withUnsubscribed(senders, [
      cleanup('2026-11-10T10:00:00Z', [
        sender('deals@shop.example', { status: 'done', method: 'one-click' }),
      ]),
    ])
    expect(out[0]).toEqual({
      address: 'Deals@Shop.example',
      category: 'promotions',
      unsubscribed: { at: new Date('2026-11-10T10:00:00Z'), status: 'done', method: 'one-click' },
    })
    expect(out[1]).toBe(senders[1])
    expect(senders[0]).not.toHaveProperty('unsubscribed')
  })

  describe('from the store', () => {
    let dir: string | undefined
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

    it('survives a restart: history is read back from disk', () => {
      dir = mkdtempSync(join(tmpdir(), 'ordo-unsubscribed-'))
      const path = join(dir, 'mail.sqlite')
      const first = new MailStore(path)
      first.addCleanup({
        at: new Date('2026-11-10T10:00:00Z'),
        mailbox: 'INBOX',
        trashMailbox: null,
        trashUidValidity: null,
        moved: 0,
        senders: [sender('deals@shop.example', { status: 'done', method: 'one-click' })],
        uidMap: null,
        error: null,
      })
      first.close()

      const again = new MailStore(path)
      try {
        const out = withUnsubscribed<{ address: string; unsubscribed?: SenderUnsubscribed }>(
          [{ address: 'deals@shop.example' }],
          again.cleanups(),
        )
        expect(out[0]!.unsubscribed).toEqual({
          at: new Date('2026-11-10T10:00:00Z'),
          status: 'done',
          method: 'one-click',
        })
      } finally {
        again.close()
      }
    })
  })
})
