import { describe, expect, it, vi } from 'vitest'
import type { EventDetails, EventDraft } from '@ordo/shared'
import { parseInvocation, UsageError } from './args'
import { runCli, type CliIo } from './cli'
import { draftFromFlags, exitCodeFor, runCommand } from './commands'
import { fakeServices } from './fake-services'

const HOME = {
  id: 'https://cal.example/home/',
  name: 'Home',
  readOnly: false,
  visible: true,
  source: 'icloud' as const,
}
const WORK = { id: 'feed:1', name: 'Work (Google)', readOnly: true, visible: true, source: 'link' as const }

const base = (o: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Standup',
  allDay: false,
  start: '2026-11-02T09:00',
  end: '2026-11-02T09:30',
  timeZone: 'Europe/London',
  location: 'Room 1',
  notes: '',
  repeat: null,
  alert: 10,
  ...o,
})

const details = (o: Partial<EventDetails> = {}): EventDetails => ({
  calendarId: HOME.id,
  draft: base(),
  recurring: false,
  editable: true,
  ...o,
})

function services(extra: Partial<ReturnType<typeof fakeServices>['calendar']> = {}) {
  const s = fakeServices()
  s.calendar = {
    ...s.calendar,
    calendars: () => [HOME, WORK],
    locate: () => [HOME.id],
    details: vi.fn(() => details()),
    ...extra,
  }
  return s
}

async function cli(s: ReturnType<typeof fakeServices>, ...args: string[]) {
  const inv = parseInvocation(args)
  if (inv.kind === 'mcp') throw new Error('not here')
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (t) => void out.push(t), err: (t) => void err.push(t), errIsTTY: false }
  const code = await runCli(inv, s, io)
  return { code, stdout: out.join(''), stderr: err.join(''), json: () => JSON.parse(out.join('')) }
}

describe('draftFromFlags', () => {
  it('makes a new timed event an hour long, or an all-day one a day long', () => {
    expect(draftFromFlags(null, { title: 'Gym', start: '2026-11-20T18:00' }, 'Europe/London')).toEqual({
      title: 'Gym',
      allDay: false,
      start: '2026-11-20T18:00',
      end: '2026-11-20T19:00',
      timeZone: 'Europe/London',
      location: '',
      notes: '',
      repeat: null,
      alert: null,
    })
    expect(
      draftFromFlags(null, { title: 'Trip', start: '2026-12-31', end: '2027-01-02' }, 'UTC'),
    ).toMatchObject({
      allDay: true,
      start: '2026-12-31',
      end: '2027-01-02',
      timeZone: null,
    })
    expect(draftFromFlags(null, { start: '2026-11-20T23:30' }, 'UTC')).toMatchObject({
      end: '2026-11-21T00:30',
    })
  })

  it('changes only what was asked, keeping an event’s length when it moves', () => {
    expect(draftFromFlags(base(), { start: '2026-11-03T14:00' }, 'UTC')).toEqual(
      base({ start: '2026-11-03T14:00', end: '2026-11-03T14:30' }),
    )
    expect(draftFromFlags(base(), { title: 'Sync', location: '' }, 'UTC')).toEqual(
      base({ title: 'Sync', location: '' }),
    )
    expect(draftFromFlags(base(), { alert: null }, 'UTC')).toEqual(base({ alert: null }))
    const allDay = base({ allDay: true, start: '2026-11-02', end: '2026-11-04', timeZone: null })
    expect(draftFromFlags(allDay, { start: '2026-11-10' }, 'UTC')).toMatchObject({
      start: '2026-11-10',
      end: '2026-11-12',
    })
  })

  it('switches between all-day and timed by the form of --start', () => {
    expect(draftFromFlags(base(), { start: '2026-11-05' }, 'UTC')).toMatchObject({
      allDay: true,
      end: '2026-11-05',
      timeZone: null,
    })
    expect(
      draftFromFlags(
        base({ allDay: true, start: '2026-11-05', end: '2026-11-05', timeZone: null }),
        { start: '2026-11-05T10:00' },
        'Asia/Tokyo',
      ),
    ).toMatchObject({ allDay: false, end: '2026-11-05T11:00', timeZone: 'Asia/Tokyo' })
  })

  it('sets, keeps and stops repeats', () => {
    const weekly = base({ repeat: { frequency: 'weekly', count: 4 } })
    expect(draftFromFlags(base(), { repeat: 'weekly', until: '2027-01-01' }, 'UTC').toString()).not.toMatch(
      /need/,
    )
    expect(draftFromFlags(weekly, { title: 'x' }, 'UTC')).toMatchObject({
      repeat: { frequency: 'weekly', count: 4 },
    })
    expect(draftFromFlags(weekly, { repeat: 'weekly' }, 'UTC')).toMatchObject({
      repeat: { frequency: 'weekly', count: 4 },
    })
    expect(draftFromFlags(weekly, { repeat: 'daily' }, 'UTC')).toMatchObject({
      repeat: { frequency: 'daily' },
    })
    expect(draftFromFlags(weekly, { count: 9 }, 'UTC')).toMatchObject({
      repeat: { frequency: 'weekly', count: 9 },
    })
    expect(draftFromFlags(weekly, { repeat: 'none' }, 'UTC')).toMatchObject({ repeat: null })
  })

  it('explains flags that don’t fit together', () => {
    expect(draftFromFlags(null, { start: '2026-11-05', end: '2026-11-05T10:00' }, 'UTC')).toBe(
      '--end must be a day too, like --start',
    )
    expect(draftFromFlags(base(), { until: '2027-01-01' }, 'UTC')).toBe('--until and --count need --repeat')
    expect(draftFromFlags(base(), { repeat: 'daily', until: '2027-01-01', count: 3 }, 'UTC')).toBe(
      'Use --until or --count, not both',
    )
  })

  it('won’t flatten a custom rule by changing only its end', () => {
    const custom = base({ repeat: { frequency: 'weekly', custom: true } })
    expect(draftFromFlags(custom, { until: '2027-01-01' }, 'UTC')).toMatch(/can’t edit from here/)
    expect(draftFromFlags(custom, { title: 'x' }, 'UTC')).toMatchObject({
      repeat: { frequency: 'weekly', custom: true },
    })
    expect(draftFromFlags(custom, { repeat: 'weekly', count: 4 }, 'UTC')).toMatchObject({
      repeat: { frequency: 'weekly', count: 4 },
    })
  })
})

describe('calendar list', () => {
  it('lists calendars and says which can be changed', async () => {
    const r = await cli(services(), 'calendar', 'list', '--json')
    expect(r.code).toBe(0)
    expect(r.json()).toEqual({
      calendars: [
        { id: HOME.id, name: 'Home', source: 'icloud', readOnly: false, visible: true },
        { id: 'feed:1', name: 'Work (Google)', source: 'link', readOnly: true, visible: true },
      ],
    })
    expect((await cli(services(), 'calendar', 'list')).stdout).toMatch(/Home\s+iCloud\s+writable/)
  })
})

describe('calendar add', () => {
  it('needs --allow-changes and --confirm, like every change', async () => {
    const s = services()
    expect(
      (
        await cli(
          s,
          'calendar',
          'add',
          '--calendar',
          'Home',
          '--title',
          'x',
          '--start',
          '2026-11-20',
          '--confirm',
        )
      ).code,
    ).toBe(3)
    expect(
      (
        await cli(
          s,
          'calendar',
          'add',
          '--calendar',
          'Home',
          '--title',
          'x',
          '--start',
          '2026-11-20',
          '--allow-changes',
        )
      ).code,
    ).toBe(3)
    expect(s.calendar.createEvent).not.toHaveBeenCalled()
  })

  it('adds to a calendar named case-insensitively, with the draft the flags describe', async () => {
    const s = services()
    const r = await cli(
      s,
      'calendar',
      'add',
      '--calendar',
      'home',
      '--title',
      'Dentist',
      '--start',
      '2026-11-20T09:00',
      '--end',
      '2026-11-20T09:40',
      '--time-zone',
      'America/New_York',
      '--location',
      'High St',
      '--repeat',
      'monthly',
      '--count',
      '3',
      '--alert',
      '30',
      '--allow-changes',
      '--confirm',
      '--json',
    )
    expect(r.code).toBe(0)
    expect(s.calendar.createEvent).toHaveBeenCalledWith({
      calendarId: HOME.id,
      draft: {
        title: 'Dentist',
        allDay: false,
        start: '2026-11-20T09:00',
        end: '2026-11-20T09:40',
        timeZone: 'America/New_York',
        location: 'High St',
        notes: '',
        repeat: { frequency: 'monthly', count: 3 },
        alert: 30,
      },
    })
    expect(r.json()).toMatchObject({ uid: 'NEW-UID', calendar: 'Home', event: { title: 'Dentist' } })
    const human = await cli(
      services(),
      'calendar',
      'add',
      '--calendar',
      'Home',
      '--title',
      'Trip',
      '--start',
      '2026-12-01',
      '--allow-changes',
      '--confirm',
    )
    expect(human.stdout).toBe('Added “Trip” to Home (2026-12-01, all day).\n')
  })

  it('refuses read-only and unknown calendars, and needs iCloud', async () => {
    const s = services()
    const add = (cal: string) =>
      runCommand(
        s,
        { name: 'calendar add', calendar: cal, title: 'x', start: '2026-11-20', confirm: true },
        { allowChanges: true },
      )
    expect(await add('Work (Google)')).toMatchObject({ ok: false, code: 'read_only' })
    expect(await add('Nope')).toMatchObject({
      ok: false,
      code: 'not_found',
      message: expect.stringContaining('calendar list'),
    })
    const offline = services()
    offline.account = () => ({ connected: false })
    expect(
      await runCommand(
        offline,
        { name: 'calendar add', calendar: 'Home', title: 'x', start: '2026-11-20', confirm: true },
        { allowChanges: true },
      ),
    ).toMatchObject({ code: 'not_connected' })
    expect(s.calendar.createEvent).not.toHaveBeenCalled()
  })

  it('validates flags with the parser', () => {
    expect(() =>
      parseInvocation(['calendar', 'add', '--calendar', 'Home', '--title', 'x', '--start', 'tomorrow']),
    ).toThrow(/--start must be a day/)
    expect(() =>
      parseInvocation([
        'calendar',
        'add',
        '--calendar',
        'Home',
        '--title',
        'x',
        '--start',
        '2026-11-20',
        '--repeat',
        'hourly',
      ]),
    ).toThrow(UsageError)
    expect(() =>
      parseInvocation([
        'calendar',
        'add',
        '--calendar',
        'Home',
        '--title',
        'x',
        '--start',
        '2026-11-20',
        '--alert',
        'soon',
      ]),
    ).toThrow(/--alert/)
    expect(() => parseInvocation(['calendar', 'add', '--title', 'x', '--start', '2026-11-20'])).toThrow(
      /--calendar/,
    )
  })

  it('maps the service’s refusals to error codes and exit codes', async () => {
    const outcomes = [
      ['conflict', 'conflict', 1],
      ['read-only', 'read_only', 1],
      ['invitation', 'read_only', 1],
      ['locked', 'locked', 4],
      ['network', 'network', 1],
      ['invalid', 'invalid', 1],
    ] as const
    for (const [error, code, exit] of outcomes) {
      const s = services({ createEvent: vi.fn(async () => ({ ok: false as const, error, message: 'no' })) })
      const r = await runCommand(
        s,
        { name: 'calendar add', calendar: 'Home', title: 'x', start: '2026-11-20', confirm: true },
        { allowChanges: true },
      )
      expect(r).toMatchObject({ ok: false, code })
      expect(exitCodeFor(r)).toBe(exit)
    }
  })
})

describe('calendar edit and delete', () => {
  it('edits only the fields given', async () => {
    const s = services()
    const r = await cli(
      s,
      'calendar',
      'edit',
      '--uid',
      'ev-1',
      '--title',
      'Retro',
      '--location=',
      '--allow-changes',
      '--confirm',
      '--json',
    )
    expect(r.code).toBe(0)
    expect(s.calendar.updateEvent).toHaveBeenCalledWith({
      ref: { calendarId: HOME.id, uid: 'ev-1' },
      draft: base({ title: 'Retro', location: '' }),
      scope: 'all',
    })
  })

  it('asks which occurrence for a repeating event, then edits one or all', async () => {
    const s = services({
      details: vi.fn(() => details({ recurring: true, draft: base({ repeat: { frequency: 'weekly' } }) })),
    })
    const edit = (...extra: string[]) =>
      cli(s, 'calendar', 'edit', '--uid', 'ev-1', '--title', 'x', '--allow-changes', '--confirm', ...extra)
    const unclear = await edit()
    expect(unclear.code).toBe(2)
    expect(unclear.stderr).toMatch(/--occurrence <id>.*or --all/)

    expect((await edit('--occurrence', '2026-11-09T09:00:00.000Z')).code).toBe(0)
    expect(s.calendar.updateEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ref: { calendarId: HOME.id, uid: 'ev-1', recurrenceId: '2026-11-09T09:00:00.000Z' },
        scope: 'this',
      }),
    )
    expect((await edit('--all')).code).toBe(0)
    expect(s.calendar.updateEvent).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'all' }))
  })

  it('says what’s wrong before calling anything', async () => {
    const none = services({ locate: () => [] })
    expect(await cli(none, 'calendar', 'delete', '--uid', 'x', '--allow-changes', '--confirm')).toMatchObject(
      { code: 1 },
    )
    const two = services({ locate: () => [HOME.id, 'other'] })
    expect(
      (await cli(two, 'calendar', 'delete', '--uid', 'x', '--allow-changes', '--confirm')).stderr,
    ).toMatch(/--calendar/)
    const invite = services({
      details: () => details({ editable: false, reason: 'This is an invitation from boss@work.example.' }),
    })
    const r = await runCommand(
      invite,
      { name: 'calendar delete', uid: 'x', all: false, confirm: true },
      { allowChanges: true },
    )
    expect(r).toEqual({
      ok: false,
      code: 'read_only',
      message: 'This is an invitation from boss@work.example.',
    })
    const single = services()
    expect(
      await runCommand(
        single,
        { name: 'calendar delete', uid: 'x', occurrence: '2026-11-02', all: false, confirm: true },
        { allowChanges: true },
      ),
    ).toMatchObject({ code: 'usage' })
    const nothing = await cli(services(), 'calendar', 'edit', '--uid', 'x', '--allow-changes', '--confirm')
    expect(nothing.stderr).toMatch(/Say what to change/)
    for (const s of [none, two, invite, single]) expect(s.calendar.deleteEvent).not.toHaveBeenCalled()
  })

  it('deletes one occurrence or the whole event', async () => {
    const s = services({ details: vi.fn(() => details({ recurring: true })) })
    const one = await cli(
      s,
      'calendar',
      'delete',
      '--uid',
      'ev-1',
      '--occurrence',
      '2026-11-09',
      '--allow-changes',
      '--confirm',
    )
    expect(one.stdout).toBe('Deleted one occurrence of “Standup”.\n')
    expect(s.calendar.deleteEvent).toHaveBeenLastCalledWith({
      ref: { calendarId: HOME.id, uid: 'ev-1', recurrenceId: '2026-11-09' },
      scope: 'this',
    })
    const all = await cli(
      s,
      'calendar',
      'delete',
      '--uid',
      'ev-1',
      '--all',
      '--allow-changes',
      '--confirm',
      '--json',
    )
    expect(all.json()).toEqual({ uid: 'ev-1', scope: 'all', title: 'Standup' })
  })

  it('names an event by uid and occurrence in calendar events --json', async () => {
    const s = services({
      events: () => [
        {
          uid: 'ev-1',
          calendarId: HOME.id,
          title: 'Standup',
          start: new Date('2026-11-09T09:00:00Z'),
          end: new Date('2026-11-09T09:30:00Z'),
          allDay: false,
          recurrenceId: '2026-11-09T09:00:00.000Z',
        },
      ],
    })
    const r = await cli(s, 'calendar', 'events', '--from', '2026-11-09', '--to', '2026-11-09', '--json')
    expect(r.json().events[0]).toMatchObject({
      uid: 'ev-1',
      occurrence: '2026-11-09T09:00:00.000Z',
      calendar: 'Home',
    })
  })
})
