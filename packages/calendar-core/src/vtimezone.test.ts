import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import { utcToZoned } from './time'
import { buildVTimezone, transitions } from './vtimezone'

/** Use the generated VTIMEZONE (not the runtime's data) to turn a wall clock into an instant. */
function viaVTimezone(tz: string, from: number, to: number, wall: string): Date {
  const vtz = buildVTimezone(tz, from, to)!
  const zone = new ICAL.Timezone({ component: vtz, tzid: tz })
  const t = ICAL.Time.fromDateTimeString(wall)
  t.zone = zone
  return new Date(t.toUnixTime() * 1000)
}

const lines = (tz: string) => buildVTimezone(tz, 2026, 2036)!.toString().split(/\r?\n/)

describe('transitions', () => {
  it('finds the two UK clock changes in 2026 to the minute', () => {
    const t = transitions('Europe/London', 2026)
    expect(t.map((x) => new Date(x.at).toISOString())).toEqual([
      '2026-03-29T01:00:00.000Z',
      '2026-10-25T01:00:00.000Z',
    ])
    expect(t.map((x) => [x.from / 60_000, x.to / 60_000])).toEqual([
      [0, 60],
      [60, 0],
    ])
  })

  it('finds none where the clocks never change', () => {
    expect(transitions('Asia/Kolkata', 2026)).toEqual([])
  })
})

describe('buildVTimezone', () => {
  it('writes the UK’s yearly rules', () => {
    const l = lines('Europe/London')
    expect(l).toContain('TZID:Europe/London')
    expect(l).toContain('BEGIN:DAYLIGHT')
    expect(l).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU')
    expect(l).toContain('RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU')
    expect(l).toContain('TZOFFSETFROM:+0000')
    expect(l).toContain('TZOFFSETTO:+0100')
  })

  it('writes US rules (second Sunday of March, first of November)', () => {
    const l = lines('America/New_York')
    expect(l).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU')
    expect(l).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU')
    expect(l).toContain('TZOFFSETTO:-0400')
  })

  it('writes a single observance for a zone without DST', () => {
    const l = lines('Asia/Kolkata')
    expect(l.filter((x) => x.startsWith('BEGIN:STANDARD'))).toHaveLength(1)
    expect(l).not.toContain('BEGIN:DAYLIGHT')
    expect(l).toContain('TZOFFSETTO:+0530')
  })

  it('is null for UTC and unknown zones', () => {
    expect(buildVTimezone('UTC', 2026, 2027)).toBeNull()
    expect(buildVTimezone('Mars/Olympus', 2026, 2027)).toBeNull()
  })

  it('agrees with the runtime’s time zone data, either side of each change', () => {
    const zones = [
      'Europe/London',
      'America/New_York',
      'Australia/Sydney',
      'Asia/Kolkata',
      'Africa/Casablanca',
    ]
    const walls = [
      '2026-01-15T09:00:00',
      '2026-03-29T03:00:00',
      '2026-07-15T09:00:00',
      '2026-10-25T03:00:00',
      '2029-12-01T12:00:00',
    ]
    for (const tz of zones)
      for (const wall of walls) {
        const at = viaVTimezone(tz, 2026, 2030, wall)
        const back = utcToZoned(at, tz)
        const want = wall.slice(0, 16).replace('T', ' ')
        const got = `${back.year}-${String(back.month).padStart(2, '0')}-${String(back.day).padStart(2, '0')} ${String(back.hour).padStart(2, '0')}:${String(back.minute).padStart(2, '0')}`
        expect(`${tz} ${got}`).toBe(`${tz} ${want}`)
      }
  })
})
