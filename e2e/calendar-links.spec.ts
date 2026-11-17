import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// A local server stands in for Google: no iCloud account, no real calendars.

const pad = (n: number) => String(n).padStart(2, '0')
const today = new Date()
const ymd = `${today.getFullYear()}${pad(today.getMonth() + 1)}${pad(today.getDate())}`

const ics = (name: string, events: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ordo test//EN',
    `X-WR-CALNAME:${name}`,
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n')

const WORK = ics('Work (Google)', [
  'BEGIN:VEVENT',
  'UID:planning@test',
  `DTSTART:${ymd}T100000`,
  `DTEND:${ymd}T110000`,
  'SUMMARY:Quarterly planning',
  'END:VEVENT',
])

const HOLIDAYS = ics('Holidays', [
  'BEGIN:VEVENT',
  'UID:holiday@test',
  `DTSTART;VALUE=DATE:${ymd}`,
  'SUMMARY:Office closed',
  'END:VEVENT',
])

let server: Server
let base: string
let workStatus = 200
let app: ElectronApplication
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/work.ics' && workStatus === 200) {
      res.writeHead(200, { 'content-type': 'text/calendar' }).end(WORK)
    } else if (req.url === '/sign-in') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Sign in</title>')
    } else res.writeHead(404).end('Not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  app = await launchApp({ ORDO_TEST_ALLOW_LOOPBACK_HTTP: '1' })
  page = await app.firstWindow()
  await page.getByRole('navigation').getByRole('button', { name: 'Calendar' }).click()
})

test.afterAll(async () => {
  await app.close()
  server.close()
})

const sheet = () => page.getByRole('dialog', { name: 'Add a calendar' })
const link = () => sheet().getByLabel('Calendar link')

test('subscribes to a calendar by its link without iCloud', async () => {
  await expect(page.getByText('Sample data.')).toBeVisible()
  await page.getByRole('button', { name: 'Add calendar…' }).first().click()

  await link().fill('http://example.com/work.ics')
  await sheet().getByRole('button', { name: 'Subscribe' }).click()
  await expect(sheet().getByText(/only subscribes over a secure link/)).toBeVisible()

  await link().fill(`${base}/sign-in`)
  await sheet().getByRole('button', { name: 'Subscribe' }).click()
  await expect(sheet().getByText(/didn’t return a calendar/)).toBeVisible()

  await link().fill(`${base}/work.ics`)
  await sheet().getByRole('button', { name: 'Subscribe' }).click()
  await expect(sheet()).toBeHidden()

  await expect(page.getByText('Sample data.')).toBeHidden()
  const list = page.getByRole('complementary', { name: 'Calendars' })
  await expect(list.getByRole('heading', { name: 'Other calendars' })).toBeVisible()
  await expect(list.getByRole('checkbox', { name: 'Show Work (Google)' })).toBeChecked()
  await expect(page.getByRole('grid', { name: 'Month' }).getByText('Quarterly planning')).toBeVisible()
})

test("won't add the same link twice", async () => {
  await page.getByRole('button', { name: 'Add calendar…' }).click()
  await link().fill(`${base}/work.ics`)
  await sheet().getByRole('button', { name: 'Subscribe' }).click()
  await expect(sheet().getByText('You’ve already added this calendar.')).toBeVisible()
  await sheet().getByRole('button', { name: 'Cancel' }).click()
})

test('imports an .ics file as a calendar of its own', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ordo-ics-')), 'holidays.ics')
  writeFileSync(file, HOLIDAYS)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, file)
  await page.getByRole('button', { name: 'Add calendar…' }).click()
  await sheet().getByRole('button', { name: 'Import .ics file…' }).click()
  await expect(sheet()).toBeHidden()
  await expect(page.getByRole('checkbox', { name: 'Show Holidays' })).toBeChecked()
  await expect(page.getByRole('grid', { name: 'Month' }).getByText('Office closed')).toBeVisible()
})

test('a link that stops working is reported without losing its events', async () => {
  workStatus = 404
  await page.getByRole('button', { name: 'Sync calendars' }).click()
  await expect(
    page.getByText(/Couldn’t update Work \(Google\)\. Nothing was found at that link/),
  ).toBeVisible()
  await expect(page.getByRole('grid', { name: 'Month' }).getByText('Quarterly planning')).toBeVisible()
  workStatus = 200
})

test('removes added calendars, back to the sample when none are left', async () => {
  for (const name of ['Work (Google)', 'Holidays']) {
    await page.getByRole('checkbox', { name: `Show ${name}` }).hover()
    await page.getByRole('button', { name: `Remove ${name}` }).click()
    const confirm = page.getByRole('dialog', { name: `Remove “${name}”?` })
    await confirm.getByRole('button', { name: 'Remove' }).click()
    await expect(confirm).toBeHidden()
  }
  await expect(page.getByText('Sample data.')).toBeVisible()
})
