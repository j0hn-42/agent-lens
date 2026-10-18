// The first-run tour offer (TourOffer, #377) and a REAL permission card on a short window, with no popup open
// (split from popup-permission.e2e.ts, #536 / PR #558). The offer used to be drawn above the canvas controls (z-index
// Z.detailCard, over the cards' Z.controlBar + 6) from 600 px wide, while the cards hang from the top bar. On a short
// window the two met, and the card's buttons, once focused, were drawn under the offer. Measured with elementFromPoint
// at each Tab stop (permission-card.ts probe), before the fix, in Chromium: at 640x360 Approve and Deny were ENTIRELY
// hidden by the offer's text (2.4.11) and "Input of Bash" partly; at 640x300 the three were partly covered by the
// offer's button row or one of its buttons (2.4.12).
// FIX (default decision of the orchestrator, reversible): a pending permission decision comes before an optional offer,
// so the offer is not rendered while a card is shown (it is not spent: it comes back once no card is shown, see
// tour-offer.test.tsx). This test keeps its strength: every card stop is still drawn, focus-indicated and uncovered, and
// it now also asserts that the offer is not on screen. The 1024x768 case is the control.
// Waits are on conditions, never a fixed delay. Not covered: a real device. Chromium emulation only.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { APPROVE, DENY, focusProblems, probe, attachUnfocused, openWithCard, type Probe } from './permission-card'

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

/** Posts a message to the app frame from its parent (the bridge only listens to window.parent). */
const post = (page: Page, data: unknown) =>
  page.evaluate((d) => (document.getElementById('app') as HTMLIFrameElement).contentWindow!.postMessage(d, '*'), data)

for (const [w, h] of [[1024, 768], [640, 360], [640, 300]] as Array<[number, number]>) {
  test(`${w}x${h}: with a permission card shown, the first-run tour offer yields and the card's buttons reached by Tab are not covered`, async () => {
    const { page, app } = await openWithCard(browser, server, w, h, false)
    try {
      // One live session with its main agent and a running Bash call, as in popup-permission.e2e.ts: the legend can then start a tour, so
      // the offer of the first launch would show without the card
      await post(page, { type: 'config', showMockData: false })
      await post(page, { type: 'session-list', sessions: [{ id: 'sa', label: 'payments-api', status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: '/w/payments-api', runtime: 'claude' }] })
      await app.getByRole('button', { name: /^Sessions: payments-api/ }).waitFor()
      await post(page, { type: 'agent-event', event: { time: 1, type: 'agent_spawn', sessionId: 'sa', payload: { name: 'main-a', isMain: true } } })
      await post(page, { type: 'agent-event', event: { time: 2, type: 'tool_call_start', sessionId: 'sa', payload: { agent: 'main-a', tool: 'Bash', args: 'npm test', inputData: { command: 'npm test' }, toolUseId: 'tu1' } } })
      // The legend can start a tour now (the condition of the offer), and the card is still shown
      await app.locator('#guided-tour-start, #canvas-controls-menu').first().waitFor({ state: 'attached', timeout: 20000 })
      await app.evaluate(`document.activeElement && document.activeElement.blur()`)
      const stops: Probe[] = []
      const met = (re: RegExp) => stops.some(s => s.inCards && re.test(s.name))
      for (let i = 0; i < 80 && !(met(APPROVE) && met(DENY)); i++) {
        await page.keyboard.press('Tab')
        const p = await probe(app)
        if (p) stops.push(p)
      }
      assert.ok(met(APPROVE), `Tab reaches Approve (stops: ${stops.map(s => s.name).join(' | ')})`)
      assert.ok(met(DENY), 'Tab reaches Deny')
      assert.equal(await app.locator('[data-tour-offer]').count(), 0, 'the tour offer is not shown while a permission card is')
      await attachUnfocused(app, stops)
      assert.deepEqual(focusProblems(stops.filter(s => s.inCards), () => true), [], 'every card stop is drawn, has a focus indicator and is not covered')
    } finally {
      await page.context().close()
    }
  })
}
