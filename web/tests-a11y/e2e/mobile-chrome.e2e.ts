// Phone-width chrome (#378, lot 3), measured in a real browser against the demo app (`pnpm --dir web run test:e2e`).
// On develop @ b177753 the top bar took 193 px of 844 at 390 px wide and 290 px of 568 at 320 px (every
// control and every total on its own wrapped line), and the Timeline drew its last header label half outside
// the canvas ("0:0"). Under 600 px the totals and filters now fold behind a named disclosure button; the panel
// toggles stay in the bar (they are the focus fallback of the panels they open).
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
  await page.getByRole('button', { name: 'Timeline', exact: true }).waitFor()
  await waitForStableLayout(page)
  return page
}

const topbarBox = (page: Page) => page.locator('header').first().boundingBox().then(b => b!)
const noHorizontalScroll = (page: Page) => page.evaluate('document.documentElement.scrollWidth <= window.innerWidth') as Promise<boolean>

/** Interactive controls of the top bar that are rendered, with their size. */
async function visibleControls(page: Page): Promise<Array<{ name: string; w: number; h: number }>> {
  return page.evaluate(`[...document.querySelector('header').querySelectorAll('button, [role="combobox"], select, a[href]')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' })
    .map(el => { const r = el.getBoundingClientRect(); return { name: el.getAttribute('aria-label') || el.textContent.trim(), w: r.width, h: r.height } })`) as Promise<Array<{ name: string; w: number; h: number }>>
}

// Height budgets, folded: four rows at 390 px (Sessions; connection and More; the side panels; the other toggles),
// five at 320 px where the side panels group itself needs two lines; 599 px, the last folded width, fits in the
// 390 px budget. Measured before #378: 193 and 290.5 px.
for (const [w, h, budget] of [[599, 800, 140], [390, 844, 140], [320, 568, 180]] as Array<[number, number, number]>) {
  test(`top bar ${w}x${h}: folded under 600 px it stays within ${budget} px, totals one named button away`, async () => {
    const page = await open(w, h)
    try {
      const bar = await topbarBox(page)
      assert.ok(bar.height <= budget, `the top bar is ${bar.height} px high at ${w}x${h} (budget ${budget})`)
      assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll')

      const more = page.getByRole('button', { name: /^More/ })
      assert.equal(await more.getAttribute('aria-expanded'), 'false')
      const totals = page.locator('header').getByText(/tokens in context/)
      // Folded, the totals are visually hidden (sr-only, 1 px) but stay in the accessibility tree
      // Width actually drawn: the narrowest box among the text and its ancestors in the bar (sr-only clips to 1 px)
      const drawnWidth = () => totals.evaluate((el: Element) => {
        let w = Infinity
        for (let n: Element | null = el; n && n.tagName !== 'HEADER'; n = n.parentElement) {
          const r = n.getBoundingClientRect()
          if (getComputedStyle(n).display !== 'contents') w = Math.min(w, r.width)
        }
        return w
      })
      assert.ok(await drawnWidth() <= 1, 'folded: the token total is not drawn')
      assert.match(String(await page.locator('header').ariaSnapshot()), /tokens in context/, 'folded: screen readers still read the token total')
      assert.equal(await page.getByRole('button', { name: 'Hide inactive agents', exact: true }).count(), 0, 'folded: the filters are not in the Tab order')
      const invisible = await page.evaluate(findInvisibleFocusables, FOCUSABLE_SELECTOR)
      assert.deepEqual(invisible.filter(i => !i.startsWith('nextjs-portal')), [], 'folded: no invisible Tab stop')
      // Always in the bar: the connection state, the Sessions button and the panel toggles
      for (const name of ['Timeline', 'Stats', 'Files']) {
        assert.ok(await page.getByRole('button', { name, exact: true }).isVisible(), `${name} stays in the bar`)
      }
      for (const c of await visibleControls(page)) {
        assert.ok(c.w >= 24 && c.h >= 24, `folded: "${c.name}" is ${c.w}x${c.h} px (2.5.8 needs 24x24)`)
      }
      await expectHeaderClean(page, `e2e:topbar-folded-${w}`)

      // Keyboard: the disclosure opens with Enter and the next Tab stop is the first folded control
      await more.focus()
      await page.keyboard.press('Enter')
      assert.equal(await more.getAttribute('aria-expanded'), 'true')
      assert.ok(await drawnWidth() > 1, 'expanded: the token total is drawn')
      await page.keyboard.press('Tab')
      const next = await page.evaluate('document.activeElement && document.activeElement.textContent.trim()')
      assert.match(String(next), /Notifications|Hide inactive agents|Show finished|finished/, `Tab after More reaches a folded control (got "${next}")`)
      assert.ok(await noHorizontalScroll(page), 'expanded: no horizontal page scroll')
      for (const c of await visibleControls(page)) {
        assert.ok(c.w >= 24 && c.h >= 24, `expanded: "${c.name}" is ${c.w}x${c.h} px`)
      }
      await expectHeaderClean(page, `e2e:topbar-expanded-${w}`)
      // The panels move below the bar that grew
      const grown = await topbarBox(page)
      assert.ok(grown.height > bar.height, 'expanding shows more rows')
      await more.click()
      assert.equal(await more.getAttribute('aria-expanded'), 'false')
    } finally {
      await page.context().close()
    }
  })
}

// 600 px and wider (1280 px is also 640 px at 200 % browser zoom): nothing folds, no disclosure button
for (const [w, h] of [[600, 800], [640, 400], [1280, 800]] as Array<[number, number]>) {
  test(`top bar ${w}x${h}: nothing is folded at 600 px and wider`, async () => {
    const page = await open(w, h)
    try {
      assert.equal(await page.getByRole('button', { name: /^More/ }).count(), 0, 'no disclosure button')
      assert.ok(await page.getByText(/tokens in context/).isVisible(), 'the token total is drawn')
      assert.ok(await noHorizontalScroll(page), 'no horizontal page scroll')
    } finally {
      await page.context().close()
    }
  })
}

// Folded, a filter that changes what the canvas shows is never hidden behind a plain "More" (docs/reading-the-ui.md)
test('top bar 390x844: folded with Hide inactive agents on, More says a filter is on', async () => {
  const page = await open(390, 844)
  try {
    const more = page.getByRole('button', { name: /^More · \d+ filters? on/ })
    assert.ok(await more.isVisible(), 'More shows that a filter is on')
    assert.match(String(await more.getAttribute('aria-label')), /Hide inactive agents/, 'its name says which one')
    // Visible text kept short: at 320 px "More · 1 filter on" pushed More onto a row of its own (196.5 px bar)
    assert.match(String(await more.textContent()), /^More · \d+ filters?$/)
    // Turn the filter off: More no longer lists it
    await more.click()
    const hide = page.getByRole('button', { name: 'Hide inactive agents', exact: true })
    assert.equal(await hide.getAttribute('aria-pressed'), 'true', 'Hide inactive agents is on by default')
    await hide.click()
    assert.equal(await hide.getAttribute('aria-pressed'), 'false')
    const disclosure = page.locator('header button[aria-expanded]')
    await disclosure.click()
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false')
    assert.doesNotMatch(String(await disclosure.getAttribute('aria-label')), /Hide inactive agents/)
  } finally {
    await page.context().close()
  }
})

// Crossing 600 px (a resize or a browser zoom) must not drop the focus on <body> (2.4.3)
const focusedName = (page: Page) => page.evaluate(`(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : (a.getAttribute('aria-label') || a.textContent.trim()) })()`) as Promise<string>

test('top bar: More has the focus and the window widens past 600 px, the focus stays in the bar', async () => {
  const page = await open(390, 844)
  try {
    await page.locator('header button[aria-expanded]').focus()
    await page.setViewportSize({ width: 700, height: 844 })
    await page.waitForFunction(`!document.querySelector('header button[aria-expanded]')`)
    const name = await focusedName(page)
    assert.notEqual(name, 'BODY', 'the focus is not lost on <body>')
    assert.ok(await page.evaluate(`document.querySelector('header').contains(document.activeElement)`), `the focus stays in the top bar (got "${name}")`)
  } finally {
    await page.context().close()
  }
})

test('top bar: a filter has the focus and the window narrows under 600 px, the filter keeps it', async () => {
  const page = await open(700, 844)
  try {
    await page.getByRole('button', { name: 'Hide inactive agents', exact: true }).focus()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForFunction(`!!document.querySelector('header button[aria-expanded]')`)
    assert.equal(await focusedName(page), 'Hide inactive agents', 'the focused filter is still rendered and focused')
    assert.equal(await page.locator('header button[aria-expanded]').getAttribute('aria-expanded'), 'true', 'More opened to keep it')
  } finally {
    await page.context().close()
  }
})

for (const [w, h] of [[390, 844], [320, 568]] as Array<[number, number]>) {
  test(`timeline ${w}x${h}: header labels neither touch each other nor leave the canvas`, async () => {
    const page = await open(w, h)
    try {
      await page.getByRole('button', { name: 'Timeline', exact: true }).click()
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
      await page.getByRole('button', { name: /^Conversation/ }).first().click()
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
