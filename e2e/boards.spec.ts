import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { launchApp } from './launch'

// Boards end to end, in a throwaway profile: a board from a template, quick add, drag and drop,
// keyboard moves, card details, filters, archive, undo, the Calendar overlay, a card made from an
// event, and Suggest with a stand-in for LM Studio.

const shots = process.env['ORDO_SCREENSHOTS'] === '1'
// CI runners' screens are about 1000px wide; BOARDS_VIEWPORT=1000x700 runs the same tests at that size.
const [vw, vh] = (process.env['BOARDS_VIEWPORT'] ?? '1280x800').split('x').map(Number) as [number, number]
const VIEWPORT = { width: vw, height: vh }

let app: ElectronApplication
let page: Page
let lmStudio: Server
const prompts: string[] = []

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const inDays = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}

/** A calendar file with one event in three days, to link to and make a card from. */
function icsFile(dir: string): string {
  const day = iso(inDays(3)).replace(/-/g, '')
  const path = join(dir, 'family.ics')
  writeFileSync(
    path,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ordo e2e//EN',
      'X-WR-CALNAME:Family',
      'BEGIN:VEVENT',
      'UID:locksmith-e2e',
      'DTSTAMP:20261101T000000Z',
      `DTSTART:${day}T090000`,
      `DTEND:${day}T100000`,
      'SUMMARY:Locksmith for the gate',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n'),
  )
  return path
}

function startFakeLmStudio(): Promise<string> {
  lmStudio = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }] }))
      const prompt: string = JSON.parse(body).messages.at(-1).content
      prompts.push(prompt)
      // A slow model for one card, to show that closing the card stops the question.
      if (prompt.includes('"title":"Slow card"')) {
        setTimeout(() => res.end('{}'), 20_000).unref()
        return
      }
      // Pick the first event and label it was offered, a date and two steps.
      const event = /\{"id":"(e\d+)"[^\n]*Locksmith/.exec(prompt)?.[1] ?? null
      const content = {
        due: { date: iso(inDays(2)), basedOn: event },
        checklist: ['Measure the latch', 'Buy a new lock'],
        labels: ['l1'],
        links: event ? [event] : [],
      }
      res.end(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] }),
      )
    })
  })
  return new Promise((resolve) =>
    lmStudio.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(lmStudio.address() as AddressInfo).port}`),
    ),
  )
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-boards-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      ai: {
        provider: 'lmstudio',
        model: 'openai/gpt-oss-20b',
        sortSenders: false,
        money: false,
        boards: true,
        cloudConsent: null,
      },
    }),
  )
  const ics = icsFile(userData)
  app = await launchApp({ ORDO_USER_DATA: userData, ORDO_LMSTUDIO_URL: await startFakeLmStudio() })
  page = await app.firstWindow()
  await page.setViewportSize(VIEWPORT)
  // Stand in for the native open dialog (the .ics import).
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, ics)
})

test.afterAll(async () => {
  await app?.close()
  lmStudio?.close()
})

/** With ORDO_SCREENSHOTS=1, save light and dark screenshots to test-results/ for review. */
async function shoot(name: string) {
  if (!shots) return
  // Show the board from its first column.
  await page.evaluate(() => document.querySelector('[data-column-id]')?.parentElement?.scrollTo({ left: 0 }))
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(150)
    await page.screenshot({ path: `test-results/boards-${name}-${scheme}.png`, animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: null })
}

const nav = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true })
const column = (name: string) => page.getByRole('list', { name, exact: true })
const card = (title: string) => page.getByRole('button', { name: title, exact: true })
const titlesIn = (name: string) =>
  column(name)
    .locator('[data-card-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))

async function addCards(columnName: string, titles: string[]) {
  await page
    .getByRole('region', { name: new RegExp(`^${columnName},`) })
    .getByRole('button', { name: 'Add a card', exact: true })
    .click()
  const input = page.getByRole('textbox', { name: `New card in ${columnName}` })
  for (const t of titles) {
    await input.fill(t)
    await input.press('Enter')
    await expect(card(t)).toBeVisible()
  }
  await input.press('Escape')
}

/** Drag with real pointer events, in small steps like a hand would. */
async function drag(from: Locator, to: Locator, where: 'top' | 'bottom' = 'top') {
  const a = (await from.boundingBox())!
  const b = (await to.boundingBox())!
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 4 })
  await page.mouse.move(b.x + b.width / 2, where === 'top' ? b.y + 4 : b.y + b.height - 4, { steps: 12 })
  await page.mouse.up()
}

test('Boards starts empty and makes a board from a template', async () => {
  await nav('Boards').click()
  await expect(page.getByRole('heading', { name: 'No boards yet' })).toBeVisible()
  await shoot('empty')
  await page.getByRole('button', { name: 'New board' }).click()
  const sheet = page.getByRole('dialog', { name: 'New board' })
  await sheet.getByLabel('Name').fill('Home')
  await sheet.getByRole('radio', { name: /Project/ }).click()
  await shoot('new-board')
  await sheet.getByRole('button', { name: 'Create board' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('heading', { level: 2, name: 'Home' })).toBeVisible()
  for (const name of ['Backlog', 'Up next', 'In progress', 'Review', 'Done'])
    await expect(column(name)).toBeVisible()
})

test('quick add puts cards at the bottom of a column', async () => {
  await addCards('Backlog', ['Fix the gate', 'Clear the gutters', 'Paint the shed'])
  await addCards('Up next', ['Book boiler service'])
  expect(await titlesIn('Backlog')).toEqual(['Fix the gate', 'Clear the gutters', 'Paint the shed'])
})

test('drag and drop moves cards between and within columns, and the order is kept', async () => {
  await drag(card('Paint the shed'), card('Book boiler service'))
  await expect.poll(() => titlesIn('Up next')).toEqual(['Paint the shed', 'Book boiler service'])
  await drag(card('Clear the gutters'), card('Fix the gate'))
  await expect.poll(() => titlesIn('Backlog')).toEqual(['Clear the gutters', 'Fix the gate'])
  // Into an empty column.
  await drag(card('Fix the gate'), column('In progress'))
  await expect.poll(() => titlesIn('In progress')).toEqual(['Fix the gate'])

  await page.reload()
  await expect.poll(() => titlesIn('Backlog')).toEqual(['Clear the gutters'])
  await expect.poll(() => titlesIn('Up next')).toEqual(['Paint the shed', 'Book boiler service'])
  await expect.poll(() => titlesIn('In progress')).toEqual(['Fix the gate'])

  // Escape puts a card back mid-drag.
  const a = (await card('Book boiler service').boundingBox())!
  const b = (await card('Fix the gate').boundingBox())!
  await page.mouse.move(a.x + 40, a.y + 12)
  await page.mouse.down()
  await page.mouse.move(b.x + 60, b.y + b.height + 10, { steps: 12 })
  // The card is lifted (a copy follows the pointer) and is gone from its column for now.
  await expect(page.locator('button[aria-label="Book boiler service"][tabindex="-1"]')).toBeVisible()
  expect(await titlesIn('Up next')).toEqual(['Paint the shed'])
  await shoot('dragging')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect.poll(() => titlesIn('Up next')).toEqual(['Paint the shed', 'Book boiler service'])
  await expect.poll(() => titlesIn('In progress')).toEqual(['Fix the gate'])
})

test('the keyboard moves cards with Option and the arrows', async () => {
  await card('Paint the shed').focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(() => titlesIn('Up next')).toEqual(['Book boiler service', 'Paint the shed'])
  await expect(card('Paint the shed')).toBeFocused()
  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(() => titlesIn('In progress')).toEqual(['Fix the gate', 'Paint the shed'])
  await expect(card('Paint the shed')).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect.poll(() => titlesIn('In progress')).toEqual(['Paint the shed', 'Fix the gate'])
  // Arrow keys alone move focus.
  await page.keyboard.press('ArrowDown')
  await expect(card('Fix the gate')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(card('Book boiler service')).toBeFocused()
})

test('columns: add, rename, set a limit, reorder with the keyboard', async () => {
  await page.getByRole('button', { name: 'Add column' }).click()
  await page.getByRole('textbox', { name: 'New column name' }).fill('Waiting')
  await page.getByRole('textbox', { name: 'New column name' }).press('Enter')
  await expect(column('Waiting')).toBeVisible()
  const header = page.getByRole('group', { name: /^Waiting column/ })
  await header.focus()
  await page.keyboard.press('Alt+ArrowLeft')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect
    .poll(() => page.locator('[data-column-id] h3').allTextContents())
    .toEqual(['Backlog', 'Up next', 'In progress', 'Waiting', 'Review', 'Done'])

  await page.getByRole('button', { name: 'In progress column options' }).click()
  await page.getByRole('menuitem', { name: 'Change card limit…' }).click()
  const limit = page.getByRole('dialog', { name: 'Card limit for In progress' })
  await limit.getByLabel('Card limit').fill('1')
  await limit.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('region', { name: 'In progress, 2 of 1, over the limit' })).toBeVisible()

  await page.getByRole('button', { name: 'Waiting column options' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByRole('textbox', { name: 'Column name' }).fill('On hold')
  await page.getByRole('textbox', { name: 'Column name' }).press('Enter')
  await expect(column('On hold')).toBeVisible()
  await shoot('board')
})

test('card details: notes, checklist, dates, labels and custom fields', async () => {
  await card('Fix the gate').click()
  const detail = page.getByRole('dialog', { name: 'Fix the gate' })
  await expect(detail).toBeVisible()

  await detail.getByRole('button', { name: 'Add notes' }).click()
  await detail
    .getByRole('textbox', { name: 'Notes' })
    .fill(
      '**Latch** is loose.\n- check hinges\n- [x] find screws\n\n[Guide](https://example.com/gate) <b>no html</b>',
    )
  await detail.getByRole('textbox', { name: 'Title' }).click()
  await expect(detail.locator('strong', { hasText: 'Latch' })).toBeVisible()
  await expect(detail.getByRole('link', { name: 'Guide' })).toHaveAttribute(
    'href',
    'https://example.com/gate',
  )
  await expect(detail.getByText('<b>no html</b>')).toBeVisible()

  const step = detail.getByRole('textbox', { name: 'Add a step' })
  for (const s of ['Buy hinges', 'Fit the latch']) {
    await step.fill(s)
    await step.press('Enter')
  }
  await detail.getByRole('checkbox', { name: 'Buy hinges' }).check()
  await expect(detail.getByText('1 of 2')).toBeVisible()

  await detail.getByLabel('Due date', { exact: true }).fill(iso(inDays(-1)))
  await detail.getByRole('checkbox', { name: 'Blocked' }).click()
  await expect(detail.getByRole('checkbox', { name: 'Blocked' })).toHaveAttribute('aria-checked', 'true')
  await detail.getByLabel('Priority', { exact: true }).selectOption({ label: 'High' })
  await detail.getByLabel('Owner', { exact: true }).fill('Sam')
  await detail.getByLabel('Owner', { exact: true }).press('Enter')
  await detail.getByLabel('Link', { exact: true }).fill('javascript:alert(1)')
  await detail.getByLabel('Link', { exact: true }).press('Enter')
  await expect(detail.getByRole('alert')).toContainText('https://')
  await detail.getByLabel('Link', { exact: true }).fill('locks.example/gate')
  await detail.getByLabel('Link', { exact: true }).press('Enter')
  await expect(detail.getByRole('link', { name: 'Open Link' })).toHaveAttribute(
    'href',
    'https://locks.example/gate',
  )
  // Escape in a field puts back what was saved.
  await detail.getByLabel('Owner', { exact: true }).fill('Bob')
  await page.keyboard.press('Escape')
  await expect(detail.getByLabel('Owner', { exact: true })).toHaveValue('Sam')
  await shoot('card')
  await page.keyboard.press('Escape')
  await expect(detail).toBeHidden()
  // Focus goes back to the card it came from.
  await expect(card('Fix the gate')).toBeFocused()

  const tile = card('Fix the gate')
  await expect(tile).toContainText('Blocked')
  await expect(tile).toContainText('Yesterday')
  await expect(tile).toContainText('1/2')
  await expect(tile).toContainText('High')
  await expect(tile).toContainText('Sam')
})

test('links a card to another card and shows it on both', async () => {
  await card('Fix the gate').click()
  const detail = page.getByRole('dialog', { name: 'Fix the gate' })
  await detail.getByRole('button', { name: 'Link…' }).click()
  const picker = page.getByRole('dialog', { name: 'Link to' })
  await picker.getByRole('radio', { name: 'Cards' }).click()
  await picker.getByRole('button', { name: /Paint the shed/ }).click()
  await expect(detail.getByRole('button', { name: /^Card Paint the shed/ })).toBeVisible()
  await detail.getByRole('button', { name: /^Card Paint the shed/ }).click()
  const other = page.getByRole('dialog', { name: 'Paint the shed' })
  await expect(other.getByText(/Links here/)).toBeVisible()
  await page.keyboard.press('Escape')
})

test('search and filters narrow the board', async () => {
  await page.getByRole('searchbox', { name: 'Search cards' }).fill('sam')
  await expect(page.getByText(/Showing 1 of 4 cards/)).toBeVisible()
  await expect(card('Fix the gate')).toBeVisible()
  await expect(card('Paint the shed')).toBeHidden()
  await page.getByRole('searchbox', { name: 'Search cards' }).fill('')
  await page.getByRole('button', { name: 'Filter' }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Overdue' }).click()
  await expect(page.getByText(/Showing 1 of 4 cards/)).toBeVisible()
  // The filter menu stays open for ticking more than one thing.
  await expect(page.getByRole('menu', { name: 'Filter cards' })).toBeVisible()
  await page.keyboard.press('Escape')
  await shoot('filtered')
  await page.getByRole('button', { name: 'Clear', exact: true }).click()
  await expect(card('Paint the shed')).toBeVisible()
  await shoot('overview')
})

test('archive and restore, delete and undo', async () => {
  await card('Clear the gutters').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(card('Clear the gutters')).toBeHidden()
  await page.getByRole('button', { name: 'Archived cards' }).click()
  const archived = page.getByRole('dialog', { name: 'Archived cards' })
  await expect(archived.getByText('Clear the gutters')).toBeVisible()
  await archived.getByRole('button', { name: 'Restore' }).click()
  await archived.getByRole('button', { name: 'Done' }).click()
  await expect(card('Clear the gutters')).toBeVisible()

  await card('Clear the gutters').focus()
  await page.keyboard.press('Backspace')
  await expect(card('Clear the gutters')).toBeHidden()
  await expect(page.getByRole('status').getByText('Deleted “Clear the gutters”')).toBeVisible()
  await shoot('undo')
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect(card('Clear the gutters')).toBeVisible()
  await expect(page.getByRole('status').getByText('Restored “Clear the gutters”')).toBeVisible()

  // Two deletes in a row can both be undone, newest first.
  await card('Clear the gutters').focus()
  await page.keyboard.press('Backspace')
  await card('Book boiler service').focus()
  await page.keyboard.press('Backspace')
  await expect(page.getByRole('button', { name: /Undo \(2\)/ })).toBeVisible()
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect(card('Book boiler service')).toBeVisible()
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect(card('Clear the gutters')).toBeVisible()
})

test('labels and fields are edited per board', async () => {
  await page.getByRole('button', { name: 'Labels and fields' }).click()
  const sheet = page.getByRole('dialog', { name: 'Labels and fields' })
  // Ready to type a new label straight away.
  await expect(sheet.getByLabel('New label name')).toBeFocused()
  await sheet.getByLabel('New label name').fill('Garden')
  await sheet.getByRole('button', { name: 'Add label' }).click()
  await expect(sheet.getByRole('textbox', { name: 'Label name', exact: true }).last()).toHaveValue('Garden')
  await sheet.getByRole('radio', { name: 'Fields' }).click()
  await sheet.getByLabel('New field type').selectOption('checkbox')
  await sheet.getByLabel('New field name').fill('Needs a ladder')
  await sheet.getByRole('button', { name: 'Add field' }).click()
  await expect(sheet.getByRole('textbox', { name: 'Field name', exact: true }).last()).toHaveValue(
    'Needs a ladder',
  )
  await shoot('settings')
  await sheet.getByRole('button', { name: 'Done' }).click()
})

test('Suggest asks the local model and each suggestion can be added', async () => {
  // A calendar event to suggest from.
  await nav('Calendar').click()
  await page.getByRole('button', { name: 'Add calendar…' }).first().click()
  await page.getByRole('button', { name: 'Import .ics file…' }).click()
  await expect(page.getByRole('checkbox', { name: 'Show Family' })).toBeChecked()
  await nav('Boards').click()

  await card('Fix the gate').click()
  const detail = page.getByRole('dialog', { name: 'Fix the gate' })
  await detail.getByRole('button', { name: 'Suggest' }).click()
  const suggestions = detail.getByRole('region', { name: 'Suggestions' })
  await expect(suggestions.getByText('Suggested by LM Studio')).toBeVisible()
  await expect(suggestions.getByText('Measure the latch')).toBeVisible()
  await expect(suggestions.getByText(/from Locksmith for the gate/)).toBeVisible()
  await shoot('suggest')
  // Only data blocks went to the model, with short ids and no internal ones.
  const prompt = prompts.at(-1)!
  expect(prompt).toContain('<candidates>')
  expect(prompt).toContain('"title":"Fix the gate"')
  expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)

  await suggestions.getByRole('button', { name: 'Dismiss step “Buy a new lock”' }).click()
  await suggestions.getByRole('button', { name: 'Add step “Measure the latch”' }).click()
  await expect(detail.getByRole('checkbox', { name: 'Measure the latch' })).toBeVisible()
  await suggestions.getByRole('button', { name: /Add link to Locksmith/ }).click()
  await expect(
    detail.getByRole('region', { name: 'Links' }).getByText('Locksmith for the gate'),
  ).toBeVisible()
  await suggestions.getByRole('button', { name: /Add due date/ }).click()
  await expect(detail.getByLabel('Due date', { exact: true })).toHaveValue(iso(inDays(2)))
  await expect(suggestions.getByText('No more suggestions for this card.')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('closing a card stops its question, so another card can ask straight away', async () => {
  await addCards('Backlog', ['Slow card'])
  await card('Slow card').click()
  const slow = page.getByRole('dialog', { name: 'Slow card' })
  await slow.getByRole('button', { name: 'Suggest' }).click()
  await expect(slow.getByRole('button', { name: 'Thinking…' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(slow).toBeHidden()

  await card('Paint the shed').click()
  const other = page.getByRole('dialog', { name: 'Paint the shed' })
  await other.getByRole('button', { name: 'Suggest' }).click()
  await expect(other.getByText('Suggested by LM Studio')).toBeVisible()
  await expect(other.getByText(/Already asking/)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await card('Slow card').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(card('Slow card')).toBeHidden()
})

test('dated cards show on the Calendar, and a card can be made from an event', async () => {
  await nav('Calendar').click()
  await page.getByRole('radio', { name: 'Agenda' }).click()
  await expect(page.getByRole('button', { name: /Fix the gate/ }).first()).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Calendars' }).getByText('Boards')).toBeVisible()

  await page
    .getByRole('button', { name: /Locksmith for the gate/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Create card from this…' }).click()
  const sheet = page.getByRole('dialog', { name: 'Create card' })
  await expect(sheet.getByLabel('Title')).toHaveValue('Locksmith for the gate')
  await sheet.getByRole('button', { name: 'The day before' }).click()
  await sheet.getByRole('button', { name: 'Create card' }).click()
  await expect(page.getByText('Added to Home')).toBeVisible()
  await shoot('calendar')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Locksmith for the gate' })
  await expect(detail).toBeVisible()
  await expect(detail.getByText('Family').first()).toBeVisible()
  await page.keyboard.press('Escape')
})

test('boards are listed, renamed, reordered and deleted with undo', async () => {
  await page.getByRole('button', { name: 'New board…' }).click()
  const sheet = page.getByRole('dialog', { name: 'New board' })
  await sheet.getByLabel('Name').fill('This week')
  await sheet.getByRole('radio', { name: /Weekly plan/ }).click()
  await sheet.getByRole('button', { name: 'Create board' }).click()
  await expect(column('Monday')).toBeVisible()
  const list = page.getByRole('complementary', { name: 'Boards' })
  const thisWeek = list.locator('[data-board-id]', { hasText: 'This week' })
  await thisWeek.focus()
  await page.keyboard.press('Alt+ArrowUp')
  await expect
    .poll(() => list.locator('[data-board-id]').allTextContents())
    .toEqual([expect.stringContaining('This week'), expect.stringContaining('Home')])
  await list.getByRole('button', { name: 'This week options' }).click()
  await page.getByRole('menuitem', { name: 'Delete board…' }).click()
  await page
    .getByRole('dialog', { name: 'Delete This week?' })
    .getByRole('button', { name: 'Delete board' })
    .click()
  await expect(thisWeek).toHaveCount(0)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect(thisWeek).toHaveCount(1)
})

test('fits a narrow window', async () => {
  await page.setViewportSize({ width: 920, height: 700 })
  await nav('Boards').click()
  await page
    .getByRole('complementary', { name: 'Boards' })
    .locator('[data-board-id]', { hasText: 'Home' })
    .click()
  await expect(column('Backlog')).toBeVisible()
  // Nothing in the toolbar wraps or is squeezed out.
  const box = (await page.getByRole('button', { name: 'New card' }).boundingBox())!
  expect(box.height).toBeLessThanOrEqual(30)
  expect(box.x + box.width).toBeLessThanOrEqual(920)
  await shoot('narrow-board')
  await card('Fix the gate').click()
  await expect(page.getByRole('dialog', { name: 'Fix the gate' })).toBeVisible()
  await shoot('narrow-card')
  await page.keyboard.press('Escape')
  await page.setViewportSize(VIEWPORT)
})

test('works beside the docked assistant: scrolls sideways and drags scroll at the edge', async () => {
  await page.setViewportSize({ width: 1500, height: 800 })
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Assistant' })).toBeVisible()
  await expect(column('Backlog')).toBeVisible()
  const scroller = page.locator('[data-column-id]').first().locator('..')
  // The board is narrower than its columns, so it scrolls sideways, and stays clear of the panel.
  const sizes = await scroller.evaluate((el) => ({
    scroll: el.scrollWidth,
    client: el.clientWidth,
    right: el.getBoundingClientRect().right,
  }))
  expect(sizes.scroll).toBeGreaterThan(sizes.client)
  const panelBox = (await page.getByRole('dialog', { name: 'Assistant' }).boundingBox())!
  expect(sizes.right).toBeLessThanOrEqual(panelBox.x + 1)
  await shoot('assistant-docked')

  // Hold a card near the right edge of the board: it scrolls along.
  const from = (await card('Clear the gutters').boundingBox())!
  await page.mouse.move(from.x + 40, from.y + 10)
  await page.mouse.down()
  await page.mouse.move(sizes.right - 20, from.y + 40, { steps: 10 })
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(card('Clear the gutters')).toBeVisible()
  await page.getByRole('button', { name: 'Assistant', exact: true }).click()
  await page.setViewportSize(VIEWPORT)
})
