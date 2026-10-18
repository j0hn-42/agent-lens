// A tool / discovery detail popup (DetailPopup) opened while a REAL permission card is shown (#536, follow-up of #410
// and #529), measured in a real browser. The card comes from the fake extension bridge of permission-card.ts (the
// same one as mobile-permission.e2e.ts): the demo app in an iframe of a same-origin host page that posts a
// `permission-request`. The popup is opened as a user does it, through the button of the graph outline that has the
// same callback as a canvas click. The first-run tour offer is marked as already made (as on any later launch): its
// own overlap with the cards on a short window is measured in tour-offer-permission.e2e.ts, not here.
// For each window size (320x568, 390x844, 768x1024, 899x700, 1024x768 and the 200 % zoom heights 640x360, 640x300):
// - the popup lies over no part of the cards' box (their title, and their Approve / Deny buttons wherever the cards'
//   own scroll brings them): a project rule, a popup on top of them would hide a pending decision (placePopup,
//   panel-layout.ts, #410, #558). A button scrolled out of the cards is clipped by them, so only its visible part counts;
//   since the whole box of the cards is checked as well, nothing is lost by that clipping;
// - Tab from the popup reaches the card's buttons and each one is drawn, has a focus indicator and is not covered
//   (2.4.7, 2.4.11, 2.4.12);
// - Escape closes the popup, the card stays, and the focus comes back to where it was.
// Waits are on conditions (a button, a dialog, a stable layout), never a fixed delay.
// Not covered: a real device. Chromium emulation only. Popup anchors other than the simulation's tool position.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Frame, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { APPROVE, DENY, focusProblems, probe, attachUnfocused, openWithCard, noHorizontalScroll, type Probe } from './permission-card'

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

const SIZES: Array<[number, number]> = [[320, 568], [390, 844], [768, 1024], [899, 700], [1024, 768], [640, 360], [640, 300]]

const info = (id: string, label: string) => ({
  id, label, status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: `/w/${label}`, runtime: 'claude',
})
const ev = (type: string, time: number, payload: Record<string, unknown>) => ({ type: 'agent-event', event: { time, type, sessionId: 'sa', payload } })

/** Posts a message to the app frame from its parent (the bridge only listens to window.parent). */
const post = (page: Page, data: unknown) =>
  page.evaluate((d) => (document.getElementById('app') as HTMLIFrameElement).contentWindow!.postMessage(d, '*'), data)

type Kind = 'tool' | 'discovery'

/** Replaces the mock data by one session with a running Bash call (a tool popup) or a finished Grep (a discovery). */
async function feed(page: Page, app: Frame, kind: Kind): Promise<void> {
  await post(page, { type: 'config', showMockData: false })
  await post(page, { type: 'session-list', sessions: [info('sa', 'payments-api')] })
  await app.getByRole('button', { name: /^Sessions: payments-api/ }).waitFor()
  await post(page, ev('agent_spawn', 1, { name: 'main-a', isMain: true }))
  if (kind === 'tool') {
    await post(page, ev('tool_call_start', 2, { agent: 'main-a', tool: 'Bash', args: 'npm test', inputData: { command: 'npm test' }, toolUseId: 'tu1' }))
  } else {
    await post(page, ev('tool_call_start', 2, { agent: 'main-a', tool: 'Grep', args: 'popup', inputData: { pattern: 'popup' }, toolUseId: 'tu1' }))
    await post(page, ev('tool_call_end', 3, { agent: 'main-a', tool: 'Grep', result: 'Found 2 files\nweb/a.ts\nweb/b.ts', toolUseId: 'tu1' }))
  }
}

/** The outline button that opens the popup, clicked as the canvas click does (the outline is visually hidden). */
async function openPopup(app: Frame, kind: Kind): Promise<void> {
  const sel = kind === 'tool'
    ? 'ul[aria-label^="Tool calls of"] button[data-graph-node]'
    : 'section[aria-label="Agent graph outline"] h3 + ul button[data-graph-node]'
  await app.waitForSelector(sel, { state: 'attached', timeout: 20000 })
  await app.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error('no outline button'); b.setAttribute('data-e2e-opener', ''); b.focus(); b.click() })()`)
  await app.getByRole('dialog').waitFor({ timeout: 5000 })
}

interface Overlap { target: string; popup: string; target_box: string }

/**
 * What the popup covers of the cards: their box (as drawn, i.e. their scroll viewport), their title and intro, and the
 * visible part of their Approve / Deny buttons (a button scrolled out of the cards is clipped by them). Box intersection.
 */
async function coveredByPopup(app: Frame): Promise<Overlap[]> {
  return app.evaluate(`(() => {
    const dlg = document.querySelector('[role="dialog"]')
    const p = dlg.getBoundingClientRect()
    const cards = document.querySelector('[data-permission-requests]')
    const c = cards.getBoundingClientRect()
    const out = []
    const fmt = (r) => [r.left, r.top, r.right, r.bottom].map(n => n.toFixed(1)).join(',')
    const hit = (r, name) => {
      if (r.right - r.left <= 0 || r.bottom - r.top <= 0) return
      const w = Math.min(p.right, r.right) - Math.max(p.left, r.left)
      const h = Math.min(p.bottom, r.bottom) - Math.max(p.top, r.top)
      if (w > 0.5 && h > 0.5) out.push({ target: name, popup: fmt(p), target_box: fmt(r) })
    }
    const clip = (r) => ({ left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) })
    hit(c, 'cards box')
    for (const h of cards.querySelectorAll('[data-permission-head]')) hit(clip(h.getBoundingClientRect()), 'cards head "' + h.textContent.trim().slice(0, 30) + '"')
    for (const b of cards.querySelectorAll('button')) {
      const n = (b.getAttribute('aria-label') || b.textContent || '').trim()
      if (/^(Approve|Approuver|Deny|Refuser)/i.test(n)) hit(clip(b.getBoundingClientRect()), 'button "' + n.slice(0, 30) + '"')
    }
    return out
  })()`) as Promise<Overlap[]>
}

for (const kind of ['tool', 'discovery'] as Kind[]) {
  for (const [w, h] of SIZES) {
    test(`${w}x${h}: ${kind} popup over a permission card keeps the title and the buttons uncovered; Tab, focus indicator, Escape`, async () => {
      const { page, app } = await openWithCard(browser, server, w, h, w < 768, { tourOffered: true })
      try {
        await feed(page, app, kind)
        await openPopup(app, kind)
        await waitForStableLayout(app)
        assert.equal(await app.locator('[data-permission-requests] [data-nonce]').count(), 1, 'one permission card')

        // 1. Geometry: nothing of the decision is under the popup
        const covered = await coveredByPopup(app) // asserted last, so that Tab and Escape are still checked when this is red
        assert.ok(await noHorizontalScroll(app), 'no horizontal scroll with the popup and the card')

        // 2. Keyboard: Tab from the popup. Every stop that is a card button must be drawn and uncovered (a popup that
        // closed when the focus entered the cards, the floor of placePopup, would be fine too; measured either way).
        await app.locator('[role="dialog"]').focus()
        // (no tabAround: the cycle of the page goes through the browser's own focus, i.e. the body, where there is no stop)
        const stops: Probe[] = []
        const met = (re: RegExp) => stops.some(s => s.inCards && re.test(s.name))
        for (let i = 0; i < 80 && !(met(APPROVE) && met(DENY)); i++) {
          await page.keyboard.press('Tab')
          const p = await probe(app)
          if (p) stops.push(p)
        }
        await attachUnfocused(app, stops)
        assert.ok(stops.some(s => s.inCards && APPROVE.test(s.name)), `Tab reaches Approve (stops: ${stops.map(s => s.name).join(' | ')})`)
        assert.ok(stops.some(s => s.inCards && DENY.test(s.name)), 'Tab reaches Deny')
        const cardProblems = focusProblems(stops.filter(s => s.inCards), () => true)

        // 3. Escape closes the popup (reopened if Tab already closed it: Escape is tested on an open popup), the card
        // stays and the focus is back on the outline button that opened it.
        if (await app.getByRole('dialog').count() === 0) await openPopup(app, kind)
        await app.locator('[role="dialog"]').focus()
        await page.keyboard.press('Escape')
        await app.getByRole('dialog').waitFor({ state: 'detached' })
        assert.equal(await app.locator('[data-permission-requests] [data-nonce]').count(), 1, 'the card is still there')
        await app.waitForFunction(`!!document.activeElement && document.activeElement.hasAttribute('data-e2e-opener')`)
        assert.ok(await noHorizontalScroll(app), 'no horizontal scroll once closed')
        assert.deepEqual(covered, [], 'the popup covers no part of the cards: neither their title nor Approve / Deny (project rule, #558)')
        assert.deepEqual(cardProblems, [], 'every card button reached by Tab is drawn, has a focus indicator and is not covered')
      } finally {
        await page.context().close()
      }
    })
  }
}
