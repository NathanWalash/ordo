import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MailStore } from './store'
import type { CleanupSenderResult, CleanupSummary } from './types'
import {
  STILL_EMAILING_AFTER_MS,
  stillEmailing,
  unsubscribedFromHistory,
  withUnsubscribed,
  type SenderUnsubscribed,
} from './unsubscribed'

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

  it('says a sender is still emailing only when mail came more than two days after unsubscribing', () => {
    const at = new Date('2026-11-10T10:00:00Z')
    const unsubscribed = { at, status: 'done' as const, method: 'one-click' as const }
    const after = (ms: number) => new Date(at.getTime() + ms)
    expect(stillEmailing({ lastSeen: after(-60_000), unsubscribed })).toBe(false)
    // Mail already on its way: allowed for two days.
    expect(stillEmailing({ lastSeen: after(STILL_EMAILING_AFTER_MS), unsubscribed })).toBe(false)
    expect(stillEmailing({ lastSeen: after(STILL_EMAILING_AFTER_MS + 1), unsubscribed })).toBe(true)
    expect(stillEmailing({ lastSeen: after(10 * STILL_EMAILING_AFTER_MS) })).toBe(false)
    expect(stillEmailing({ lastSeen: new Date('nope'), unsubscribed })).toBe(false)
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
          again.cleanupSenders(),
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

    it('skips a clean-up row it can’t read instead of failing the sender list', () => {
      dir = mkdtempSync(join(tmpdir(), 'ordo-unsubscribed-'))
      const path = join(dir, 'mail.sqlite')
      const store = new MailStore(path)
      const good = (at: string, address: string) =>
        store.addCleanup({
          at: new Date(at),
          mailbox: 'INBOX',
          trashMailbox: null,
          trashUidValidity: null,
          moved: 0,
          senders: [sender(address, { status: 'done', method: 'one-click' })],
          uidMap: null,
          error: null,
        })
      good('2026-11-09T10:00:00Z', 'old@shop.example')
      good('2026-11-11T10:00:00Z', 'new@shop.example')
      store.close()

      // Corrupt rows, written straight to the database: broken JSON, and JSON that isn't a list.
      const db = new DatabaseSync(path)
      const insert = db.prepare(
        "INSERT INTO cleanups (account_id, created_at, mailbox, moved, senders) VALUES ('acc-1', ?, ?, 0, ?)",
      )
      insert.run(Date.parse('2026-11-10T10:00:00Z'), 'INBOX', '[{"address": "broken@')
      insert.run(Date.parse('2026-11-10T11:00:00Z'), 'INBOX', '{"address":"x@shop.example"}')
      db.close()

      const again = new MailStore(path)
      try {
        // The full history would throw on the broken row; the unsubscribe read doesn't.
        expect(() => again.cleanups()).toThrow()
        const rows = again.cleanupSenders()
        expect(rows.map((r) => r.at.toISOString())).toEqual([
          '2026-11-11T10:00:00.000Z',
          '2026-11-09T10:00:00.000Z',
        ])
        const out = withUnsubscribed<{ address: string; unsubscribed?: SenderUnsubscribed }>(
          [{ address: 'old@shop.example' }, { address: 'new@shop.example' }, { address: 'x@shop.example' }],
          rows,
        )
        expect(out.map((s) => s.unsubscribed?.status ?? null)).toEqual(['done', 'done', null])
      } finally {
        again.close()
      }
    })
  })
})
