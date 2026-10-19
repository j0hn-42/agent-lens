// French Conversation, Files & repeats and Timeline panels at reflow sizes (#599, #373; WCAG 1.4.10), measured in a real browser against
// the demo app (`pnpm --dir web run test:e2e`). The French labels of the header actions, the search, the pair filter and the
// file rows are longer than the English ones: at 320 px and at 1280 px / 200 % (a 640 x 512 window) nothing may scroll
// sideways, leave the window, be cut or sit on top of another button. The Context panel needs a relay (it is not available
// in demo mode: the panel is unavailable by construction, the bridge decides it, so no network mock can render it), so its French states
// are covered by the jsdom test of the message catalog. Its 320 px reflow (table Branche / Pull request / Vérifications) is NOT measured in a browser.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { waitForStableLayout } from './stable-layout'
import { expectFits } from './panel-fit'

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

async function open(w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await context.addInitScript(() => { try { window.localStorage.setItem('agent-lens:locale', 'fr') } catch { /* blocked */ } })
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

for (const [w, h] of [[320, 568], [640, 512]] as Array<[number, number]>) {
  test(`fr ${w}x${h}: the Conversation panel (header, search, pair filter) fits (#599)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      await page.locator('body').press('c')
      const panel = page.locator('[data-dock-panel="conversation"]')
      await panel.waitFor()
      await panel.getByRole('button', { name: 'Exporter la conversation' }).waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[data-dock-panel="conversation"]', `${w}x${h} conversation`)
      await panel.getByRole('button', { name: 'Rechercher dans les messages' }).click()
      await panel.getByRole('searchbox', { name: 'Rechercher dans les messages' }).waitFor()
      // The pair filter lives on the rows of a SEND / RETURN message. The demo shows only user, thinking and assistant messages when it
      // opens (probed: no such row after 12 s), so the button is absent: said out loud, not skipped silently. When a row exists, its
      // name must start with its visible text (WCAG 2.5.3) and the opened state is measured.
      const pair = panel.getByRole('button', { name: /^Filtrer une paire/ }).first()
      const hasPair = await pair.count() > 0
      if (hasPair) await pair.click()
      else console.log(`# [${w}x${h}] no SEND / RETURN row in the demo: the open pair filter is not measured here`)
      await waitForStableLayout(page)
      await expectFits(page, '[data-dock-panel="conversation"]', hasPair ? `${w}x${h} conversation, search and pair filter open` : `${w}x${h} conversation, search open (no pair row in the demo)`)
    } finally {
      await page.context().close()
    }
  })

  test(`fr ${w}x${h}: the Files panel fits (#599)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      await page.locator('body').press('f')
      const panel = page.locator('[data-dock-panel="files"]')
      await panel.waitFor()
      await panel.getByRole('region', { name: 'Fichiers et répétitions observés' }).waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[data-dock-panel="files"]', `${w}x${h} files`)
    } finally {
      await page.context().close()
    }
  })

  // #373: the French Timeline (header actions, legend, table view, message buttons). The demo has no link channel on opening, so the
  // Sequence button and the message list may be absent: said out loud below, not skipped silently.
  test(`fr ${w}x${h}: the Timeline panel (header, legend, table view) fits (#373)`, { timeout: 180_000 }, async () => {
    const page = await open(w, h)
    try {
      await page.locator('body').press('t')
      const panel = page.locator('[data-dock-panel="timeline"]')
      await panel.waitFor()
      await panel.getByRole('region', { name: 'Chronologie d’exécution' }).waitFor()
      // the first-launch offer of the tour sits over the bottom of the window and takes the clicks: not the subject here
      const later = page.getByRole('button', { name: 'Pas maintenant' })
      if (await later.waitFor({ timeout: 4000 }).then(() => true, () => false)) await later.click()
      await later.waitFor({ state: 'detached' }).catch(() => {})
      await panel.getByRole('button', { name: 'Vue en tableau' }).waitFor()
      await waitForStableLayout(page)
      const hasSequence = await panel.getByRole('button', { name: 'Séquence' }).count() > 0
      if (!hasSequence) console.log(`# [${w}x${h}] no Sequence button in the demo (no link channel): its French width is not measured here`)
      await expectFits(page, '[data-dock-panel="timeline"]', `${w}x${h} timeline`)
      await panel.getByRole('button', { name: 'Vue en tableau' }).click()
      await panel.getByRole('columnheader', { name: 'Début' }).waitFor()
      await waitForStableLayout(page)
      await expectFits(page, '[data-dock-panel="timeline"]', `${w}x${h} timeline, table view`)
      assert.equal(await panel.locator('canvas').evaluate(c => c.closest('[role="img"]')?.hasAttribute('hidden')), true, 'the canvas is replaced by the table')
    } finally {
      await page.context().close()
    }
  })
}
