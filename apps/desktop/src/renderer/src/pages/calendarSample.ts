import {
  addDays,
  daysIn,
  overlaps,
  startOfDay,
  type CalendarEvent,
  type DateRange,
} from '@ordo/calendar-core'
import type { CalendarListItem } from '@ordo/shared'

// Fictional calendars used to preview Calendar before an account is connected.
export const SAMPLE_CALENDARS: CalendarListItem[] = [
  { id: 'home', name: 'Home', color: '#1badf8', readOnly: false, visible: true },
  { id: 'work', name: 'Work', color: '#ff9500', readOnly: false, visible: true },
  { id: 'family', name: 'Family', color: '#34c759', readOnly: false, visible: true },
  { id: 'holidays', name: 'Holidays', color: '#cc73e1', readOnly: true, visible: true },
]

const at = (day: Date, hour: number, minute = 0) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute)

const event = (
  calendarId: string,
  uid: string,
  title: string,
  start: Date,
  end: Date,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent => ({ uid, calendarId, title, start, end, allDay: false, ...extra })

const allDay = (calendarId: string, uid: string, title: string, first: Date, days: number): CalendarEvent =>
  event(calendarId, uid, title, startOfDay(first), addDays(startOfDay(first), days), { allDay: true })

/** A believable few weeks of events around `today`, generated for whatever range is on screen. */
export function sampleEvents(range: DateRange, today = new Date()): CalendarEvent[] {
  const t = startOfDay(today)
  const out: CalendarEvent[] = []
  for (const day of daysIn({ start: addDays(range.start, -1), end: range.end })) {
    const dow = day.getDay()
    const key = day.toDateString()
    const weekday = dow >= 1 && dow <= 5
    if (weekday)
      out.push(
        event('work', `standup-${key}`, 'Team standup', at(day, 9, 30), at(day, 9, 45), {
          location: 'Zoom',
          recurrenceId: key,
        }),
      )
    if (dow === 2)
      out.push(
        event('work', `one-to-one-${key}`, '1:1 with Priya', at(day, 14), at(day, 14, 30), {
          recurrenceId: key,
        }),
      )
    if (dow === 1 || dow === 3 || dow === 5)
      out.push(
        event('home', `gym-${key}`, 'Gym', at(day, 18, 30), at(day, 19, 30), {
          location: 'Riverside Leisure Centre',
          recurrenceId: key,
        }),
      )
    if (dow === 0)
      out.push(
        event('family', `call-${key}`, 'Call Mum', at(day, 17), at(day, 17, 30), { recurrenceId: key }),
      )
    if (day.getMonth() === 11 && day.getDate() === 25)
      out.push(allDay('holidays', `xmas-${key}`, 'Christmas Day', day, 1))
    if (day.getMonth() === 0 && day.getDate() === 1)
      out.push(allDay('holidays', `ny-${key}`, 'New Year’s Day', day, 1))
  }

  const nextFriday = addDays(t, ((5 - t.getDay() + 7) % 7) + 7)
  out.push(
    event('work', 'review', 'Design review', at(t, 10), at(t, 11), {
      location: 'Room 4',
      notes: 'Walk through the new onboarding flow. Bring feedback from last week’s user sessions.',
    }),
    event('home', 'coffee', 'Coffee with Alex', at(t, 10, 30), at(t, 11, 15), { location: 'Kin Café' }),
    event('home', 'dinner', 'Dinner with Sam', at(addDays(t, 1), 19, 30), at(addDays(t, 1), 21, 30), {
      location: 'Dishoom, King’s Cross',
    }),
    event('work', 'planning', 'Quarterly planning', at(addDays(t, 2), 13), at(addDays(t, 2), 16), {
      location: 'Board room',
    }),
    event('home', 'dentist', 'Dentist', at(addDays(t, 5), 8, 40), at(addDays(t, 5), 9, 20), {
      location: 'Smile Dental, 12 High Street',
    }),
    allDay('family', 'lisbon', 'Weekend in Lisbon', nextFriday, 3),
    allDay('family', 'birthday', 'Mum’s birthday', addDays(t, 9), 1),
    allDay('work', 'offsite', 'Team offsite', addDays(t, -6), 2),
    event('home', 'flight', 'Flight to Lisbon', at(nextFriday, 7, 15), at(nextFriday, 9, 50), {
      location: 'Gatwick North Terminal',
    }),
  )
  return out
    .filter((e) => overlaps(e.start, e.end, range))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
}
