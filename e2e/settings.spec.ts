import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// One profile for the whole file, so the last test can check the theme survives a relaunch.
const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-settings-'))
const launch = () => launchApp({ ORDO_USER_DATA: userData })

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launch()
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

const LIGHT = 'rgb(255, 255, 255)'
const DARK = 'rgb(30, 30, 30)'
/** The content area's background, painted from the `--content` token. */
const contentBackground = () => page.locator('main').evaluate((el) => getComputedStyle(el).backgroundColor)
const themeRadio = (name: string) =>
  page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name })

test('opens Settings from the sidebar', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible()
  await expect(themeRadio('System')).toBeChecked()
})

test('choosing Dark and Light restyles the app', async () => {
  await themeRadio('Dark').click()
  await expect(themeRadio('Dark')).toBeChecked()
  await expect.poll(contentBackground).toBe(DARK)
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true)
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')

  await themeRadio('Light').click()
  await expect(themeRadio('Light')).toBeChecked()
  await expect.poll(contentBackground).toBe(LIGHT)
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(false)
})

test('arrow keys move the choice', async () => {
  await themeRadio('Light').focus()
  await page.keyboard.press('ArrowRight')
  await expect(themeRadio('Dark')).toBeChecked()
  await expect(themeRadio('Dark')).toBeFocused()
  await expect.poll(contentBackground).toBe(DARK)
})

test('the theme is saved and survives a relaunch', async () => {
  expect(JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'dark' })

  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
  await expect.poll(contentBackground).toBe(DARK)

  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await expect(themeRadio('Dark')).toBeChecked()
})

test('the toolbar is frosted glass, and solid when transparency is reduced', async () => {
  const reducedByOs = await page.evaluate(
    async () =>
      (await window.ordo.settings.appearance()).reducedTransparency ||
      matchMedia('(prefers-reduced-transparency: reduce)').matches,
  )
  test.skip(reducedByOs, 'This machine already has Reduce transparency on')
  const look = () =>
    page.locator('main > header').evaluate((el) => {
      const s = getComputedStyle(el)
      return { filter: s.backdropFilter, background: s.backgroundColor }
    })
  expect(await look()).toEqual({ filter: 'blur(24px) saturate(1.8)', background: 'rgba(30, 30, 30, 0.7)' })

  // The renderer sets this class when the main process reports the OS asks for reduced transparency.
  await page.evaluate(() => document.documentElement.classList.add('reduce-transparency'))
  expect(await look()).toEqual({ filter: 'none', background: DARK })
  await page.evaluate(() => document.documentElement.classList.remove('reduce-transparency'))
})
