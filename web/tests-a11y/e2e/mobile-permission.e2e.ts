// A permission card with a drawer open, on a phone-sized screen (#516, follow-up of #476), measured in a real browser.
// Cards only exist inside VS Code, so the demo app is loaded in an iframe of a same-origin host page that plays the
// extension: it posts `__vscode-bridge-init` then a `permission-request` to the frame, exactly as the webview does
// (the bridge accepts messages from window.parent only). No production code is involved.
// Checked at 375x667, 390x844 and 320x568, with the Sessions drawer open: the card is reached by Tab, the focus is
// never hidden under another surface and always drawn with an indicator (2.4.7, 2.4.11), Approve and Deny are at
// least 44x44 px (project rule #476, WCAG 2.5.5 AAA), nothing scrolls sideways (320 px reflow, 1.4.10: the card and
// its buttons also lie inside the window), Escape closes the drawer and gives the focus back.
// Focus visibility is checked on two levels. 2.4.11 (AA, Focus Not Obscured Minimum) fails when a focused control is
// entirely hidden. The project rule, which is 2.4.12 (AAA, Focus Not Obscured Enhanced): no part of it is covered,
// so any covered probe point fails as well; both are reported apart.
// Not covered: a real device (Safari iOS, Chrome Android). This is Chromium emulation only.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { APPROVE, DENY, NONCE, focusProblems, tabAround, probe, attachUnfocused, noHorizontalScroll, outsideWindow, openWithCard as openCard, type Probe } from './permission-card'

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

const openWithCard = (w: number, h: number) => openCard(browser, server, w, h)

for (const [w, h] of [[375, 667], [390, 844], [320, 568]] as Array<[number, number]>) {
  test(`${w}x${h}: permission card with the Sessions drawer open (keyboard, focus indicator, not obscured, scroll, Escape)`, async () => {
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
      assert.deepEqual(await outsideWindow(app), [], 'the card and its buttons lie inside the window (reflow)')

      // Escape closes the drawer, the card stays, the focus goes back to Sessions
      // (from a control of the drawer: the Tab loop above may have ended on the card, which is not the drawer's)
      await app.locator('[data-mobile-drawer] [data-panel-close]').focus()
      await page.keyboard.press('Escape')
      await app.waitForFunction(`!document.querySelector('[data-mobile-drawer]')`)
      assert.equal(await app.getByRole('dialog').count(), 0, 'the drawer is closed')
      assert.equal(await app.locator('[data-permission-requests] [data-nonce]').count(), 1, 'the card is still there')
      assert.equal(await app.evaluate(`document.activeElement && document.activeElement.id`), 'topbar-toggle-sessions', 'the focus is back on Sessions')
      assert.ok(await noHorizontalScroll(app), 'no horizontal scroll once closed')
      assert.deepEqual(problems, [], 'every Tab stop is drawn in the window, has a focus indicator, is uncovered, and is inside the card or the drawer')
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
      await attachUnfocused(app, seen)
      assert.deepEqual(focusProblems(seen.filter(s => s.inCards), () => true), [], 'the card stops are drawn and uncovered')
      assert.ok(await noHorizontalScroll(app), 'no horizontal scroll')
      assert.deepEqual(await outsideWindow(app), [], 'the card and its buttons lie inside the window (reflow)')
    } finally {
      await page.context().close()
    }
  })
}

// Own test, so that a too small target does not hide what the test above proves about focus and keyboard.
for (const [w, h] of [[375, 667], [390, 844], [320, 568]] as Array<[number, number]>) {
  test(`${w}x${h}: Approve and Deny of a permission card are at least 44x44 px, drawer open (project rule #476, WCAG 2.5.5 AAA)`, async () => {
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

// The drawer returns to its full height once the last card is gone: the card's height variable and flag are removed
// by the effect of PermissionRequests (jsdom has no ResizeObserver, that effect returns early there, so only a real
// browser sees this cleanup). The card is closed the way the extension does it, with `permission-closed` (expired).
for (const [w, h] of [[375, 667], [320, 568]] as Array<[number, number]>) {
  test(`${w}x${h}: once the last card is decided or expired, the drawer gets its full height back and no longer scrolls`, async () => {
    const { page, app } = await openWithCard(w, h)
    try {
      await app.locator('header').getByRole('button', { name: /^Sessions/ }).click()
      const drawer = app.getByRole('dialog', { name: /Sessions/i })
      await drawer.waitFor()
      await waitForStableLayout(app)
      const measure = () => app.evaluate(`(() => {
        const d = document.querySelector('[data-mobile-drawer]')
        const r = d.getBoundingClientRect()
        const cs = getComputedStyle(d)
        return { top: r.top, height: r.height, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight, overflowY: cs.overflowY, maxHeight: cs.maxHeight,
          flag: document.documentElement.hasAttribute('data-permission-open'), cardH: document.documentElement.style.getPropertyValue('--permission-h') }
      })()`) as Promise<{ top: number; height: number; scrollHeight: number; clientHeight: number; overflowY: string; maxHeight: string; flag: boolean; cardH: string }>
      const withCard = await measure()
      assert.equal(withCard.flag, true, 'the page is flagged while a card is shown')
      assert.match(withCard.cardH, /^\d+px$/, 'the card height is published')
      assert.equal(withCard.overflowY, 'auto', 'the drawer is a scroll container under a card')

      await page.evaluate(`document.getElementById('app').contentWindow.postMessage({ type: 'permission-closed',
        sessionId: 'sess-e2e', toolUseId: 'toolu_e2e', nonce: ${JSON.stringify(NONCE)}, outcome: 'expired' }, '*')`)
      await app.locator('[data-permission-requests] [data-nonce]').waitFor({ state: 'detached' })
      await app.waitForFunction(`!document.documentElement.hasAttribute('data-permission-open')`)
      await waitForStableLayout(app)

      const after = await measure()
      assert.equal(after.flag, false, 'the flag is removed')
      assert.equal(after.cardH, '', 'the card height variable is removed')
      assert.notEqual(after.overflowY, 'auto', 'the drawer is no longer a scroll container')
      assert.equal(after.maxHeight, 'none', 'the drawer is no longer capped under the card')
      assert.ok(after.scrollHeight <= after.clientHeight + 1, `the drawer does not scroll (scrollHeight ${after.scrollHeight}, clientHeight ${after.clientHeight})`)
      // under a card the drawer also holds 2 x 5 px of padding (room for the focus ring), which is gone with the card
      assert.ok(Math.abs(after.height - after.scrollHeight) <= 1, `the drawer shows all its content (height ${after.height}, content ${after.scrollHeight})`)
      assert.ok(after.height >= withCard.scrollHeight - 10 - 0.5, `the content is not cut (${after.height} vs ${withCard.scrollHeight - 10} under the card)`)
      if (withCard.scrollHeight > withCard.clientHeight + 1) assert.ok(after.height > withCard.height, `the drawer was capped under the card and is taller now (${after.height} vs ${withCard.height})`)
      assert.ok(after.top < withCard.top, `the drawer starts higher once the card is gone (${after.top} vs ${withCard.top})`)
    } finally {
      await page.context().close()
    }
  })
}
