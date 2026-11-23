import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeGoogle, type FakeGoogle } from '../test/fake-google'
import { launchApp } from './launch'

// A fake Google on 127.0.0.1 stands in for Google's OAuth and Calendar API: no real account, no
// browser (the unpackaged app follows the fake's consent page itself), no iCloud.

let fake: FakeGoogle
let app: ElectronApplication
let page: Page

const today = new Date()
const at = (hour: number) =>
  new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour).toISOString()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fake = await startFakeGoogle()
  fake.addCalendar({ id: fake.account.email, summary: 'Work', accessRole: 'owner', primary: true })
  fake.addCalendar({ id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'reader' })
  fake.put(fake.account.email, {
    summary: 'Design review',
    start: { dateTime: at(10) },
    end: { dateTime: at(11) },
  })
  app = await launchApp({ ORDO_GOOGLE_BASE_URL: fake.base, ORDO_TEST_GOOGLE_AUTO_CONSENT: '1' })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await fake.stop()
})

const google = () => page.getByRole('region', { name: 'Google' })

test('connects a Google account from Settings with your own OAuth client', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await expect(google()).toBeVisible()
  await google().getByLabel('Client ID').fill('not-a-client')
  await google().getByRole('button', { name: 'Save client' }).click()
  await expect(google().getByText(/ending in \.apps\.googleusercontent\.com/)).toBeVisible()
  await google().getByLabel('Client ID').fill(fake.clientId)
  await google().getByLabel('Client secret').fill(fake.clientSecret)
  await google().getByRole('button', { name: 'Save client' }).click()
  await expect(google().getByText(fake.clientId)).toBeVisible()

  await google().getByRole('button', { name: 'Connect Google account' }).click()
  await expect(google().getByText(fake.account.email)).toBeVisible()
  const list = google().getByRole('list', { name: `Calendars in ${fake.account.email}` })
  await expect(list.getByRole('checkbox', { name: 'Show Work' })).toBeChecked()
  await expect(list.getByText('read only')).toBeVisible()
})

test('shows the Google calendars and events on the Calendar page, by account', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByText('Sample data.')).toBeHidden()
  const calendars = page.getByRole('complementary', { name: 'Calendars' })
  await expect(calendars.getByRole('heading', { name: fake.account.email })).toBeVisible()
  await expect(calendars.getByRole('checkbox', { name: 'Show Work' })).toBeChecked()
  await expect(page.getByText('Design review').first()).toBeVisible()
})

test('signs out: revokes and removes the calendars', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await google().getByRole('button', { name: 'Sign out' }).click()
  await expect(google().getByText(fake.account.email)).toBeHidden()
  expect(fake.revoked.length).toBe(1)
})
