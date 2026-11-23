import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { startFakeGoogle } from '../../../../test/fake-google'

// The Calendar service with a Google account, run without a window against a fake Google on
// 127.0.0.1: Settings' client and connect flow (consent followed by the test hook instead of a
// browser), syncing, changes, a refused refresh token and signing out. Electron is replaced by a
// temp profile.
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: false, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  powerMonitor: { on: vi.fn() },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}))

dir.path = mkdtempSync(join(tmpdir(), 'ordo-gcal-'))
const fake = await startFakeGoogle()
process.env['ORDO_GOOGLE_BASE_URL'] = fake.base
process.env['ORDO_TEST_GOOGLE_AUTO_CONSENT'] = '1'
const ME = fake.account.email
fake.addCalendar({ id: ME, summary: 'Work', accessRole: 'owner', primary: true, backgroundColor: '#3f51b5' })
fake.addCalendar({ id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader' })
const standup = fake.put(ME, {
  summary: 'Standup',
  start: { dateTime: '2026-11-02T09:00:00Z', timeZone: 'Europe/London' },
  end: { dateTime: '2026-11-02T09:15:00Z', timeZone: 'Europe/London' },
  recurrence: ['RRULE:FREQ=WEEKLY;COUNT=60'],
})

const calendar = await import('./calendar')
const { openExternal } = (await import('electron')).shell

afterAll(async () => {
  calendar.closeCalendar()
  await fake.stop()
})

const PRIMARY = `google:${fake.account.sub}:${ME}`
const WINDOW = { start: new Date(2026, 9, 1), end: new Date(2027, 11, 1) }

/** Sync the Google accounts, waiting out one already running (the one connecting starts). */
async function syncGoogle() {
  for (;;) {
    const r = await calendar.sync({ googleOnly: true })
    if (r.ok || r.error !== 'busy') return r
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('Google calendars in the Calendar service', () => {
  it('asks for an OAuth client first, and checks it', async () => {
    expect(calendar.googleStatus()).toMatchObject({ client: null, accounts: [], secureStorage: true })
    expect(await calendar.connectGoogle(undefined)).toMatchObject({ ok: false, error: 'not-configured' })
    expect(calendar.setGoogleClient({ clientId: 'not a client id' })).toMatchObject({ ok: false })
    expect(calendar.setGoogleClient({ clientId: fake.clientId, clientSecret: fake.clientSecret })).toEqual({
      ok: true,
    })
    expect(calendar.googleStatus().client).toEqual({ clientId: fake.clientId, hasSecret: true })
  })

  it('connects an account and shows its calendars and events', async () => {
    const r = await calendar.connectGoogle(undefined)
    expect(r).toMatchObject({ ok: true, account: { email: ME, needsReauth: false } })
    // The consent page never went to a real browser in this test.
    expect(openExternal).not.toHaveBeenCalled()
    expect(await syncGoogle()).toMatchObject({ ok: true })
    expect(calendar.calendars().map((c) => [c.name, c.source, c.account, c.readOnly])).toEqual([
      ['Work', 'google', ME, false],
      ['Team', 'google', ME, true],
    ])
    expect(calendar.calendars()[0]!.syncedAt).toMatch(/^\d{4}-/)
    expect(calendar.events(WINDOW).filter((e) => e.title === 'Standup').length).toBeGreaterThan(10)
    expect(calendar.status()).toMatchObject({ connected: false, google: 1 })
    expect(calendar.googleStatus().accounts).toEqual([
      { id: fake.account.sub, email: ME, needsReauth: false, calendars: 2 },
    ])
  })

  it('changes events through the calendar’s own Google account, without iCloud', async () => {
    const created = await calendar.createEvent({
      calendarId: PRIMARY,
      draft: {
        title: 'Planning',
        allDay: false,
        start: '2026-11-20T14:00',
        end: '2026-11-20T15:00',
        timeZone: 'Europe/London',
        location: '',
        notes: '',
        repeat: null,
        alert: null,
      },
    })
    expect(created).toMatchObject({ ok: true })
    const onGoogle = [...fake.calendars.get(ME)!.events.values()].find((e) => e.summary === 'Planning')
    expect(onGoogle?.iCalUID).toBe((created as { uid: string }).uid)
    const ref = { calendarId: PRIMARY, uid: standup.iCalUID, recurrenceId: '2026-11-16T09:00:00.000Z' }
    const details = calendar.eventDetails(ref)!
    expect(details).toMatchObject({ editable: true, recurring: true })
    expect(
      await calendar.updateEvent({
        ref,
        draft: { ...details.draft, title: 'Standup (late)' },
        scope: 'this',
      }),
    ).toMatchObject({ ok: true })
    expect(calendar.events(WINDOW).find((e) => e.title === 'Standup (late)')?.recurrenceId).toBe(
      ref.recurrenceId,
    )
    // Read-only calendars are refused before anything is sent.
    expect(
      await calendar.createEvent({
        calendarId: `google:${fake.account.sub}:team@group.calendar.google.com`,
        draft: { ...details.draft, repeat: null },
      }),
    ).toMatchObject({ ok: false, error: 'read-only' })
  })

  it('says to sign in again when Google stops accepting the refresh token', async () => {
    fake.refreshTokens.clear()
    fake.expireAccessTokens()
    const r = await syncGoogle()
    expect(r).toMatchObject({
      ok: true,
      failed: [{ name: ME, message: expect.stringMatching(/sign in to .* again/) }],
    })
    expect(calendar.googleStatus().accounts[0]!.needsReauth).toBe(true)
    expect(calendar.calendars()[0]!.syncError).toMatch(/sign in/)
    const ref = { calendarId: PRIMARY, uid: standup.iCalUID }
    expect(calendar.eventDetails(ref)).toMatchObject({
      editable: false,
      reason: expect.stringMatching(/sign in/),
    })
    expect(await calendar.deleteEvent({ ref, scope: 'all' })).toMatchObject({ ok: false, error: 'auth' })
    // Signing in again clears it.
    expect(await calendar.connectGoogle({ accountId: fake.account.sub })).toMatchObject({ ok: true })
    expect(calendar.googleStatus().accounts[0]!.needsReauth).toBe(false)
    expect(await syncGoogle()).toMatchObject({ ok: true })
    expect(calendar.calendars()[0]!.syncError).toBeUndefined()
  })

  it('keeps a colour of your choosing', () => {
    calendar.setCalendarColor({ calendarId: PRIMARY, color: '#FF0000' })
    expect(calendar.calendars()[0]!.color).toBe('#ff0000')
    expect(() => calendar.setCalendarColor({ calendarId: PRIMARY, color: 'red;' })).toThrow()
  })

  it('signs out: revokes at Google and forgets the calendars', async () => {
    const revoked = fake.revoked.length
    expect(await calendar.signOutGoogle(fake.account.sub)).toEqual({ ok: true })
    expect(fake.revoked.length).toBe(revoked + 1)
    expect(calendar.calendars()).toEqual([])
    expect(calendar.googleStatus().accounts).toEqual([])
    expect(await calendar.signOutGoogle('../etc')).toMatchObject({ ok: false })
  })
})
