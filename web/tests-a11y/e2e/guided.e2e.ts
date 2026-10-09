// The guided tour end to end, in a real browser: walks every step and checks that the card and the ring show.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { GUIDED_STEPS } from '../../lib/guided-steps'

let browser: Browser
let server: DemoServer

/** Names of the agents listed in the accessible graph outline (the agents the canvas draws) */
const outlineAgentNames = (page: Page) => page.locator('section[aria-label="Agent graph outline"] button[data-graph-node]')
  .evaluateAll(buttons => buttons.map(b => (b.textContent ?? '').split(',')[0].trim()))

/** Box of an element once it stops moving (same rounded box on two reads 200 ms apart): the camera fit has settled */
async function settledBox(locator: Locator) {
  let prev = ''
  for (let attempt = 0; attempt < 40; attempt++) {
    const b = await locator.boundingBox()
    const key = b ? [b.x, b.y, b.width, b.height].map(Math.round).join() : ''
    if (b && key === prev) return b
    prev = key
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('the element never stopped moving')
}

/** Clock shown by the playback bar (m:ss), in seconds */
async function playbackSeconds(page: Page) {
  const text = await page.getByRole('toolbar', { name: 'Playback controls' }).innerText()
  const m = /(\d+):(\d\d)/.exec(text)
  assert.ok(m, `a clock in the playback bar (${text})`)
  return Number(m[1]) * 60 + Number(m[2])
}

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '')

before(async () => { server = await startDemoServer(); browser = await chromium.launch() }, { timeout: 240_000 })
after(async () => { await browser?.close(); await server?.stop() })

test('the guided tour walks every step with Next and shows the card each time', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  for (let i = 0; i < GUIDED_STEPS.length; i++) {
    await page.getByText(`Step ${i + 1} of ${GUIDED_STEPS.length}`).waitFor()
    assert.ok(await dialog.getByRole('heading', { name: GUIDED_STEPS[i].title }).isVisible(), `step ${i + 1}: ${GUIDED_STEPS[i].title}`)
    // Every step target is on screen at its time: a misnamed agent or a missing DOM target would leave no ring
    const ring = page.locator('[data-tour-ring]')
    await ring.waitFor({ timeout: 5_000 })
    // ...and once the camera has settled, in the viewport and not hidden under the card
    const r = await settledBox(ring)
    const c = (await dialog.boundingBox())!
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1280 && r.y + r.height <= 800, `step ${i + 1}: ring out of view`)
    assert.ok(r.y + r.height <= c.y || r.x + r.width <= c.x || r.x >= c.x + c.width, `step ${i + 1}: ring under the card`)
    // An agent step targets an agent that is drawn: a hidden agent (Hide inactive agents) is not in the outline
    const target = GUIDED_STEPS[i].target
    if (target.kind === 'agent') {
      assert.ok(await ring.isVisible(), `step ${i + 1}: ring visible`)
      const names = await outlineAgentNames(page)
      assert.ok(names.includes(target.name), `step ${i + 1}: ${target.name} is in the graph outline (${names.join(' | ')})`)
    }
    if (i < GUIDED_STEPS.length - 1) await dialog.getByRole('button', { name: 'Next' }).click()
  }
  assert.equal(await dialog.getByRole('button', { name: 'Next' }).getAttribute('aria-disabled'), 'true')
  await dialog.getByRole('button', { name: 'Previous' }).click()
  await page.getByText(`Step ${GUIDED_STEPS.length - 1} of ${GUIDED_STEPS.length}`).waitFor()
})

const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent ?? '')

test('with the keyboard, Next to the last step keeps the focus in the card and the arrow keys working', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  await page.getByRole('dialog').waitFor()
  // The tour opens on Next, so a first Enter goes forward
  await page.waitForFunction(() => document.activeElement?.textContent === 'Next')
  for (let i = 0; i < GUIDED_STEPS.length + 1; i++) await page.keyboard.press('Enter')
  await page.getByText(`Step ${GUIDED_STEPS.length} of ${GUIDED_STEPS.length}`).waitFor()
  assert.equal(await focusedText(page), 'Next', 'a disabled Next would drop the focus to <body>')
  await page.keyboard.press('ArrowLeft')
  await page.getByText(`Step ${GUIDED_STEPS.length - 1} of ${GUIDED_STEPS.length}`).waitFor()
  // Same at the other end with Previous
  await page.keyboard.press('Shift+Tab')
  assert.equal(await focusedText(page), 'Previous')
  for (let i = 0; i < GUIDED_STEPS.length + 1; i++) await page.keyboard.press('Enter')
  await page.getByText(`Step 1 of ${GUIDED_STEPS.length}`).waitFor()
  assert.equal(await focusedText(page), 'Previous')
  await page.keyboard.press('ArrowRight')
  await page.getByText(`Step 2 of ${GUIDED_STEPS.length}`).waitFor()
})

test('legend steps open the legend and leave the saved preference alone', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  await page.getByRole('dialog').waitFor()
  const firstLegendStep = GUIDED_STEPS.findIndex(s => s.opensLegend)
  await page.getByRole('combobox', { name: 'Go to step' }).selectOption(String(firstLegendStep))
  await page.getByRole('region', { name: 'Graph legend' }).waitFor()
  assert.equal(await page.evaluate(() => window.localStorage.getItem('agent-viz-legend-open')), null)
  // The tour also shows the idle and finished agents it talks about without saving 'Hide inactive agents'
  assert.equal(await page.evaluate(() => window.localStorage.getItem('agent-lens:hide-inactive-agents')), null)
})

const apiDevListed = (page: Page, listed: boolean) => page.waitForFunction(
  want => [...document.querySelectorAll('section[aria-label="Agent graph outline"] button[data-graph-node]')].some(b => b.textContent?.startsWith('api-dev,')) === want,
  listed,
)

/** Page opened with 'Hide inactive agents' saved as on (the default, made explicit) */
async function openWithHideInactiveSaved() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript(() => { if (window.localStorage.getItem('agent-lens:hide-inactive-agents') === null) window.localStorage.setItem('agent-lens:hide-inactive-agents', 'true') })
  const page = await context.newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const stored = () => page.evaluate(() => window.localStorage.getItem('agent-lens:hide-inactive-agents'))
  const hideToggle = page.getByRole('button', { name: 'Hide inactive agents' })
  assert.equal(await stored(), 'true')
  // The team step targets api-dev while it is idle: shown by the tour, while the toggle still reflects the preference
  const team = GUIDED_STEPS.findIndex(s => s.id === 'team')
  await page.getByRole('combobox', { name: 'Go to step' }).selectOption(String(team))
  await page.getByText(`Step ${team + 1} of ${GUIDED_STEPS.length}`).waitFor()
  await apiDevListed(page, true)
  assert.equal(await hideToggle.getAttribute('aria-pressed'), 'true')
  assert.equal(await stored(), 'true')
  return { page, dialog, stored, hideToggle }
}

test('the tour shows inactive agents without changing the saved Hide inactive agents preference', async () => {
  const { page, dialog, stored } = await openWithHideInactiveSaved()
  await dialog.getByRole('button', { name: 'Exit tour' }).click()
  await dialog.waitFor({ state: 'detached' })
  // Back to the user's preference: idle and finished agents are hidden again (api-dev is idle, then done)
  await apiDevListed(page, false)
  assert.equal(await stored(), 'true')
})

test('during the tour the Hide inactive agents toggle reflects and changes the real preference', async () => {
  const { page, dialog, stored, hideToggle } = await openWithHideInactiveSaved()
  await hideToggle.click()
  assert.equal(await hideToggle.getAttribute('aria-pressed'), 'false')
  assert.equal(await stored(), 'false')
  // The tour keeps showing its agents either way
  await apiDevListed(page, true)
  await dialog.getByRole('button', { name: 'Exit tour' }).click()
  await dialog.waitFor({ state: 'detached' })
  // After the tour, the preference set during it applies: inactive agents stay shown
  assert.equal(await stored(), 'false')
  assert.equal(await hideToggle.getAttribute('aria-pressed'), 'false')
  await apiDevListed(page, true)
})

test('Exit tour closes the card, keeps the app and has no accessibility violation', async () => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
  await page.goto(`${server.url}/?scenario=guided`)
  await page.getByRole('dialog').waitFor()
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
  assert.deepEqual(results.violations.map(v => v.id), [])
  const heldAt = await playbackSeconds(page)
  await page.getByRole('button', { name: 'Exit tour' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  const start = page.getByRole('button', { name: 'Guided tour' })
  assert.ok(await start.isVisible())
  // Auto-started tour (nothing opened it): the focus lands on the Guided tour button
  await page.waitForFunction(() => document.activeElement?.id === 'guided-tour-start')
  // Playback resumes: the clock moves on from the step time
  await page.waitForFunction(t => {
    const m = /(\d+):(\d\d)/.exec(document.querySelector('[role="toolbar"][aria-label="Playback controls"]')?.textContent ?? '')
    return !!m && Number(m[1]) * 60 + Number(m[2]) >= t + 2
  }, heldAt, { timeout: 10_000 })

  // Started from the button: the button is unmounted during the tour, so the focus comes back to it once it returns
  await start.click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await page.waitForFunction(() => document.activeElement?.id !== 'guided-tour-start')
  await dialog.getByRole('button', { name: 'Exit tour' }).click()
  await dialog.waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.activeElement?.id === 'guided-tour-start')
  assert.equal(await activeId(page), 'guided-tour-start')
})
