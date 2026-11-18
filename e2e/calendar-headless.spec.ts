import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { DAVClient, type DAVCalendar } from 'tsdav'
import { test, expect } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'
import { electronPath, headlessEnv, json, ordo, TEST_SWITCHES, tempProfile } from './headless'

// calendar add, edit and delete from the command line and MCP, against Radicale (CalDAV) and
// GreenMail (the account). The account is connected once in the window, as a user would.

const caldavPort = process.env['CALDAV_TEST_PORT']
const serverUrl = `http://127.0.0.1:${caldavPort}/`
const CALENDAR = 'Headless (e2e)'

const pad = (n: number) => String(n).padStart(2, '0')
const now = new Date()
const ym = `${now.getFullYear()}${pad(now.getMonth() + 1)}`
const day = (d: number) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(d)}`
const lastDay = day(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate())
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

test.describe.configure({ mode: 'serial' })
test.skip(!caldavPort || !imapPort, 'Needs CALDAV_TEST_PORT and IMAP_TEST_PORT (Radicale and GreenMail)')

const profile = tempProfile()
const env = () => ({ ORDO_IMAP_HOST: '127.0.0.1', ORDO_IMAP_PORT: imapPort!, ORDO_CALDAV_URL: serverUrl })
const cli = (...args: string[]) => ordo(args, profile, env())
const change = (...args: string[]) => cli(...args, '--allow-changes', '--confirm', '--json')
let admin: DAVClient

async function onServer(): Promise<string[]> {
  const calendar = (await admin.fetchCalendars()).find((c) => c.displayName === CALENDAR) as DAVCalendar
  return (await admin.fetchCalendarObjects({ calendar })).map((o) => String(o.data))
}

type Listed = {
  title: string
  uid: string
  occurrence: string | null
  location: string | null
  calendar: string
}
async function listed(): Promise<Listed[]> {
  const r = await cli('calendar', 'events', '--from', day(1), '--to', lastDay, '--json')
  expect(r.code).toBe(0)
  return json<{ events: Listed[] }>(r).events.filter((e) => e.calendar === CALENDAR)
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
  for (const c of await admin.fetchCalendars())
    if (c.displayName === CALENDAR) await admin.deleteObject({ url: c.url })
  await admin.makeCalendar({
    url: `${admin.account!.homeUrl}e2e-headless-${Date.now()}/`,
    props: { displayname: CALENDAR },
  })

  const app = await launchApp({ ORDO_USER_DATA: profile, ...env() })
  const page = await app.firstWindow()
  await page.getByRole('navigation').getByRole('button', { name: 'Mail', exact: true }).click()
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
  await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Unclutter' })).toBeVisible()
  await app.close()
})

test('calendar sync and list show which calendars can be changed', async () => {
  expect((await cli('calendar', 'sync')).code).toBe(0)
  const r = await cli('calendar', 'list', '--json')
  expect(json<{ calendars: unknown[] }>(r).calendars).toContainEqual(
    expect.objectContaining({ name: CALENDAR, source: 'icloud', readOnly: false }),
  )
})

test('calendar add is gated, then writes to the server', async () => {
  const add = [
    'calendar',
    'add',
    '--calendar',
    CALENDAR,
    '--title',
    'Car service',
    '--start',
    `${day(12)}T08:30`,
    '--repeat',
    'weekly',
    '--count',
    '3',
    '--alert',
    '60',
  ]
  expect((await cli(...add, '--confirm')).code).toBe(3)
  expect((await cli(...add, '--allow-changes')).code).toBe(3)
  expect(await onServer()).toEqual([])

  const r = await change(...add)
  expect(r.code).toBe(0)
  expect(json(r)).toMatchObject({
    calendar: CALENDAR,
    event: { title: 'Car service', end: `${day(12)}T09:30` },
  })
  const [saved] = await onServer()
  expect(saved).toContain(`DTSTART;TZID=${zone}:${ym}12T083000`)
  expect(saved).toContain('RRULE:FREQ=WEEKLY;COUNT=3')
  expect(saved).toContain('TRIGGER:-PT1H')
  expect((await listed()).map((e) => e.title)).toEqual(['Car service', 'Car service', 'Car service'])
})

test('calendar edit asks which occurrence, then changes one or all', async () => {
  const [first, second] = await listed()
  const unclear = await cli(
    'calendar',
    'edit',
    '--uid',
    first!.uid,
    '--title',
    'MOT',
    '--allow-changes',
    '--confirm',
  )
  expect(unclear.code).toBe(2)
  expect(unclear.stderr).toMatch(/--occurrence/)

  expect(
    (
      await change(
        'calendar',
        'edit',
        '--uid',
        second!.uid,
        '--occurrence',
        second!.occurrence!,
        '--start',
        `${day(20)}T10:00`,
      )
    ).code,
  ).toBe(0)
  expect((await onServer())[0]).toContain(`RECURRENCE-ID;TZID=${zone}:${ym}19T083000`)

  expect((await change('calendar', 'edit', '--uid', first!.uid, '--all', '--location', 'Garage')).code).toBe(
    0,
  )
  expect((await listed()).map((e) => e.location)).toEqual(['Garage', 'Garage', 'Garage'])
})

test('the MCP tool deletes one occurrence, with confirm', async () => {
  const third = (await listed())[2]!
  const transport = new StdioClientTransport({
    command: electronPath,
    args: [...TEST_SWITCHES, 'apps/desktop', '--headless', '--mcp', '--allow-changes'],
    env: headlessEnv(profile, env()),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'ordo-e2e', version: '1.0.0' })
  await client.connect(transport)
  try {
    const refused = (await client.callTool({
      name: 'ordo_calendar_delete',
      arguments: { uid: third.uid, occurrence: third.occurrence },
    })) as CallToolResult
    expect(refused.isError).toBe(true)
    const done = (await client.callTool({
      name: 'ordo_calendar_delete',
      arguments: { uid: third.uid, occurrence: third.occurrence, confirm: true },
    })) as CallToolResult
    expect(done.isError).toBeFalsy()
  } finally {
    await client.close()
  }
  expect(await listed()).toHaveLength(2)
  expect((await onServer())[0]).toContain(`EXDATE;TZID=${zone}:${ym}26T083000`)
})

test('calendar delete --all removes the series from the server', async () => {
  const [first] = await listed()
  expect((await change('calendar', 'delete', '--uid', first!.uid, '--all')).code).toBe(0)
  expect(await onServer()).toEqual([])
  expect(await listed()).toEqual([])
})
