// A permission card with a drawer open, on a phone-sized screen (#516, follow-up of #476), measured in a real browser.
// Cards only exist inside VS Code, so the demo app is loaded in an iframe of a same-origin host page that plays the
// extension: it posts `__vscode-bridge-init` then a `permission-request` to the frame, exactly as the webview does
// (the bridge accepts messages from window.parent only). No production code is involved.
// Checked at 375x667, 390x844 and 320x568, with the Sessions drawer open: the card is reached by Tab, the focus is
// never hidden under another surface (2.4.7, 2.4.11), Approve and Deny are at least 44x44 px, nothing scrolls
// sideways, Escape closes the drawer and gives the focus back.
// Not covered: a real device (Safari iOS, Chrome Android). This is Chromium emulation only.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Frame, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
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

const HOST_PATH = '/__e2e-extension-host'
const NONCE = '0123456789abcdef0123456789abcdef'
const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100vw;height:100vh;display:block}</style></head>
<body><iframe id="app" title="app" src="/"></iframe></body></html>`

interface Opened { page: Page; app: Frame }

/** The demo inside a frame, told by its parent that it runs in VS Code, with one permission request waiting. */
async function openWithCard(w: number, h: number): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true })
  const page = await context.newPage()
  await page.route(`${server.url}${HOST_PATH}`, route => route.fulfill({ contentType: 'text/html', body: HOST_HTML }))
  await page.goto(`${server.url}${HOST_PATH}`)
  const handle = await page.locator('#app').elementHandle()
  const app = (await handle!.contentFrame())!
  await app.locator('header').getByRole('button', { name: /^More/ }).waitFor()
  // The bridge listens only once React has hydrated: an init before that would be lost
  await app.waitForFunction(`[...document.querySelectorAll('header button')].some(b => Object.keys(b).some(k => k.startsWith('__reactProps')))`)
  // Same conversation as the extension, from the parent window (the bridge checks e.source === window.parent):
  // init, then the request once the page declared its decision surface (the extension holds requests until then)
  await page.evaluate(`new Promise(resolve => {
    const win = document.getElementById('app').contentWindow
    window.addEventListener('message', function onMsg(e) {
      if (e.source !== win || !e.data || e.data.type !== 'permission-surface' || e.data.ready !== true) return
      window.removeEventListener('message', onMsg)
      win.postMessage({ type: 'permission-request', request: {
        sessionId: 'sess-e2e', toolUseId: 'toolu_e2e', nonce: ${JSON.stringify(NONCE)}, toolName: 'Bash',
        inputPreview: '{"command":"npm test"}', inputTruncated: false, inputSha256: ${JSON.stringify('c'.repeat(64))},
        requestedAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 } }, '*')
      resolve(true)
    })
    win.postMessage({ type: '__vscode-bridge-init' }, '*')
  })`)
  await app.locator('[data-permission-requests] [data-nonce]').waitFor()
  await waitForStableLayout(app)
  return { page, app }
}

const noHorizontalScroll = (app: Frame) => app.evaluate('document.documentElement.scrollWidth <= window.innerWidth') as Promise<boolean>

interface Probe { id: string; name: string; inCards: boolean; inDrawer: boolean; visible: boolean; inViewport: boolean; hiddenBy: string | null }

/**
 * The focused element, and whether it can be seen: its box lies in the window and the topmost element at its centre
 * and at its four corners (1 px in) is itself or a descendant, i.e. nothing is drawn over it (2.4.11).
 */
const PROBE = `(() => {
  const el = document.activeElement
  if (!el || el === document.body) return null
  const r = el.getBoundingClientRect()
  const inViewport = r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5
  const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]]
  let hiddenBy = null
  for (const [x, y] of pts) {
    const top = document.elementFromPoint(x, y)
    if (!top || !(top === el || el.contains(top) || top.contains(el))) { hiddenBy = top ? top.tagName + (top.id ? '#' + top.id : '') + '.' + String(top.className).slice(0, 40) : 'nothing'; break }
  }
  return { id: el.id, name: el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30),
    inCards: !!el.closest('[data-permission-requests]'), inDrawer: !!el.closest('[data-mobile-drawer]'),
    visible: r.width > 0 && r.height > 0, inViewport, hiddenBy }
})()`

async function probe(app: Frame): Promise<Probe | null> {
  return app.evaluate(PROBE) as Promise<Probe | null>
}

/** Presses Tab until the cycle comes back to its first stop; returns every stop met. */
async function tabAround(page: Page, app: Frame, max = 40): Promise<Probe[]> {
  const stops: Probe[] = []
  const key = (s: Probe) => `${s.inCards}|${s.inDrawer}|${s.name}`
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const p = await probe(app)
    assert.ok(p, `Tab ${i + 1}: the focus is on an element`)
    stops.push(p)
    if (stops.length > 2 && key(p) === key(stops[0])) break
  }
  return stops
}

/** What is wrong with the Tab stops: out of the window, covered by another element (2.4.11), or outside the cycle. */
function focusProblems(stops: Probe[], cycle: (s: Probe) => boolean = s => s.inCards || s.inDrawer): string[] {
  const problems: string[] = []
  for (const s of stops) {
    if (!s.visible || !s.inViewport) problems.push(`"${s.name}" has focus but is not inside the window`)
    if (s.hiddenBy !== null) problems.push(`"${s.name}" has focus but is covered by ${s.hiddenBy}`)
    if (!cycle(s)) problems.push(`Tab left the cycle for "${s.name}" (${s.id})`)
  }
  return problems
}

const APPROVE =/^(Approve|Approuver)/i
const DENY = /^(Deny|Refuser)/i

for (const [w, h] of [[375, 667], [390, 844], [320, 568]] as Array<[number, number]>) {
  test(`${w}x${h}: permission card with the Sessions drawer open (keyboard, focus visible, targets, scroll, Escape)`, async () => {
    const { page, app } = await openWithCard(w, h)
    try {
      const sessions = app.locator('header').getByRole('button', { name: /^Sessions/ })
      await sessions.focus()
      await page.keyboard.press('Enter')
      const drawer = app.getByRole('dialog', { name: /Sessions/i })
      await drawer.waitFor()
      await app.waitForFunction(`!!document.activeElement && !!document.activeElement.closest('[data-mobile-drawer]')`)
      await waitForStableLayout(app)

      assert.equal(await app.locator('[data-permission-requests] [data-nonce]').count(), 1, 'one permission card')

      // Tab reaches the card and the drawer, and the focus is never hidden under something else
      const stops = await tabAround(page, app)
      assert.ok(stops.some(s => s.inCards && APPROVE.test(s.name)), 'Tab reaches Approve')
      assert.ok(stops.some(s => s.inCards && DENY.test(s.name)), 'Tab reaches Deny')
      assert.ok(stops.some(s => s.inDrawer), 'Tab reaches the drawer')
      // Asserted last, so that Escape and the scroll are still checked when the focus is hidden
      const problems = focusProblems(stops)

      assert.ok(await noHorizontalScroll(app), 'no horizontal scroll with the card and the drawer')

      // Escape closes the drawer, the card stays, the focus goes back to Sessions
      // (from a control of the drawer: the Tab loop above may have ended on the card, which is not the drawer's)
      await app.locator('[data-mobile-drawer] [data-panel-close]').focus()
      await page.keyboard.press('Escape')
      await app.waitForFunction(`!document.querySelector('[data-mobile-drawer]')`)
      assert.equal(await app.getByRole('dialog').count(), 0, 'the drawer is closed')
      assert.equal(await app.locator('[data-permission-requests] [data-nonce]').count(), 1, 'the card is still there')
      assert.equal(await app.evaluate(`document.activeElement && document.activeElement.id`), 'topbar-toggle-sessions', 'the focus is back on Sessions')
      assert.ok(await noHorizontalScroll(app), 'no horizontal scroll once closed')
      assert.deepEqual(problems, [], 'every Tab stop is drawn in the window, uncovered, and inside the card or the drawer')
    } finally {
      await page.context().close()
    }
  })
}

// Control: with no drawer the same probe finds the card reachable and uncovered, so a red result above is the drawer's.
for (const [w, h] of [[375, 667], [390, 844], [320, 568]] as Array<[number, number]>) {
  test(`${w}x${h}: control, the card alone is reached by Tab and its focus is not covered; no horizontal scroll`, async () => {
    const { page, app } = await openWithCard(w, h)
    try {
      await app.evaluate(`document.activeElement && document.activeElement.blur()`)
      const seen: Probe[] = []
      for (let i = 0; i < 60 && !(seen.some(s => APPROVE.test(s.name) && s.inCards) && seen.some(s => DENY.test(s.name) && s.inCards)); i++) {
        await page.keyboard.press('Tab')
        const p = await probe(app)
        assert.ok(p, `Tab ${i + 1}: the focus is on an element`)
        seen.push(p)
      }
      assert.ok(seen.some(s => s.inCards && APPROVE.test(s.name)), 'Tab reaches Approve')
      assert.ok(seen.some(s => s.inCards && DENY.test(s.name)), 'Tab reaches Deny')
      assert.deepEqual(focusProblems(seen.filter(s => s.inCards), () => true), [], 'the card stops are drawn and uncovered')
      assert.ok(await noHorizontalScroll(app), 'no horizontal scroll')
    } finally {
      await page.context().close()
    }
  })
}

// Own test, so that a too small target does not hide what the test above proves about focus and keyboard.
for (const [w, h] of [[375, 667], [390, 844], [320, 568]] as Array<[number, number]>) {
  test(`${w}x${h}: Approve and Deny of a permission card are at least 44x44 px, drawer open (2.5.5 / 2.5.8)`, async () => {
    const { page, app } = await openWithCard(w, h)
    try {
      await app.locator('header').getByRole('button', { name: /^Sessions/ }).click()
      await app.getByRole('dialog', { name: /Sessions/i }).waitFor()
      await waitForStableLayout(app)
      const targets = await app.evaluate(`[...document.querySelectorAll('[data-permission-requests] button')]
        .filter(el => el.getBoundingClientRect().width > 0)
        .map(el => { const r = el.getBoundingClientRect(); return { name: (el.getAttribute('aria-label') || el.textContent).trim(), w: r.width, h: r.height } })`) as Array<{ name: string; w: number; h: number }>
      const approve = targets.filter(t => APPROVE.test(t.name))
      const deny = targets.filter(t => DENY.test(t.name))
      assert.equal(approve.length, 1, `an Approve button is drawn (found: ${targets.map(t => t.name).join(', ')})`)
      assert.equal(deny.length, 1, `a Deny button is drawn (found: ${targets.map(t => t.name).join(', ')})`)
      const small = [...approve, ...deny].filter(t => t.w < 44 - 0.01 || t.h < 44 - 0.01)
      assert.deepEqual(small.map(t => `"${t.name}" is ${t.w.toFixed(1)}x${t.h.toFixed(1)} px`), [], '44x44 px needed')
    } finally {
      await page.context().close()
    }
  })
}
