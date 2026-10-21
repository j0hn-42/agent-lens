// Phone-width chrome (#378, lot 3), measured in a real browser against the demo app (`pnpm --dir web run test:e2e`).
// On develop @ b177753 the top bar took 193 px of 844 at 390 px wide and 290 px of 568 at 320 px (every
// control and every total on its own wrapped line), and the Timeline drew its last header label half outside
// the canvas ("0:0"). Under 600 px the totals and filters then folded behind a named disclosure button; since #476
// the fold starts under 768 px and also takes the panel buttons (More is the focus fallback of the panels they open).
// Since the one-line bar (owner request, 2026-10-21) the bar is one row at every width and More an overlay.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { compareViolations, type KnownViolation } from '../axe-compare'
import { waitForStableLayout } from './stable-layout'
import { findInvisibleFocusables, FOCUSABLE_SELECTOR } from './focus-audit'
import { startDemoServer, type DemoServer } from './demo-server'
import { topbarButton } from './topbar-fold'

const known: KnownViolation[] = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'known-violations.json'), 'utf8'))

/** axe on the top bar only, serious and critical, against the shared allow-list (never widened here). */
async function expectHeaderClean(page: Page, scenario: string) {
  const results = await new AxeBuilder({ page }).include('header').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
  const { unexpected, stale } = compareViolations(scenario, serious.map(v => v.id), known)
  assert.deepEqual(unexpected, [], `[${scenario}] new serious/critical axe violations in the top bar: ${serious.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`).join('; ')}`)
  assert.deepEqual(stale, [], `[${scenario}] allow-listed violations no longer occur`)
}

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

// Records, per drawn frame (clearRect starts one), the header labels the Timeline canvas writes. A string so the
// TS transpiler injects no helper into the page.
const TICK_RECORDER = `(() => {
  window.__timelineFrames = []
  const onTimeline = (ctx) => !!(ctx.canvas && ctx.canvas.closest && ctx.canvas.closest('[aria-label="Execution timeline"]'))
  const clear = CanvasRenderingContext2D.prototype.clearRect
  CanvasRenderingContext2D.prototype.clearRect = function (...a) {
    if (onTimeline(this)) window.__timelineFrames.push({ width: this.canvas.clientWidth, labels: [] })
    return clear.apply(this, a)
  }
  const fill = CanvasRenderingContext2D.prototype.fillText
  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, max) {
    const frames = window.__timelineFrames
    if (onTimeline(this) && this.textAlign === 'center' && /^\\d+(:\\d\\d)+$/.test(String(text)) && frames.length) {
      const w = this.measureText(String(text)).width
      frames[frames.length - 1].labels.push({ text: String(text), left: x - w / 2, right: x + w / 2 })
    }
    return fill.call(this, text, x, y, max)
  }
})()`

interface Frame { width: number; labels: Array<{ text: string; left: number; right: number }> }

async function open(w: number, h: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h } })
  await context.addInitScript(TICK_RECORDER)
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

const topbarBox = (page: Page) => page.locator('header').first().boundingBox().then(b => b!)
const noHorizontalScroll = (page: Page) => page.evaluate('document.documentElement.scrollWidth <= window.innerWidth') as Promise<boolean>

/** Interactive controls of the top bar that are rendered, with their size. */
async function visibleControls(page: Page): Promise<Array<{ name: string; w: number; h: number; top: number }>> {
  return page.evaluate(`[...document.querySelector('header').querySelectorAll('button, [role="combobox"], select, a[href]')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' })
    .map(el => { const r = el.getBoundingClientRect(); return { name: el.getAttribute('aria-label') || el.textContent.trim(), w: r.width, h: r.height, top: r.top } })`) as Promise<Array<{ name: string; w: number; h: number; top: number }>>
}

// Height budgets under 768 px. Before #378: 193 and 290.5 px; after #378 (600 px fold): 138 and 166.5 px; with the fold of
// #476 two or three rows of 44 px controls. Since the one-line bar (owner request, 2026-10-21) it is one row of 44 px
// targets: Sessions, the connection state, the attention counter and More, 56 px high (measured), More an overlay.
for (const [w, h] of [[767, 900], [390, 844], [320, 568]] as Array<[number, number]>) {
  test(`top bar ${w}x${h}: one row of 44 px targets under 768 px, More an overlay, totals one named button away`, async () => {
    const page = await open(w, h)
    try {
      const bar = await topbarBox(page)
      assert.ok(bar.height <= 57, `the top bar is ${bar.height} px high at ${w}x${h} (one row of 44 px targets)`)
      assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll')
      const tops = (await visibleControls(page)).map(c => c.top)
      assert.ok(Math.max(...tops) - Math.min(...tops) < 12, `one row: control tops ${tops.join(', ')}`)

      const more = page.locator('header #topbar-more')
      assert.equal(await more.getAttribute('aria-expanded'), 'false')
      // #523: the bar draws no totals (no tokens, no cost, no agent counts: those are in the Sessions panel header); the
      // totals stay in the bar for screen readers only (sr-only, 1 px), in the accessibility tree
      const totals = page.locator('header').getByTestId('topbar-spoken-totals')
      // Width actually drawn: the narrowest box among the text and its ancestors in the bar (sr-only clips to 1 px)
      const drawnWidth = () => totals.evaluate((el: Element) => {
        let w = Infinity
        for (let n: Element | null = el; n && n.tagName !== 'HEADER'; n = n.parentElement) {
          const r = n.getBoundingClientRect()
          if (getComputedStyle(n).display !== 'contents') w = Math.min(w, r.width)
        }
        return w
      })
      assert.ok(await drawnWidth() <= 1, 'the totals are not drawn')
      assert.match(String(await page.locator('header').ariaSnapshot()), /tokens in context/, 'screen readers still read the token total (#523: read, not drawn)')
      assert.equal(await page.getByRole('button', { name: /^Hide inactive: agents( and sessions)?$/ }).count(), 0, 'More closed: the filters are not in the Tab order')
      const invisible = await page.evaluate(findInvisibleFocusables, FOCUSABLE_SELECTOR)
      assert.deepEqual(invisible.filter(i => !i.startsWith('nextjs-portal')), [], 'More closed: no invisible Tab stop')
      // Under 768 px the panel buttons are behind More, not rendered (no hidden Tab stop)
      for (const name of ['Timeline', 'Stats', 'Files & repeats']) {
        assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `${name} is behind More`)
      }
      const sessions = page.locator('header').getByRole('button', { name: /^Sessions/ })
      assert.ok(await sessions.isVisible(), 'Sessions stays in the bar')
      // The selection stays written in the bar (its label may end in an ellipsis; the whole text is the name)
      assert.ok(await sessions.locator('[data-sensitive]').evaluate((el: Element) => el.getBoundingClientRect().width > 20), 'the Sessions label is drawn')
      for (const c of await visibleControls(page)) {
        assert.ok(c.w >= 44 && c.h >= 44, `"${c.name}" is ${c.w}x${c.h} px (44x44 under 768 px, #476)`)
      }
      await expectHeaderClean(page, `e2e:topbar-folded-${w}`)

      // Keyboard: Enter opens the overlay and the next Tab stop is inside it
      await more.focus()
      await page.keyboard.press('Enter')
      assert.equal(await more.getAttribute('aria-expanded'), 'true')
      assert.ok(await drawnWidth() <= 1, 'More open: the totals are still not drawn (#523)')
      await page.keyboard.press('Tab')
      assert.ok(await page.evaluate(`!!document.activeElement && !!document.activeElement.closest('header [data-topbar-menu]')`), 'Tab after More enters the overlay')
      assert.ok(await noHorizontalScroll(page), 'More open: no horizontal page scroll')
      for (const name of ['Timeline', 'Stats', 'Files & repeats']) {
        assert.ok(await page.getByRole('button', { name, exact: true }).isVisible(), `More open: ${name} is shown`)
      }
      for (const c of await visibleControls(page)) {
        assert.ok(c.w >= 44 && c.h >= 44, `More open: "${c.name}" is ${c.w}x${c.h} px`)
      }
      await expectHeaderClean(page, `e2e:topbar-expanded-${w}`)
      // An overlay: the bar keeps its height (the panels stay below it) and the overlay stays in the window
      assert.equal((await topbarBox(page)).height, bar.height, 'More open: the bar keeps its height')
      const menu = (await page.locator('header [data-topbar-menu]').boundingBox())!
      assert.ok(menu.x >= 0 && menu.x + menu.width <= w + 0.5 && menu.y + menu.height <= h + 0.5, `the overlay stays in the window (${JSON.stringify(menu)})`)
      await page.keyboard.press('Escape')
      assert.equal(await more.getAttribute('aria-expanded'), 'false')
      assert.ok(await more.evaluate((el: Element) => el === document.activeElement), 'Escape gives the focus back to More')
    } finally {
      await page.context().close()
    }
  })
}

// From 1024 px the seven panel buttons are in the bar, on the same row as Sessions and More (one-line bar); the bar draws
// no summary text (#523). 1280 px at 200 % browser zoom is 640 px wide: it is checked with the widths above
for (const [w, h] of [[1024, 900], [1280, 800]] as Array<[number, number]>) {
  test(`top bar ${w}x${h}: one row with the seven panel buttons, no summary text drawn`, async () => {
    const page = await open(w, h)
    try {
      assert.equal(await page.locator('header #topbar-more').count(), 1, 'More is in the bar at every width')
      for (const name of ['Files & repeats', 'Timeline', 'Stats']) {
        assert.ok(await page.locator('header').getByRole('button', { name, exact: true }).isVisible(), `${name} is in the bar`)
      }
      const tops = (await visibleControls(page)).map(c => c.top + c.h / 2)
      assert.ok(Math.max(...tops) - Math.min(...tops) < 12, `one row: control centres ${tops.join(', ')}`)
      // #523: the bar draws no summary text; the agent counts are drawn in the Sessions panel header
      assert.equal(await page.locator('header').getByTestId('topbar-agent-counts').count(), 0, 'no agent counts in the bar')
      const drawn = await page.locator('header').evaluate((el: Element) => { const c = el.cloneNode(true) as Element; for (const n of Array.from(c.querySelectorAll('.sr-only, [hidden], [role="tooltip"]'))) n.remove(); return c.textContent ?? '' })
      assert.doesNotMatch(drawn, /agents?:|\blast known\b|\bdone\b/, `no counts drawn in the bar: "${drawn}"`)
      assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll')
    } finally {
      await page.context().close()
    }
  })
}

// A filter that changes what the canvas shows is never hidden behind a plain "More" (docs/reading-the-ui.md)
test('top bar 390x844: with Hide inactive on, More says a filter is on', async () => {
  const page = await open(390, 844)
  try {
    const more = page.getByRole('button', { name: /^More · \d+ filters? on/ })
    assert.ok(await more.isVisible(), 'More shows that a filter is on')
    // The name is built from a hidden span through aria-labelledby (#373), so read that span, not aria-label
    const nameParts = await more.evaluate((el) => (el.getAttribute('aria-labelledby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
    assert.match(nameParts, /Hide inactive/, 'its name says which one')
    // Under 768 px More is an icon followed by the number of filters on; its name contains that number (2.5.3)
    const drawnText = (await more.innerText()).trim()
    assert.equal(drawnText, '1', `drawn: the number of filters on ("${drawnText}")`)
    assert.ok(nameParts.includes(drawnText))
    // Turn the filter off: More no longer lists it
    await more.click()
    const hide = page.getByRole('button', { name: /^Hide inactive: agents( and sessions)?$/ })
    assert.equal(await hide.getAttribute('aria-pressed'), 'true', 'Hide inactive is on by default')
    await hide.click()
    assert.equal(await hide.getAttribute('aria-pressed'), 'false')
    const disclosure = page.locator('header #topbar-more')
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true', 'a filter keeps More open')
    await disclosure.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
    assert.doesNotMatch(String(await disclosure.getAttribute('aria-label')), /Hide inactive/)
  } finally {
    await page.context().close()
  }
})

// Crossing 1024 or 768 px (a resize or a browser zoom) must not drop the focus on <body> (2.4.3)
const focusedName = (page: Page) => page.evaluate(`(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : (a.getAttribute('aria-label') || a.textContent.trim()) })()`) as Promise<string>

test('top bar: More has the focus and the window widens past 1024 px, More keeps it (it is in the bar at every width)', async () => {
  const page = await open(390, 844)
  try {
    await page.locator('header #topbar-more').focus()
    await page.setViewportSize({ width: 1100, height: 844 })
    await page.waitForFunction(`!!document.querySelector('header #topbar-toggle-files')`)
    assert.equal(await page.evaluate('document.activeElement && document.activeElement.id'), 'topbar-more', `the focus stays on More (got "${await focusedName(page)}")`)
  } finally {
    await page.context().close()
  }
})

test('top bar: a filter of More has the focus and the window narrows under 768 px, the filter keeps it', async () => {
  const page = await open(1100, 844)
  try {
    await (await topbarButton(page, /^Hide inactive: agents( and sessions)?$/)).focus()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(`!document.querySelector('header #topbar-toggle-files') || !!document.activeElement?.closest('[data-topbar-menu]')`)
    await waitForStableLayout(page)
    assert.match(String(await focusedName(page)), /^Hide inactive: agents( and sessions)?$/, 'the focused filter is still rendered and focused')
    assert.equal(await page.locator('header #topbar-more').getAttribute('aria-expanded'), 'true', 'More stays open around it')
  } finally {
    await page.context().close()
  }
})

for (const [w, h] of [[390, 844], [320, 568]] as Array<[number, number]>) {
  test(`timeline ${w}x${h}: header labels neither touch each other nor leave the canvas`, async () => {
    const page = await open(w, h)
    try {
      // A real pointer click (#497 review): the unfolded bar must stay above the canvas controls (Legend), or a touch on
      // Timeline opens the legend instead
      await (await topbarButton(page, 'Timeline')).click()
      await page.locator('[data-dock-panel="timeline"]').waitFor()
      await page.waitForTimeout(4000) // several redraws while the demo runs
      const frames = await page.evaluate('window.__timelineFrames') as Frame[]
      const drawn = frames.filter(f => f.labels.length > 0)
      assert.ok(drawn.length > 0, 'the timeline drew its header')
      for (const f of drawn) {
        const labels = [...f.labels].sort((a, b) => a.left - b.left)
        assert.ok(labels.length >= 2, `at least two labels give the scale (${labels.map(l => l.text).join(' ')})`)
        for (const l of labels) {
          assert.ok(l.left >= 0 && l.right <= f.width + 0.01, `"${l.text}" [${l.left.toFixed(1)}, ${l.right.toFixed(1)}] is cut by the ${f.width} px canvas`)
        }
        for (let i = 1; i < labels.length; i++) {
          assert.ok(labels[i].left - labels[i - 1].right >= 6 - 0.5, `"${labels[i - 1].text}" and "${labels[i].text}" touch (${(labels[i].left - labels[i - 1].right).toFixed(1)} px)`)
        }
      }
    } finally {
      await page.context().close()
    }
  })

  test(`conversation ${w}x${h}: the sheet ends above the control bar and below the top bar`, async () => {
    const page = await open(w, h)
    try {
      await (await topbarButton(page, /^Conversation/)).first().click()
      const panel = page.locator('[data-dock-panel="conversation"]')
      await panel.waitFor()
      await waitForStableLayout(page)
      const p = (await panel.boundingBox())!
      const bar = (await page.locator('[data-control-bar]').first().boundingBox())!
      const top = await topbarBox(page)
      assert.ok(p.y + p.height <= bar.y + 0.5, `Conversation ends at ${p.y + p.height}, the control bar starts at ${bar.y}`)
      assert.ok(p.y >= top.y + top.height - 0.5, `Conversation starts at ${p.y}, under the top bar ending at ${top.y + top.height}`)
    } finally {
      await page.context().close()
    }
  })
}
