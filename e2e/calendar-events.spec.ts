import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DAVClient, type DAVCalendar } from 'tsdav'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'

// Creating, changing and deleting events against a real CalDAV server (Radicale) and a local
// IMAP server (GreenMail), which together stand in for an iCloud account. Nothing real is used.
//
//   pnpm caldav:start && pnpm imap:start
//   CALDAV_TEST_PORT=5232 IMAP_TEST_PORT=3143 npx playwright test calendar-events

const caldavPort = process.env['CALDAV_TEST_PORT']
const serverUrl = `http://127.0.0.1:${caldavPort}/`
const CALENDAR = 'Home (e2e)'
const shots = 'test-results/calendar-events'

const pad = (n: number) => String(n).padStart(2, '0')
const now = new Date()
const ym = `${now.getFullYear()}${pad(now.getMonth() + 1)}`
const day = (d: number) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

let app: ElectronApplication
let page: Page
let admin: DAVClient
let feed: Server
let feedUrl: string

test.describe.configure({ mode: 'serial' })
test.skip(!caldavPort || !imapPort, 'Needs CALDAV_TEST_PORT and IMAP_TEST_PORT (Radicale and GreenMail)')

const ics = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ordo e2e//EN', ...lines, 'END:VCALENDAR', ''].join('\r\n')

async function home(): Promise<DAVCalendar> {
  return (await admin.fetchCalendars()).find((c) => c.displayName === CALENDAR)!
}

/** What the server has for event `summary`, read straight from Radicale. */
async function onServer(summary: RegExp): Promise<string[]> {
  const objects = await admin.fetchCalendarObjects({ calendar: await home() })
  return objects.map((o) => String(o.data)).filter((d) => summary.test(d))
}

test.beforeAll(async () => {
  await seedMailbox()
  admin = new DAVClient({
    serverUrl,
    credentials: { username: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })
  await admin.login()
  // A fresh calendar each run.
  for (const c of await admin.fetchCalendars())
    if (c.displayName === CALENDAR) await admin.deleteObject({ url: c.url })
  await admin.makeCalendar({
    url: `${admin.account!.homeUrl}e2e-home-${Date.now()}/`,
    props: { displayname: CALENDAR, 'ca:calendar-color': '#34C759FF' },
  })
  // A daily series on the 8th to the 10th of this month, so it's all in the month view.
  await admin.createCalendarObject({
    calendar: await home(),
    filename: 'standup.ics',
    iCalString: ics(
      'BEGIN:VEVENT',
      'UID:standup-e2e',
      `DTSTAMP:${ym}01T000000Z`,
      `DTSTART;TZID=${zone}:${ym}08T090000`,
      `DTEND;TZID=${zone}:${ym}08T093000`,
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Standup',
      'END:VEVENT',
    ),
  })

  // A calendar added by link, which is read-only.
  feed = createServer((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/calendar' })
      .end(
        ics(
          'X-WR-CALNAME:Team (link)',
          'BEGIN:VEVENT',
          'UID:offsite-e2e',
          `DTSTART;VALUE=DATE:${ym}20`,
          'SUMMARY:Team offsite',
          'END:VEVENT',
        ),
      ),
  )
  await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve))
  feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/team.ics`

  app = await launchApp({
    ORDO_IMAP_HOST: '127.0.0.1',
    ORDO_IMAP_PORT: imapPort!,
    ORDO_CALDAV_URL: serverUrl,
    ORDO_TEST_ALLOW_LOOPBACK_HTTP: '1',
  })
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1240, 860))
  await page.evaluate(() => {
    localStorage.setItem('ordo.calendar.view', 'month')
  })

  // Connect the "iCloud" account.
  await page.getByRole('navigation').getByRole('button', { name: 'Mail', exact: true }).click()
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
  await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
  await page
    .getByRole('dialog', { name: 'Connect iCloud Mail' })
    .getByRole('button', { name: 'Connect', exact: true })
    .click()
  await expect(page.getByRole('dialog', { name: 'Connect iCloud Mail' })).toBeHidden()

  await page.getByRole('navigation').getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByRole('checkbox', { name: `Show ${CALENDAR}` })).toBeVisible({ timeout: 20_000 })
  // Only this run's calendar, so other calendars on the test server don't get in the way.
  for (const box of await page.getByRole('complementary', { name: 'Calendars' }).getByRole('checkbox').all())
    if ((await box.getAttribute('aria-label')) !== `Show ${CALENDAR}`) await box.uncheck()
})

test.afterAll(async () => {
  await app?.close()
  feed?.close()
})

const grid = () => page.getByRole('grid', { name: 'Month' })
const editor = (name = 'New event') => page.getByRole('dialog', { name })
const standups = () => grid().getByRole('button', { name: /Standup/ })

async function setTime(
  dialog: ReturnType<typeof editor>,
  which: 'Start' | 'End',
  date: string,
  time?: string,
) {
  await dialog.getByLabel(`${which} date`).fill(date)
  if (time) await dialog.getByLabel(`${which} time`).fill(time)
}

async function shoot(name: string) {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => window.ordo.settings.set({ theme: t }), theme)
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${shots}/${name}-${theme}.png`, animations: 'disabled' })
  }
  await page.evaluate(() => window.ordo.settings.set({ theme: 'system' }))
}

/** The element really on top at the middle of `locator` is inside it (nothing covers it). */
async function onTop(locator: ReturnType<Page['locator']>) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && el.contains(hit)
  })
}

const week = () =>
  page.getByRole('radiogroup', { name: 'Calendar view' }).getByRole('radio', { name: 'Week' })
const month = () =>
  page.getByRole('radiogroup', { name: 'Calendar view' }).getByRole('radio', { name: 'Month' })
const announced = () => page.getByTestId('week-announce')

test('the series from the server shows in the month view', async () => {
  await expect(standups()).toHaveCount(3)
})

test('New event creates an event on iCloud, shown at once', async () => {
  await page.getByRole('button', { name: 'New event' }).click()
  const sheet = editor()
  await expect(sheet.getByLabel('Title')).toBeFocused()
  await sheet.getByLabel('Title').fill('Dentist')
  await sheet.getByLabel('Location').fill('High Street')
  await setTime(sheet, 'Start', day(15), '14:00')
  // The end moved with the start, keeping an hour.
  await expect(sheet.getByLabel('End time')).toHaveValue('15:00')
  // This computer's own zone is a quiet line, not a list.
  await expect(sheet.getByRole('button', { name: 'Change…' })).toBeVisible()
  await expect(sheet.getByLabel('Time zone')).toHaveCount(0)
  await sheet.getByLabel('Alert').selectOption({ label: '15 minutes before' })
  if (process.env['ORDO_SCREENSHOTS']) await shoot('new-event')
  await sheet.getByRole('button', { name: 'Add event' }).click()
  await expect(sheet).toBeHidden()
  await expect(grid().getByRole('button', { name: /Dentist/ })).toBeVisible()
  // Focus goes to the new event.
  await expect(grid().getByRole('button', { name: /Dentist/ })).toBeFocused()

  await expect.poll(() => onServer(/SUMMARY:Dentist/)).toHaveLength(1)
  const [saved] = await onServer(/SUMMARY:Dentist/)
  expect(saved).toContain(`DTSTART;TZID=${zone}:${ym}15T140000`)
  expect(saved).toContain('LOCATION:High Street')
  expect(saved).toContain('TRIGGER:-PT15M')
})

test('the editor says what’s wrong next to the times', async () => {
  await page.getByRole('button', { name: 'New event' }).click()
  const sheet = editor()
  await setTime(sheet, 'Start', day(15), '14:00')
  await sheet.getByLabel('End time').fill('13:00')
  await sheet.getByRole('button', { name: 'Add event' }).click()
  await expect(sheet.getByRole('alert')).toHaveText('The event ends before it starts.')
  await expect(sheet.getByLabel('End time')).toHaveAttribute('aria-invalid', 'true')
  await expect(sheet.getByLabel('End time')).toBeFocused()
  if (process.env['ORDO_SCREENSHOTS']) await shoot('validation')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
})

test('Cmd-N and double-clicking a day open a new event', async () => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+N' : 'Control+N')
  await expect(editor()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editor()).toBeHidden()

  const cell = grid()
    .getByRole('gridcell')
    .filter({ has: page.getByRole('button', { name: '22', exact: true }) })
  await cell.first().dblclick({ position: { x: 10, y: 60 } })
  await expect(editor().getByLabel('Start date')).toHaveValue(day(22))
  await editor().getByRole('button', { name: 'Cancel' }).click()
})

test('double-clicking an event edits it, without leaving its popover open', async () => {
  const dentist = grid().getByRole('button', { name: /Dentist/ })
  await dentist.dblclick()
  await expect(editor('Edit event')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Dentist' })).toBeHidden()
  await editor('Edit event').getByRole('button', { name: 'Cancel' }).click()
  // Focus goes back to the event.
  await expect(dentist).toBeFocused()
})

test('edits an event from its popover', async () => {
  await grid()
    .getByRole('button', { name: /Dentist/ })
    .click()
  const popover = page.getByRole('dialog', { name: 'Dentist' })
  await expect(popover.getByRole('button', { name: 'Edit…' })).toBeEnabled()
  if (process.env['ORDO_SCREENSHOTS']) await shoot('popover')
  await popover.getByRole('button', { name: 'Edit…' }).click()

  const sheet = editor('Edit event')
  await expect(sheet.getByLabel('Title')).toHaveValue('Dentist')
  await sheet.getByLabel('Title').fill('Dentist (check-up)')
  await setTime(sheet, 'Start', day(16), '10:30')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  await expect(grid().getByRole('button', { name: /Dentist \(check-up\)/ })).toBeVisible()
  await expect
    .poll(async () => (await onServer(/UID:/)).find((d) => d.includes('check-up')) ?? '')
    .toContain(`DTSTART;TZID=${zone}:${ym}16T103000`)
})

test('cancelling a delete from the editor goes back to the editor, keeping its changes', async () => {
  await grid()
    .getByRole('button', { name: /Dentist/ })
    .dblclick()
  const sheet = editor('Edit event')
  await sheet.getByLabel('Location').fill('Dental Practice')
  await sheet.getByRole('button', { name: 'Delete…' }).click()
  const confirm = page.getByRole('dialog', { name: /^Delete “Dentist/ })
  await expect(confirm.getByText('You can’t undo this.', { exact: false })).toBeVisible()
  // Cancel has focus, so Return can't delete.
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  if (process.env['ORDO_SCREENSHOTS']) await shoot('delete-confirm')
  await page.keyboard.press('Enter')
  await expect(confirm).toBeHidden()
  await expect(editor('Edit event').getByLabel('Location')).toHaveValue('Dental Practice')
  await editor('Edit event').getByRole('button', { name: 'Cancel' }).click()
  expect(await onServer(/Dentist/)).toHaveLength(1)
})

test('changes one occurrence of a repeating event, after asking', async () => {
  await standups().nth(1).dblclick()
  const sheet = editor('Edit event')
  await expect(sheet.getByText('Changing how it repeats changes every event in the series.')).toBeVisible()
  await sheet.getByLabel('Title').fill('Standup (late)')
  await sheet.getByLabel('Start time').fill('11:00')
  await sheet.getByRole('button', { name: 'Save' }).click()
  const ask = page.getByRole('dialog', { name: 'Change a repeating event?' })
  await expect(ask.getByRole('button', { name: 'This event only' })).toBeFocused()
  if (process.env['ORDO_SCREENSHOTS']) await shoot('repeating')
  await ask.getByRole('button', { name: 'This event only' }).click()

  await expect(grid().getByRole('button', { name: /Standup \(late\)/ })).toBeVisible()
  await expect(grid().getByRole('button', { name: /^Standup \d/ })).toHaveCount(2)
  await expect
    .poll(async () => (await onServer(/standup-e2e/))[0] ?? '')
    .toContain(`RECURRENCE-ID;TZID=${zone}:${ym}09T090000`)
})

test('deletes one occurrence of a repeating event', async () => {
  await standups().nth(2).click()
  await page.getByRole('dialog', { name: 'Standup' }).getByRole('button', { name: 'Delete…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete a repeating event?' })
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Delete this event only' }).click()
  await expect(standups()).toHaveCount(2)
  await expect
    .poll(async () => (await onServer(/standup-e2e/))[0] ?? '')
    .toContain(`EXDATE;TZID=${zone}:${ym}10T090000`)
})

test('a change made elsewhere first is never overwritten', async () => {
  const [obj] = (await admin.fetchCalendarObjects({ calendar: await home() })).filter((o) =>
    String(o.data).includes('check-up'),
  )
  const res = await admin.updateCalendarObject({
    calendarObject: {
      ...obj!,
      data: String(obj!.data).replace('SUMMARY:Dentist (check-up)', 'SUMMARY:Dentist (from iPhone)'),
    },
  })
  expect(res.ok).toBe(true)

  await grid()
    .getByRole('button', { name: /Dentist \(check-up\)/ })
    .dblclick()
  await editor('Edit event').getByLabel('Title').fill('Dentist (mine)')
  await editor('Edit event').getByRole('button', { name: 'Save' }).click()
  const notice = page.getByRole('alert')
  await expect(notice).toContainText('changed somewhere else')
  await expect(notice).toHaveAttribute('data-kind', 'error')
  // The latest version shows, and the server still has it.
  await expect(grid().getByRole('button', { name: /Dentist \(from iPhone\)/ })).toBeVisible()
  expect(await onServer(/Dentist \(from iPhone\)/)).toHaveLength(1)
  await page.getByRole('button', { name: 'Dismiss' }).click()
})

test('sheets sit above the week view’s header', async () => {
  await grid().getByRole('button', { name: '16', exact: true }).click()
  await expect(week()).toHaveAttribute('aria-checked', 'true')
  const block = page.getByTestId('week-event').filter({ hasText: 'Dentist' })
  await block.dblclick()
  const sheet = editor('Edit event')
  await expect(sheet).toBeVisible()
  expect(await onTop(sheet.getByRole('heading', { name: 'Edit event' }))).toBe(true)
  expect(await onTop(sheet.getByLabel('Title'))).toBe(true)
  await sheet.getByRole('button', { name: 'Cancel' }).click()
})

test('moves an event in the week view with the keyboard, and by dragging', async () => {
  const block = page.getByTestId('week-event').filter({ hasText: 'Dentist' })
  await expect(block).toBeVisible()
  await block.focus()
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('Alt+ArrowDown')
  // While it's moving, the block shows where it will start and end.
  await expect(block.getByTestId('move-times')).toBeVisible()
  await expect(announced()).toHaveText('Saved.', { timeout: 10_000 })
  await expect
    .poll(async () => (await onServer(/Dentist/))[0] ?? '', { timeout: 10_000 })
    .toContain(`DTSTART;TZID=${zone}:${ym}16T110000`)
  // Focus stays on the event it moved.
  await expect(block).toBeFocused()
  if (process.env['ORDO_SCREENSHOTS']) await shoot('week')

  const box = (await block.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 8)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 24, { steps: 4 }) // 30 minutes later
  await page.mouse.move(box.x + box.width / 2, box.y + 8 + 48, { steps: 4 }) // an hour later
  await expect(block.getByTestId('move-times')).toBeVisible()
  if (process.env['ORDO_SCREENSHOTS']) await shoot('week-dragging')
  await page.mouse.up()
  await expect
    .poll(async () => (await onServer(/Dentist/))[0] ?? '', { timeout: 10_000 })
    .toContain(`DTSTART;TZID=${zone}:${ym}16T120000`)
  await expect(page.getByRole('dialog', { name: /Dentist/ })).toBeHidden()

  // Drag the bottom edge to make it 30 minutes longer.
  const after = (await block.boundingBox())!
  await page.mouse.move(after.x + after.width / 2, after.y + after.height - 2)
  await page.mouse.down()
  await page.mouse.move(after.x + after.width / 2, after.y + after.height - 2 + 24, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(async () => (await onServer(/Dentist/))[0] ?? '', { timeout: 10_000 })
    .toContain(`DTEND;TZID=${zone}:${ym}16T133000`)
})

test('a move stops at the edge of the week instead of losing the event', async () => {
  const block = page.getByTestId('week-event').filter({ hasText: 'Dentist' })
  const last = (await page.getByRole('columnheader').last().textContent())!.replace(/\D/g, '')
  await block.focus()
  for (let i = 0; i < 8; i++) await page.keyboard.press('Alt+ArrowRight')
  await expect(announced()).toHaveText(/edge of the week/)
  await expect(block).toBeVisible()
  await expect(announced()).toHaveText('Saved.', { timeout: 10_000 })
  await expect
    .poll(async () => (await onServer(/Dentist/))[0] ?? '', { timeout: 10_000 })
    .toContain(`DTSTART;TZID=${zone}:${ym}${last.padStart(2, '0')}T120000`)
  await expect(block).toBeVisible()
})

test('a repeating event stays where it was moved while Ordo asks, and goes back if cancelled', async () => {
  await month().click()
  await grid().getByRole('button', { name: '9', exact: true }).click()
  const late = page.getByTestId('week-event').filter({ hasText: 'Standup (late)' })
  await late.focus()
  await page.keyboard.press('Alt+ArrowDown')
  const ask = page.getByRole('dialog', { name: 'Change a repeating event?' })
  await expect(ask).toBeVisible({ timeout: 10_000 })
  expect(await onTop(ask.getByRole('heading'))).toBe(true)
  await expect(late.getByTestId('move-times')).toBeVisible()
  if (process.env['ORDO_SCREENSHOTS']) await shoot('week-recurring-ask')
  // Another move while Ordo is asking is ignored, rather than replacing the question.
  await late.press('Alt+ArrowDown')
  await page.waitForTimeout(1500)
  await expect(page.getByRole('dialog', { name: 'Change a repeating event?' })).toHaveCount(1)
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toBeHidden()
  await expect(announced()).toHaveText('Move cancelled.')
  await expect(late.getByTestId('move-times')).toHaveCount(0)
  await page.waitForTimeout(1500)
  await expect(page.getByRole('dialog', { name: 'Change a repeating event?' })).toHaveCount(0)
  await month().click()
})

test('calendars added by link say they’re read-only, and where to change them', async () => {
  await page.getByRole('button', { name: 'Add calendar…' }).click()
  const add = page.getByRole('dialog', { name: 'Add a calendar' })
  await add.getByLabel('Calendar link').fill(feedUrl)
  await add.getByRole('button', { name: 'Subscribe' }).click()
  await expect(add).toBeHidden()
  await grid()
    .getByRole('button', { name: /Team offsite/ })
    .click()
  const popover = page.getByRole('dialog', { name: 'Team offsite' })
  await expect(
    popover.getByText(
      'Added by link, so Ordo can’t change its events. Change them where the calendar is published.',
    ),
  ).toBeVisible()
  await expect(popover.getByText('Read only')).toHaveCount(0)
  await expect(popover.getByRole('button', { name: 'Edit…' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Double-clicking it doesn't open the editor either; it says why.
  await grid()
    .getByRole('button', { name: /Team offsite/ })
    .dblclick()
  await expect(editor('Edit event')).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: 'Added by link' })).toHaveAttribute(
    'data-kind',
    'info',
  )
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Dismiss' }).click()
})

test('deletes a whole event, and a whole series', async () => {
  await grid()
    .getByRole('button', { name: /Dentist/ })
    .click()
  await page
    .getByRole('dialog', { name: /Dentist/ })
    .getByRole('button', { name: 'Delete…' })
    .click()
  const confirm = page.getByRole('dialog', { name: /^Delete “Dentist/ })
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(grid().getByRole('button', { name: /Dentist/ })).toHaveCount(0)
  await expect.poll(() => onServer(/Dentist/)).toHaveLength(0)

  await standups().first().click()
  await page.getByRole('dialog', { name: 'Standup' }).getByRole('button', { name: 'Delete…' }).click()
  await page
    .getByRole('dialog', { name: 'Delete a repeating event?' })
    .getByRole('button', { name: 'Delete all events' })
    .click()
  await expect(standups()).toHaveCount(0)
  await expect.poll(() => onServer(/standup-e2e/)).toHaveLength(0)
})
