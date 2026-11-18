import { describe, expect, it, vi } from 'vitest'
import type { EventDetails, EventDraft } from '@ordo/shared'
import { fakeServices } from './fake-services'
import { previewTool, runTool, toolByName } from './tools'

const HOME = { id: 'cal-home', name: 'Home', readOnly: false, visible: true, source: 'icloud' as const }
const WORK = { id: 'feed:1', name: 'Work (Google)', readOnly: true, visible: true, source: 'link' as const }
const t = (name: string) => toolByName(name)!

const draft = (o: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Standup',
  allDay: false,
  start: '2026-11-23T09:00',
  end: '2026-11-23T09:15',
  timeZone: 'Europe/London',
  location: '',
  notes: '',
  repeat: { frequency: 'weekly' },
  alert: null,
  ...o,
})

function services(details: Partial<EventDetails> = {}) {
  const s = fakeServices()
  s.calendar = {
    ...s.calendar,
    calendars: () => [HOME, WORK],
    locate: () => [HOME.id],
    details: vi.fn(() => ({
      calendarId: HOME.id,
      draft: draft(),
      recurring: true,
      editable: true,
      ...details,
    })),
  }
  return s
}

describe('calendar tools in the shared registry', () => {
  it('lists calendars as a read tool, and the changes as change tools with untrusted results', () => {
    expect(t('ordo_calendar_list')).toMatchObject({ kind: 'read', untrusted: true })
    for (const name of ['ordo_calendar_add', 'ordo_calendar_edit', 'ordo_calendar_delete'])
      expect(t(name)).toMatchObject({ kind: 'change', untrusted: true })
  })

  it('gates every change, and calls nothing without permission and confirmation', async () => {
    const s = services()
    const args = { calendar: 'Home', title: 'Gym', start: '2026-11-20T18:00' }
    expect(
      await runTool(s, t('ordo_calendar_add'), args, { allowChanges: false, confirm: true }),
    ).toMatchObject({
      code: 'changes_not_allowed',
    })
    expect(
      await runTool(s, t('ordo_calendar_add'), args, { allowChanges: true, confirm: false }),
    ).toMatchObject({
      code: 'confirm_required',
    })
    expect(s.calendar.createEvent).not.toHaveBeenCalled()
    expect(
      await runTool(s, t('ordo_calendar_add'), args, { allowChanges: true, confirm: true }),
    ).toMatchObject({
      ok: true,
    })
    expect(s.calendar.createEvent).toHaveBeenCalledOnce()
  })

  it('previews an addition from Ordo’s own data: what, when, which calendar', async () => {
    const p = await previewTool(services(), t('ordo_calendar_add'), {
      calendar: 'home',
      title: 'Dentist',
      start: '2026-11-20T09:00',
      timeZone: 'Europe/London',
      location: 'High Street',
      alert: 30,
      repeat: 'monthly',
      count: 3,
    })
    expect(p).toEqual({
      title: 'Add “Dentist” to Home',
      details: [
        'Friday, 20 November 2026, 09:00 – 10:00 (London time)',
        'Repeats monthly, 3 times',
        'Alert 30 minutes before',
        'Location: High Street',
      ],
      notes: [expect.stringContaining('other devices')],
    })
  })

  it('blocks an addition that can’t happen, saying why', async () => {
    const s = services()
    const blocked = (args: object) => previewTool(s, t('ordo_calendar_add'), args).then((p) => p.blocked)
    expect(await blocked({ calendar: 'Work (Google)', title: 'x', start: '2026-11-20' })).toMatch(/read-only/)
    expect(await blocked({ calendar: 'Nope', title: 'x', start: '2026-11-20' })).toMatch(/no calendar called/)
    expect(
      await blocked({ calendar: 'Home', title: 'x', start: '2026-11-20T10:00', end: '2026-11-20T09:00' }),
    ).toBe('The event ends before it starts.')
    const offline = services()
    offline.account = () => ({ connected: false })
    expect(
      (
        await previewTool(offline, t('ordo_calendar_add'), {
          calendar: 'Home',
          title: 'x',
          start: '2026-11-20',
        })
      ).blocked,
    ).toMatch(/No iCloud account/)
  })

  it('previews a change as before → after, and says which occurrences', async () => {
    const one = await previewTool(services(), t('ordo_calendar_edit'), {
      uid: 'ev-1',
      occurrence: '2026-11-23T09:00:00.000Z',
      start: '2026-11-23T10:00',
    })
    expect(one).toMatchObject({
      title: 'Change “Standup” in Home',
      details: [
        'Only the occurrence on Monday, 23 November 2026, 09:00 – 09:15 (London time)',
        'When: Monday, 23 November 2026, 09:00 – 09:15 (London time) → Monday, 23 November 2026, 10:00 – 10:15 (London time)',
      ],
    })
    expect(one.blocked).toBeUndefined()
    const all = await previewTool(services(), t('ordo_calendar_edit'), {
      uid: 'ev-1',
      all: true,
      title: 'Daily sync',
    })
    expect(all.details).toEqual(['Every event in the series', 'Title: Standup → Daily sync'])
    const same = await previewTool(services(), t('ordo_calendar_edit'), {
      uid: 'ev-1',
      all: true,
      title: 'Standup',
    })
    expect(same.blocked).toBe('Nothing would change.')
    const unclear = await previewTool(services(), t('ordo_calendar_edit'), { uid: 'ev-1', title: 'x' })
    expect(unclear.blocked).toMatch(/--occurrence/)
  })

  it('previews a delete, saying it can’t be undone, and refuses invitations', async () => {
    const p = await previewTool(services({ recurring: false }), t('ordo_calendar_delete'), { uid: 'ev-1' })
    expect(p).toEqual({
      title: 'Delete “Standup”',
      details: ['Monday, 23 November 2026, 09:00 – 09:15 (London time)', 'Calendar: Home'],
      notes: ['This deletes it from iCloud and all your devices. You can’t undo this.'],
    })
    const series = await previewTool(services(), t('ordo_calendar_delete'), { uid: 'ev-1', all: true })
    expect(series.title).toBe('Delete every event in the series “Standup”')
    const invite = await previewTool(
      services({ editable: false, reason: 'This is an invitation from boss@work.example.' }),
      t('ordo_calendar_delete'),
      { uid: 'ev-1', all: true },
    )
    expect(invite.blocked).toBe('This is an invitation from boss@work.example.')
  })

  it('shows event text from calendars as plain text on the card', async () => {
    const sneaky = services({
      recurring: false,
      draft: draft({ title: 'Lunch\u001b[2J‮evil', repeat: null }),
    })
    const p = await previewTool(sneaky, t('ordo_calendar_delete'), { uid: 'ev-1' })
    expect([...p.title].some((c) => c === '\u001b' || c === '\u202e')).toBe(false)
  })

  it('only says “You asked for this” for the user’s own title, and for edits by uid', () => {
    expect(t('ordo_calendar_add').named!({ title: 'Dentist' } as never)).toEqual(['Dentist'])
    expect(t('ordo_calendar_edit').named!({ uid: 'ev-1' } as never)).toEqual(['ev-1'])
    expect(t('ordo_calendar_add').intent!.test('Add a dentist appointment on Friday at 9')).toBe(true)
    expect(t('ordo_calendar_delete').intent!.test('Cancel my standup tomorrow')).toBe(true)
    expect(t('ordo_calendar_add').intent!.test('What’s on my calendar?')).toBe(false)
  })
})
