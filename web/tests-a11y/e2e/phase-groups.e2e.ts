// Real-browser check of the workflow phase groups (#146) and of 'Hide inactive agents' on finished members (#147),
// on the demo scenario ?scenario=workflow (a workflow of two phases, the first one finished).
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'

let browser: Browser
let server: DemoServer

before(async () => {
  server = await startDemoServer()
  browser = await chromium.launch()
}, { timeout: 240_000 })

after(async () => {
  await browser?.close()
  await server?.stop()
})

async function openWorkflow(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  await page.goto(`${server.url}/?scenario=workflow`)
  await page.getByRole('button', { name: 'Files' }).waitFor()
  // the whole scenario is played within a few seconds
  await page.waitForFunction(
    () => document.querySelector('[role="group"][aria-label="Phase Build"]') !== null,
    null, { timeout: 30_000 },
  )
  return { page, close: () => context.close() }
}

const phaseGroups = (page: Page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('[role="group"][aria-label^="Phase "]')).map(g => g.getAttribute('aria-label')))

test('workflow demo: finished members are hidden from the outline and the sessions list, and come back with the button off', async () => {
  const { page, close } = await openWorkflow()
  try {
    await page.waitForFunction(() => /2 finished agents hidden/.test(document.body.textContent ?? ''), null, { timeout: 30_000 })
    // the outline refreshes a little after the announcement: wait for it rather than sample once
    await page.waitForFunction(() => document.querySelector('[role="group"][aria-label="Phase Plan"]') === null, null, { timeout: 10_000 })
    const groups = await phaseGroups(page)
    assert.ok(groups.includes('Phase Build'), `groups: ${groups}`)
    assert.ok(!groups.includes('Phase Plan'), 'the Plan phase only has finished members: hidden')

    await page.getByRole('button', { name: /^Sessions/ }).click()
    const list = page.locator('[aria-labelledby="session-list-title"]')
    await list.waitFor()
    assert.equal(await list.getByText('plan-a').count(), 0, 'finished agents are not listed')
    assert.equal(await list.getByText('plan-b').count(), 0)

    await page.getByRole('button', { name: /Hide inactive agents/ }).click()
    await page.waitForFunction(() => !/finished agents? hidden/.test(document.body.textContent ?? ''))
    assert.ok((await phaseGroups(page)).includes('Phase Plan'))
    assert.ok(await list.getByText('plan-a').count() >= 1, 'listed again')
  } finally {
    await close()
  }
})

test('workflow demo: with every member shown, both phases form separate groups on the canvas', async () => {
  const { page, close } = await openWorkflow()
  try {
    await page.getByRole('button', { name: /Hide inactive agents/ }).click()
    await page.waitForFunction(() => document.querySelector('[role="group"][aria-label="Phase Plan"]') !== null)
    await page.waitForTimeout(3000) // layout settled
    await page.screenshot({ path: 'test-results/phase-groups.png' })
    const groups = await phaseGroups(page)
    assert.ok(groups.includes('Phase Plan') && groups.includes('Phase Build'))
  } finally {
    await close()
  }
})
