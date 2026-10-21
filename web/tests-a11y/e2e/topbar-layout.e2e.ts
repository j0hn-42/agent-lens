// Layout of the top bar measured in a real browser against the demo app and the worst-case harness (`pnpm --dir web run test:e2e`).
// Owner request (2026-10-21, option A): "the top bar must stay on one line". It is ONE row at every width, in English and in
// French, also in the worst case (40-character session name, scope with its three discovery ceilings, attention counter with
// errors, DEMO with Exit demo or OFFLINE with its reconnect detail and Retry now, blocked Notifications, a filter, the quota).
// What does not fit moves behind More, an overlay disclosure that never adds a row, at fixed widths (no measuring in code):
//   from 1280 px: Sessions, connection state (+ Retry now / Exit demo), attention · panels (7 icons), Commands, More
//   1024-1279 px: Sessions, connection state, attention · panels, More
//   768-1023 px:  Sessions, connection state, attention · Commands, More
//   under 768 px: Sessions (label cut by an ellipsis), connection state, attention (count), More (44 px targets)
// More always holds the scope, the filters, the quota gauges and the tools; what it holds that the bar does not show is
// signalled on it (mark, description). --topbar-h follows the bar. The widths and heights are logged ("#one-line ...").
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { waitForStableLayout } from './stable-layout'
import { startDemoServer, type DemoServer } from './demo-server'
import { openWorstCase } from './topbar-worstcase'

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

const WIDTHS = [1920, 1440, 1280, 1100, 1024, 768, 390, 320] as const
type Locale = 'en' | 'fr'

async function open(w: number, locale: Locale = 'en'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: w < 768 ? 800 : 900 } })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

async function worstCase(w: number, locale: Locale, query = '?worst=1'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: w < 768 ? 800 : 900 } })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await openWorstCase(context, server.url, query)
  await waitForStableLayout(page)
  return page
}

const PANELS = ['Files & repeats', 'Conversation (C)', 'Context (P)', 'System (Y)', 'Cost', 'Timeline', 'Stats']

interface Layout {
  barHeight: number
  published: number
  rows: number
  pageScroll: boolean
  headerScroll: boolean
  /** Drawn controls of the bar (not of the More overlay) that leave the bar or the window */
  outside: string[]
  /** Drawn controls of the bar, in DOM order, with their size */
  controls: Array<{ name: string; width: number; height: number }>
  panels: number
  commands: boolean
}

/** Drawn controls of the bar grouped in rows (vertical centres more than 12 px apart); the More overlay is left out. */
const measure = (page: Page) => page.evaluate(`(() => {
  const header = document.querySelector('header')
  const hb = header.getBoundingClientRect()
  const menu = header.querySelector('[data-topbar-menu]')
  const drawn = [...header.querySelectorAll('button, select, [data-testid="connection-detail"], [data-connection-label]')].filter(el => {
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1 && !(menu && menu.contains(el))
  })
  const centres = drawn.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }).sort((a, b) => a - b)
  let rows = 0, last = -Infinity
  for (const c of centres) { if (c - last > 12) rows++; last = c }
  const name = el => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 60)
  const outside = drawn.filter(el => { const r = el.getBoundingClientRect(); return r.left < hb.left - 0.5 || r.right > hb.right + 0.5 || r.right > window.innerWidth + 0.5 }).map(name)
  return {
    barHeight: hb.height,
    published: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')),
    rows,
    pageScroll: document.documentElement.scrollWidth > window.innerWidth,
    headerScroll: header.scrollWidth > header.clientWidth + 1,
    outside,
    controls: drawn.map(el => { const r = el.getBoundingClientRect(); return { name: name(el), width: +r.width.toFixed(1), height: +r.height.toFixed(1) } }),
    panels: drawn.filter(el => /^topbar-toggle-/.test(el.id) && el.id !== 'topbar-toggle-sessions').length,
    commands: drawn.some(el => el.id === 'topbar-commands'),
  }
})()`) as Promise<Layout>

/** --topbar-h is the bar height + 20 px (topbarOffsetPx), rounded up. */
const expectPublished = (l: Layout, where: string) =>
  assert.equal(l.published, Math.ceil(l.barHeight) + 20, `${where}: --topbar-h ${l.published} px for a ${l.barHeight} px bar`)

/** What each width draws in the bar (fixed widths, see the header of this file). */
function expectTier(l: Layout, w: number, where: string) {
  if (w >= 1024) assert.equal(l.panels, 7, `${where}: the seven panel buttons are in the bar`)
  else assert.equal(l.panels, 0, `${where}: the panel buttons are behind More`)
  assert.equal(l.commands, w >= 1280 || (w >= 768 && w < 1024), `${where}: Commands ${l.commands ? 'drawn' : 'not drawn'}`)
  // 38.5 px from 768 px (26.5 px controls), 56 px under 768 px (44 px targets)
  if (w >= 768) assert.ok(l.barHeight <= 40, `${where}: bar ${l.barHeight} px high`)
  else {
    assert.ok(l.barHeight <= 57, `${where}: bar ${l.barHeight} px high`)
    for (const c of l.controls.filter(c => !/^(DEMO|DÉMO|LIVE|EN DIRECT|OFFLINE|HORS LIGNE|CONNECTED|CONNECTÉ|CONNECTING|CONNEXION)$/.test(c.name))) {
      assert.ok(c.height >= 44 && c.width >= 44, `${where}: ${c.name} is ${c.width}x${c.height} px (44 px target)`)
    }
  }
}

/**
 * How many leading characters of the selection (session name, "All sessions") the Sessions button draws in the bar, before
 * its ellipsis (review of PR 631: at 320 px the button showed "Session… (1) ⚠ ●", and nothing of the name offline). Read on
 * the drawn text: a text node outside the visually hidden parts, each character's box inside the box that clips the label,
 * the last character before the clip edge being covered by the ellipsis.
 */
const selectionShown = (page: Page, selection: string) => page.evaluate(`(() => {
  const selection = ${JSON.stringify(selection)}
  const button = document.getElementById('topbar-toggle-sessions')
  const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
  let node = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.parentElement.closest('.sr-only, [aria-hidden="true"]')) continue
    if (n.data.includes(selection)) { node = n; break }
  }
  if (!node) return { chars: 0, clipWidth: 0 }
  let clip = node.parentElement
  while (clip !== button && getComputedStyle(clip).overflow === 'visible') clip = clip.parentElement
  const cb = clip.getBoundingClientRect()
  const start = node.data.indexOf(selection)
  const range = document.createRange()
  let chars = 0
  for (let k = 0; k < selection.length; k++) {
    range.setStart(node, start + k); range.setEnd(node, start + k + 1)
    const r = range.getBoundingClientRect()
    const truncated = clip.scrollWidth > clip.clientWidth + 0.5
    // With an ellipsis, it covers the last character box that reaches into its width (one character in a monospace font)
    const limit = truncated ? cb.right - r.width : cb.right
    if (r.width > 0 && r.left >= cb.left - 0.5 && r.right <= limit + 0.5) chars++
    else break
  }
  return { chars, clipWidth: +cb.width.toFixed(1) }
})()`) as Promise<{ chars: number; clipWidth: number }>

/** At least this many characters of the selection are drawn (all of it when it is shorter): enough to tell sessions apart. */
const MIN_SELECTION_CHARS = 10
async function expectSelectionShown(page: Page, selection: string, where: string) {
  const shown = await selectionShown(page, selection)
  const want = Math.min(MIN_SELECTION_CHARS, selection.length)
  console.log(`#selection ${where}: ${shown.chars} of ${selection.length} characters of "${selection}" drawn (${shown.clipWidth} px)`)
  assert.ok(shown.chars >= want, `${where}: ${shown.chars} characters of the selection drawn, expected at least ${want}`)
}

function expectOneLine(l: Layout, where: string) {
  assert.equal(l.rows, 1, `${where}: ${l.rows} rows (${l.controls.map(c => c.name).join(' | ')})`)
  assert.ok(!l.pageScroll, `${where}: the page scrolls sideways`)
  assert.ok(!l.headerScroll, `${where}: the bar scrolls inside itself`)
  assert.deepEqual(l.outside, [], `${where}: controls outside the bar or the window`)
}

for (const locale of ['en', 'fr'] as const) {
  for (const w of WIDTHS) {
    test(`${w} px ${locale}, demo: one row, the controls of its width, height published`, async () => {
      const page = await open(w, locale)
      try {
        const l = await measure(page)
        console.log(`#one-line demo ${locale} ${w}px: bar ${l.barHeight} px, ${l.rows} row(s), --topbar-h ${l.published} px; ${l.controls.map(c => `${c.name} ${c.width}`).join(', ')}`)
        expectOneLine(l, `${w}px ${locale}`)
        expectTier(l, w, `${w}px ${locale}`)
        expectPublished(l, `${w}px ${locale}`)
        await expectSelectionShown(page, locale === 'fr' ? 'Toutes les sessions' : 'All sessions', `demo ${locale} ${w}px`)
        assert.equal(await page.locator('header').getAttribute('lang'), locale)
      } finally {
        await page.context().close()
      }
    })
  }
}

for (const [variant, query] of [['DEMO + Exit demo', '?worst=1'], ['OFFLINE + Retry now', '?worst=1&conn=offline']] as const) {
  for (const locale of ['en', 'fr'] as const) {
    for (const w of WIDTHS) {
      test(`${w} px ${locale}, worst case (${variant}): one row, nothing outside, More signals what it holds`, async () => {
        const page = await worstCase(w, locale, query)
        try {
          const l = await measure(page)
          console.log(`#one-line worst ${variant} ${locale} ${w}px: bar ${l.barHeight} px, ${l.rows} row(s), --topbar-h ${l.published} px; ${l.controls.map(c => `${c.name} ${c.width}`).join(', ')}`)
          expectOneLine(l, `${w}px ${locale} ${variant}`)
          expectTier(l, w, `${w}px ${locale} ${variant}`)
          expectPublished(l, `${w}px ${locale} ${variant}`)
          // The selected session stays written in the bar; its whole name is in the accessible name of Sessions
          await expectSelectionShown(page, 'refactor-authentication-flow-and-tests-x', `worst ${variant} ${locale} ${w}px`)
          const header = page.locator('header')
          // Accessible name computed by Chromium: "Sessions: " (read, not drawn), then the whole name (2.5.3: the drawn text is in it)
          const sessionsName = locale === 'fr' ? /^Sessions : refactor-authentication-flow-and-tests-x/ : /^Sessions: refactor-authentication-flow-and-tests-x/
          assert.equal(await header.getByRole('button', { name: sessionsName }).count(), 1, 'the name of Sessions starts with "Sessions: " and the whole selection')
          assert.equal(await header.locator('[data-testid="attention-counter"]').count(), 1, 'the attention counter is drawn')
          // The connection state is written in the bar at every width, never only a colour
          assert.ok(await header.locator('[data-connection-label]').isVisible(), 'the connection state is drawn')
          const actionInBar = await header.locator(variant.startsWith('DEMO') ? '[data-testid="exit-demo"]' : '[data-testid="retry-connection"]').count()
          assert.equal(actionInBar, w >= 1280 ? 1 : 0, `${variant}: its button ${w >= 1280 ? 'in the bar' : 'behind More'}`)
          // More: one filter active (Hide inactive), and a mark for the scope ceilings and the critical quota it holds
          const more = header.locator('#topbar-more')
          assert.equal(await more.getAttribute('aria-expanded'), 'false')
          assert.equal(await header.locator('[data-more-mark="alert"]').count(), 1, 'More carries the alert mark')
          const described = await more.evaluate((el: Element) => (el.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' '))
          assert.match(described, locale === 'fr' ? /Analyse de cet espace de travail seulement/ : /Scanning this workspace only/, 'the scope summary is read on More')
          assert.match(described, locale === 'fr' ? /Au moins 2/ : /At least 2/, 'the discovery ceilings are read on More')
          assert.match(described, locale === 'fr' ? /8 % restant/ : /8 % left/, 'the quota is read on More')
          // Blocked notifications were drawn in the bar from 1024 px before the one-line bar: More names them (review of PR 631)
          assert.match(described, locale === 'fr' ? /Notifications bloquées/ : /Notifications blocked/, 'blocked notifications are read on More')
          if (variant.startsWith('OFFLINE')) assert.match(described, locale === 'fr' ? /tentative 12/ : /attempt 12/, 'the reconnect detail is read on More')
        } finally {
          await page.context().close()
        }
      })
    }
  }
}

test('1440 px worst case: More opens an overlay (no new row) with the scope, filters, quota and tools; Escape gives the focus back', async () => {
  const page = await worstCase(1440, 'en')
  try {
    const header = page.locator('header')
    const before = await measure(page)
    const more = header.locator('#topbar-more')
    await more.focus()
    await page.keyboard.press('Enter')
    assert.equal(await more.getAttribute('aria-expanded'), 'true')
    const menu = header.locator('[data-topbar-menu]')
    await menu.waitFor({ state: 'visible' })
    assert.equal(await menu.getAttribute('id'), (await more.getAttribute('aria-controls'))?.split(' ')[0], 'More controls the overlay')
    const after = await measure(page)
    assert.equal(after.barHeight, before.barHeight, 'the bar keeps its height: the overlay is drawn over the canvas')
    expectPublished(after, 'More open')
    for (const name of ['Session scope', 'Hide inactive: agents', 'Notifications blocked', 'Mute sound effects', 'Enter full screen', 'Settings', 'Keyboard shortcuts']) {
      assert.equal(await menu.getByRole(name === 'Session scope' ? 'combobox' : 'button', { name, exact: true }).count(), 1, `${name} is in More`)
    }
    assert.equal(await menu.getByRole('meter').count(), 2, 'the two quota gauges are in More')
    assert.ok(await menu.locator('[data-scope-notices]').isVisible(), 'the discovery ceilings are drawn in More')
    const box = await menu.evaluate((el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom } })
    assert.ok(box.left >= 0 && box.right <= 1440 && box.bottom <= 900, `the overlay stays in the window: ${JSON.stringify(box)}`)
    // DOM order: Tab goes from More into the overlay
    await page.keyboard.press('Tab')
    assert.ok(await page.evaluate(`document.querySelector('header [data-topbar-menu]').contains(document.activeElement)`), 'Tab enters the overlay')
    await page.keyboard.press('Escape')
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    assert.ok(await more.evaluate((el: Element) => el === document.activeElement), 'Escape gives the focus back to More')
    await page.keyboard.press('Space')
    assert.equal(await more.getAttribute('aria-expanded'), 'true', 'Space opens it too')
    await page.mouse.click(700, 600)
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'a click outside closes it')
  } finally {
    await page.context().close()
  }
})

test('320 px worst case in French: the More overlay fits in the window and scrolls inside itself', async () => {
  const page = await worstCase(320, 'fr')
  try {
    const header = page.locator('header')
    await header.locator('#topbar-more').click()
    const menu = header.locator('[data-topbar-menu]')
    await menu.waitFor({ state: 'visible' })
    const r = await menu.evaluate((el: Element) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, bottom: b.bottom, scroll: el.scrollHeight > el.clientHeight } })
    console.log(`#one-line 320px fr overlay: ${JSON.stringify(r)}`)
    assert.ok(r.left >= 0 && r.right <= 320 && r.bottom <= 800, JSON.stringify(r))
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no sideways page scroll with the overlay open')
    // The 44 px targets hold in the overlay too
    const small = await menu.locator('button, select').evaluateAll(els => els.filter(e => { const b = e.getBoundingClientRect(); return b.width > 1 && (b.width < 44 || b.height < 44) }).map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()))
    assert.deepEqual(small, [])
  } finally {
    await page.context().close()
  }
})

test('the Tab order is the DOM order: Sessions, attention, panels, Commands, then More', async () => {
  for (const w of [1440, 1100]) {
    const page = await open(w)
    try {
      await page.locator('header').getByRole('button', { name: /^Sessions/ }).focus()
      const names: string[] = []
      for (let i = 0; i < 30; i++) {
        const name = await page.evaluate(`(() => { const el = document.activeElement; return el && document.querySelector('header').contains(el) ? (el.getAttribute('aria-label') || el.textContent.trim()) : null })()`) as string | null
        if (name === null) break
        names.push(name)
        await page.keyboard.press('Tab')
      }
      console.log(`#one-line ${w}px tab order: ${names.join(' | ')}`)
      const at = (n: string) => names.indexOf(n)
      for (let i = 1; i < PANELS.length; i++) assert.ok(at(PANELS[i - 1]) < at(PANELS[i]), `${w}px: ${PANELS[i - 1]} before ${PANELS[i]}`)
      assert.match(names[0], /^Sessions/)
      assert.match(names.at(-1)!, /^More/, `${w}px: More is the last stop of the closed bar`)
      if (w >= 1280) assert.ok(at('Commands') > at('Stats'), 'Commands after the panels')
    } finally {
      await page.context().close()
    }
  }
})

test('a resize that moves the focused control behind More opens More and keeps the focus on it (2.4.3)', async () => {
  const page = await open(1100)
  try {
    const header = page.locator('header')
    await header.locator('#topbar-toggle-files').focus()
    await page.setViewportSize({ width: 900, height: 900 })
    await page.waitForFunction(`document.activeElement && document.activeElement.id === 'topbar-toggle-files'`, undefined, { timeout: 5000 })
    assert.equal(await header.locator('#topbar-more').getAttribute('aria-expanded'), 'true', 'More opened to keep the button')
    assert.ok(await page.evaluate(`document.querySelector('header [data-topbar-menu]').contains(document.activeElement)`), 'the button is the one in More')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.waitForFunction(`document.activeElement && document.activeElement.id === 'topbar-toggle-files' && !document.querySelector('header [data-topbar-menu]')?.contains(document.activeElement)`, undefined, { timeout: 5000 })
    await header.locator('#topbar-commands').focus()
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.waitForFunction(`document.activeElement && document.activeElement.id === 'topbar-commands'`, undefined, { timeout: 5000 })
    await page.setViewportSize({ width: 600, height: 800 })
    await page.waitForFunction(`document.activeElement && document.activeElement.id === 'topbar-commands'`, undefined, { timeout: 5000 })
  } finally {
    await page.context().close()
  }
})

test('768 px: a panel opened from More closes More; the docked panel takes the focus and gives it back to More', async () => {
  const page = await open(768)
  try {
    const header = page.locator('header')
    const more = header.locator('#topbar-more')
    await more.click()
    await header.getByRole('button', { name: 'Files & repeats', exact: true }).click()
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('[data-mobile-drawer]').count(), 0, 'no drawer from 768 px')
    await page.waitForFunction(`document.activeElement && document.activeElement !== document.body && !document.querySelector('header').contains(document.activeElement)`)
    await page.keyboard.press('Escape')
    await page.waitForFunction(`document.activeElement && document.activeElement.id === 'topbar-more'`, undefined, { timeout: 5000 })
  } finally {
    await page.context().close()
  }
})

test('1440x900: the bar draws no summary text; the agent counts are drawn in the Sessions panel header', async () => {
  const page = await open(1440)
  try {
    const header = page.locator('header')
    // What is drawn: the text without the visually hidden parts (the totals stay for screen readers, sr-only)
    const drawn = await header.evaluate((el: Element) => { const c = el.cloneNode(true) as Element; for (const n of Array.from(c.querySelectorAll('.sr-only, [hidden], [role="tooltip"]'))) n.remove(); return c.textContent ?? '' })
    assert.doesNotMatch(drawn, /agents?:|\blast known\b|\bdone\b|tokens|\$\d/, `no summary text drawn in the bar: "${drawn}"`)
    await header.getByRole('button', { name: /^Sessions/ }).click()
    const counts = page.locator('#sessions-panel').getByTestId('sessions-agent-counts')
    await counts.waitFor({ state: 'visible' })
    const shown = await counts.evaluate((el: Element) => { const c = el.cloneNode(true) as Element; for (const n of Array.from(c.querySelectorAll('.sr-only, [hidden], [role="tooltip"]'))) n.remove(); return c.textContent ?? '' })
    console.log(`#523 Sessions panel header counts: "${shown}"`)
    assert.match(shown, /^\d+ agents?: \d+ active( · \d+ (last known|idle|error))* · \d+ done$|^\d+ sessions? · \d+ agents?$/, shown)
  } finally {
    await page.context().close()
  }
})

test('1100x900: an icon shows its tooltip on hover and on focus; Escape closes it and the focus stays', async () => {
  const page = await open(1100)
  try {
    const files = page.locator('header').getByRole('button', { name: 'Files & repeats', exact: true })
    // "Files & repeats (F)" adds the shortcut to the name, so it is linked by aria-describedby; only Conversation, whose tooltip is exactly its name, is not (#545 review)
    const tipId = await page.locator('#topbar-toggle-files').evaluate((b: Element) => b.parentElement!.querySelector('[role="tooltip"]')!.id)
    assert.ok(tipId)
    assert.ok(((await files.getAttribute('aria-describedby')) ?? '').split(' ').includes(tipId), 'Files is linked to its tooltip')
    assert.equal(await page.locator('header').getByRole('button', { name: /^Conversation/ }).first().getAttribute('aria-describedby'), null, 'Conversation: its tooltip is exactly its name')
    const tip = page.locator(`[id="${tipId}"]`)
    assert.equal(await tip.getAttribute('role'), 'tooltip')
    assert.ok(!(await tip.isVisible()), 'closed at rest')
    await files.hover()
    await tip.waitFor({ state: 'visible' })
    const r = await page.evaluate(`(() => {
      const t = document.getElementById(${JSON.stringify(tipId)}).getBoundingClientRect()
      const b = document.getElementById('topbar-toggle-files').getBoundingClientRect()
      return { tipTop: t.top, buttonBottom: b.bottom, left: t.left, right: t.right, width: window.innerWidth }
    })()`) as { tipTop: number; buttonBottom: number; left: number; right: number; width: number }
    assert.ok(r.tipTop >= r.buttonBottom, 'below the button: it does not cover it')
    assert.ok(r.left >= 0 && r.right <= r.width, 'inside the window')
    await tip.hover()
    assert.ok(await tip.isVisible(), 'hoverable')
    await page.mouse.move(5, 600)
    await tip.waitFor({ state: 'hidden' })
    await files.focus()
    await tip.waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await tip.waitFor({ state: 'hidden' })
    assert.ok(await files.evaluate((el: Element) => el === document.activeElement), 'the focus stayed')
  } finally {
    await page.context().close()
  }
})

// An active button draws ONE stroke (owner request, 2026-10-21: "le trait de soulignement est doublé"): the 2 px bar under it,
// never a text underline next to it. Measured on the pixels of a 2x capture of the button: the rows (in the middle half of
// its width, where the label sits) that are a stroke of the active colour, grouped in runs. Before the fix there were two
// runs under Files and Conversation from 1280 px (underline, then the bar) and one underline per line on Sessions.
async function strokeRuns(page: Page, name: string | RegExp): Promise<{ runs: number[]; textDecoration: string[]; boxShadow: string; fontWeight: string; pressed: string | null }> {
  const button = page.locator('header').getByRole('button', { name }).first()
  await button.click()
  await page.mouse.move(5, 600)
  await page.waitForTimeout(250)
  const png = (await button.screenshot()).toString('base64')
  const info = await button.evaluate((el: HTMLElement) => {
    const cs = getComputedStyle(el)
    return {
      color: cs.color, boxShadow: cs.boxShadow, fontWeight: cs.fontWeight, pressed: el.getAttribute('aria-pressed'),
      textDecoration: [el, ...el.querySelectorAll('*')].map(e => getComputedStyle(e).textDecorationLine),
    }
  })
  // The pixel scan is page code passed as a string: tsx's keepNames helper (__name) does not exist in the page
  const runs = await page.evaluate(`(async () => {
    const color = ${JSON.stringify(info.color)}
    const img = await createImageBitmap(await (await fetch('data:image/png;base64,${png}')).blob())
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d'); g.drawImage(img, 0, 0)
    const [r0, g0, b0] = (color.match(/[0-9.]+/g) || []).map(Number)
    const x0 = Math.floor(img.width * 0.25), x1 = Math.ceil(img.width * 0.75)
    const row = y => {
      const d = g.getImageData(x0, y, x1 - x0, 1).data
      let hit = 0
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) < 60) hit++
      return hit / (x1 - x0) >= 0.9
    }
    const out = []; let len = 0
    for (let y = 0; y < img.height; y++) { if (row(y)) len++; else if (len) { out.push(len); len = 0 } }
    if (len) out.push(len)
    return out.map(n => n / 2)
  })()`) as number[]
  return { runs, textDecoration: info.textDecoration, boxShadow: info.boxShadow, fontWeight: info.fontWeight, pressed: info.pressed }
}

for (const [w, locale] of [[1440, 'en'], [1280, 'en'], [1280, 'fr'], [1024, 'en']] as const) {
  test(`${w}x900 ${locale}: an active button of the bar draws one stroke, not two`, async () => {
    const context = await browser.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 })
    await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
    const page = await context.newPage()
    try {
      await page.goto(server.url, { waitUntil: 'networkidle' })
      await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
      await waitForStableLayout(page)
      const files = await strokeRuns(page, locale === 'fr' ? 'Fichiers et répétitions' : 'Files & repeats')
      const sessions = await strokeRuns(page, /^Sessions/)
      for (const [what, m] of [['Files', files], ['Sessions', sessions]] as const) {
        console.log(`#active-stroke ${w}px ${locale} ${what}: strokes ${JSON.stringify(m.runs)} px, shadow ${m.boxShadow}`)
        assert.equal(m.pressed, 'true', `${what}: aria-pressed`)
        assert.ok(Number(m.fontWeight) >= 700, `${what}: still bold`)
        assert.ok(m.textDecoration.every(d => d === 'none'), `${what}: no text underline (${m.textDecoration.join(',')})`)
        assert.equal(m.runs.length, 1, `${what}: ${m.runs.length} strokes (${m.runs.join(', ')} px), expected the bar alone`)
        assert.equal(m.runs[0], 2, `${what}: the stroke is 2 px thick`)
      }
    } finally {
      await context.close()
    }
  })
}
