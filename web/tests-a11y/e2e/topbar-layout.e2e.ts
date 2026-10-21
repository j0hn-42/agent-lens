// #523: layout of the top bar measured in a real browser against the demo app (`pnpm --dir web run test:e2e`).
// From 1024 px up the bar is TWO ordered rows: row 1 = Sessions, scope, connection state, attention and the filters;
// row 2 = the quota gauges, the panel buttons and the tools. The bar draws no summary text any more (#523, user request:
// no tokens, no cost, no agent counts; the counts are drawn in the Sessions panel header), so a single row was measured
// first: it does not fit at 1440 px (see the pull request). The assignment is fixed and there is one DOM order, so the Tab order is the
// same at 1440, 1280, 1100 and 1024 px. The seven panel buttons are icons under 1280 px (labels from 1280 px), at
// least 24 x 24 px, and keep their accessible name. Under 1024 px the bar folds behind More into one row (Commands
// stays in it from 768 px); the 44 px targets and drawers stay under 768 px. --topbar-h follows the bar in each case.
// The widths and heights are logged ("#523 ...") for the pull request.
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

async function open(w: number, h = 900, locale?: 'fr' | 'en'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h } })
  if (locale) await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await waitForStableLayout(page)
  return page
}

const PANELS = ['Files & repeats', 'Conversation (C)', 'Context (P)', 'System (Y)', 'Cost', 'Timeline', 'Stats']

interface Box { top: number; bottom: number; left: number; right: number; width: number; height: number }
interface Layout {
  barHeight: number
  published: number
  rows: number
  groups: Record<string, Box | null>
  panels: Array<{ name: string; width: number; height: number; labelWidth: number; iconWidth: number }>
  row2: { width: number; content: number } | null
}

/** Visible controls of the bar grouped in rows (vertical centres more than 12 px apart), groups and panel buttons. */
const measure = (page: Page) => page.evaluate(`(() => {
  const header = document.querySelector('header')
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height } }
  const visible = [...header.querySelectorAll('button, select')].filter(el => {
    const r = el.getBoundingClientRect()
    return r.width > 1 && r.height > 1 && !el.closest('.sr-only')
  })
  const centres = visible.map(el => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 }).sort((a, b) => a - b)
  let rows = 0, last = -Infinity
  for (const c of centres) { if (c - last > 12) rows++; last = c }
  const groups = {}
  for (const g of header.querySelectorAll('[data-topbar-group]')) groups[g.getAttribute('data-topbar-group')] = getComputedStyle(g).position === 'absolute' ? null : box(g)
  const names = ${JSON.stringify(PANELS)}
  const panels = [...header.querySelectorAll('button')].filter(b => names.includes(b.getAttribute('aria-label'))).map(b => {
    const r = b.getBoundingClientRect()
    const label = b.querySelector('[data-panel-label]').getBoundingClientRect()
    const icon = b.querySelector('svg').getBoundingClientRect()
    return { name: b.getAttribute('aria-label'), width: r.width, height: r.height, labelWidth: label.width, iconWidth: icon.width }
  })
  const row2El = header.querySelector('[data-topbar-row="2"]')
  let row2 = null
  if (row2El && getComputedStyle(row2El).display !== 'contents') {
    const kids = [...row2El.children].filter(k => k.getBoundingClientRect().width > 0 && !k.matches('[data-topbar-spacer]'))
    const gap = parseFloat(getComputedStyle(row2El).columnGap) || 0
    row2 = { width: row2El.getBoundingClientRect().width, content: kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1) }
  }
  return {
    barHeight: header.getBoundingClientRect().height,
    published: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')),
    rows, groups, panels, row2,
  }
})()`) as Promise<Layout>

/** Tab from the Sessions button through the bar: the accessible names in order. */
async function tabOrder(page: Page): Promise<string[]> {
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).focus()
  const names: string[] = []
  for (let i = 0; i < 40; i++) {
    const name = await page.evaluate(`(() => {
      const el = document.activeElement
      if (!el || !document.querySelector('header').contains(el)) return null
      return el.getAttribute('aria-label') || el.textContent.trim()
    })()`) as string | null
    if (name === null) break
    names.push(name)
    await page.keyboard.press('Tab')
  }
  return names
}

/** --topbar-h is the bar height + 20 px (topbarOffsetPx), rounded up. */
const expectPublished = (l: Layout, where: string) =>
  assert.equal(l.published, Math.ceil(l.barHeight) + 20, `${where}: --topbar-h ${l.published} px for a ${l.barHeight} px bar`)

const orders = new Map<number, string[]>()

for (const w of [1440, 1280, 1100, 1024]) {
  test(`${w}x900: two rows (identity and filters, then quota, panels and tools), height published`, async () => {
    const page = await open(w)
    try {
      const l = await measure(page)
      console.log(`#523 ${w}px: bar ${l.barHeight} px, ${l.rows} rows, --topbar-h ${l.published} px; row 2 ${l.row2?.content.toFixed(2)} of ${l.row2?.width.toFixed(2)} px (margin ${l.row2 ? (l.row2.width - l.row2.content).toFixed(2) : '-'}); panels ${l.panels.map(p => `${p.name} ${p.width.toFixed(2)}x${p.height.toFixed(2)}`).join(', ')}`)
      assert.equal(l.rows, 2, `${w}px: ${l.rows} rows`)
      const { identity, filters, status, panels, tools } = l.groups
      for (const [n, g] of Object.entries({ identity, filters, status, panels, tools })) assert.ok(g, `${n} group drawn`)
      const mid = (b: Box) => b.top + b.height / 2
      assert.ok(Math.abs(mid(identity!) - mid(filters!)) < 12, 'identity and filters share row 1')
      for (const g of [status!, panels!, tools!]) assert.ok(g.top >= identity!.bottom && g.top >= filters!.bottom, 'row 2 is below row 1')
      assert.ok(Math.abs(mid(status!) - mid(panels!)) < 12 && Math.abs(mid(panels!) - mid(tools!)) < 12, 'status, panels and tools share row 2')
      expectPublished(l, `${w}px`)
      assert.equal(l.panels.length, 7, 'seven panel buttons')
      for (const p of l.panels) {
        assert.ok(p.width >= 24 && p.height >= 24, `${p.name} is ${p.width}x${p.height} px (24 x 24 minimum)`)
        if (w >= 1280) assert.ok(p.labelWidth > 1 && p.iconWidth === 0, `${w}px: ${p.name} shows its label`)
        else assert.ok(p.labelWidth <= 1 && p.iconWidth > 0, `${w}px: ${p.name} shows its icon`)
      }
      assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll')
      const order = await tabOrder(page)
      orders.set(w, order)
      console.log(`#523 ${w}px tab order: ${order.join(' | ')}`)
      const at = (name: string) => order.indexOf(name)
      const show = order.findIndex(n => n.startsWith('Hide inactive'))
      assert.ok(show > 0 && show < at(PANELS[0]), 'the filters (row 1, #372: Hide inactive) come before the panels (row 2)')
      for (let i = 1; i < PANELS.length; i++) assert.ok(at(PANELS[i - 1]) < at(PANELS[i]), `${PANELS[i - 1]} before ${PANELS[i]}`)
      assert.ok(at('Keyboard shortcuts') > at('Stats'), 'tools after panels')
    } finally {
      await page.context().close()
    }
  })
}

test('the Tab order is the same at 1440, 1280, 1100 and 1024 px', () => {
  const first = orders.get(1440)
  assert.ok(first && first.length > 10, 'measured at 1440 px')
  for (const w of [1280, 1100, 1024]) assert.deepEqual(orders.get(w), first, `${w} px`)
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

test('768x900: one folded row (Sessions, state, More, Commands), More opens every control, height published each time', async () => {
  const page = await open(768)
  try {
    const header = page.locator('header')
    const more = header.getByRole('button', { name: /^More/ })
    assert.equal(await more.count(), 1, 'More is drawn at 768 px')
    assert.equal(await header.getByRole('button', { name: 'Commands' }).count(), 1, 'Commands stays in the folded bar')
    const folded = await measure(page)
    console.log(`#523 768px folded: bar ${folded.barHeight} px, ${folded.rows} rows, --topbar-h ${folded.published} px`)
    assert.equal(folded.rows, 1, `${folded.rows} rows`)
    expectPublished(folded, '768px folded')
    const order = await tabOrder(page)
    console.log(`#523 768px tab order: ${order.join(' | ')}`)
    assert.ok(order.findIndex(n => n.startsWith('More')) < order.indexOf('Commands'), 'More then Commands')
    // The 44 px targets stay under 768 px
    const sizes = await header.locator('button').evaluateAll(els => els.map(e => e.getBoundingClientRect().height))
    assert.ok(sizes.every(h => h < 44), `no 44 px target at 768 px: ${sizes.join(', ')}`)
    await more.click()
    await page.waitForFunction(`document.querySelector('header [data-topbar-group="panels"]') !== null`)
    await waitForStableLayout(page)
    const expanded = await measure(page)
    console.log(`#523 768px More open: bar ${expanded.barHeight} px, ${expanded.rows} rows, --topbar-h ${expanded.published} px; panels ${expanded.panels.map(p => `${p.name} ${p.width.toFixed(2)}x${p.height.toFixed(2)}`).join(', ')}`)
    expectPublished(expanded, '768px More open')
    assert.ok(expanded.barHeight > folded.barHeight)
    assert.equal(expanded.panels.length, 7)
    for (const p of expanded.panels) assert.ok(p.iconWidth > 0 && p.labelWidth <= 1 && p.width >= 24 && p.height >= 24, `${p.name} is an icon of at least 24 px`)
    // A panel opened from More folds More (the panel stays docked: no drawer between 768 and 1023 px). As at every width
    // the open panel takes the focus; closing it gives the focus back to More, which stands for the folded button
    await header.getByRole('button', { name: 'Files & repeats', exact: true }).click()
    assert.equal(await more.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('[data-mobile-drawer]').count(), 0, 'no drawer')
    await page.waitForFunction(`document.activeElement && document.activeElement !== document.body && !document.querySelector('header').contains(document.activeElement)`)
    await page.keyboard.press('Escape')
    await page.waitForFunction(`document.activeElement && document.activeElement.id === 'topbar-more'`, undefined, { timeout: 5000 })
  } finally {
    await page.context().close()
  }
})

test('1000x900: still folded under 1024 px, one row', async () => {
  const page = await open(1000)
  try {
    const l = await measure(page)
    console.log(`#523 1000px folded: bar ${l.barHeight} px, ${l.rows} rows, --topbar-h ${l.published} px`)
    assert.equal(await page.locator('header').getByRole('button', { name: /^More/ }).count(), 1)
    assert.equal(l.rows, 1)
    expectPublished(l, '1000px')
  } finally {
    await page.context().close()
  }
})

// #500: the French labels are longer than the English ones (Sessions : Toutes les sessions, Masquer les inactifs,
// 2 agents en attente / 1 agent en erreur). The bar keeps its two rows at 1440, 1280, 1100 and 1024 px, never taller than in
// English; the heights are logged ("#500 ...") for the pull request.
for (const w of [1440, 1280, 1100, 1024]) {
  test(`${w}x900 in French: still two rows, no taller than in English, height published`, async () => {
    const heights: Record<string, number> = {}
    for (const locale of ['en', 'fr'] as const) {
      const page = await open(w, 900, locale)
      try {
        const l = await measure(page)
        heights[locale] = l.barHeight
        // Room left in row 1 (identity and filters side by side): what the longer French texts can still take
        const row1 = await page.evaluate(`(() => {
          const row = document.querySelector('header [data-topbar-row="1"]')
          const kids = [...row.children].filter(k => k.getBoundingClientRect().width > 0 && !k.matches('[data-topbar-spacer]'))
          const gap = parseFloat(getComputedStyle(row).columnGap) || 0
          return { width: row.getBoundingClientRect().width, content: kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1) }
        })()`) as { width: number; content: number }
        console.log(`#500 ${w}px ${locale}: bar ${l.barHeight} px, ${l.rows} rows, --topbar-h ${l.published} px; row 1 ${row1.content.toFixed(2)} of ${row1.width.toFixed(2)} px (margin ${(row1.width - row1.content).toFixed(2)})`)
        assert.equal(l.rows, 2, `${w}px ${locale}: ${l.rows} rows`)
        expectPublished(l, `${w}px ${locale}`)
        assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll')
        assert.equal(await page.locator('header').getAttribute('lang'), locale)
      } finally {
        await page.context().close()
      }
    }
    assert.ok(heights.fr <= heights.en, `${w}px: ${heights.fr} px in French, ${heights.en} px in English`)
  })
}

// #500, worst case of row 1 (the demo draws no attention counter and no scope selector; #372: the Hide inactive toggle replaced
// the finished-sessions toggle and Hide inactive agents): the real TopBar is drawn alone (topbar-worstcase.ts) with them at once. At 1024 px the row is measured in French and in English
// (logged); at 320 px in French the page must not scroll sideways and no control may be cropped.
async function worstCase(w: number, locale: 'fr' | 'en', query = ''): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: 900 } })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await openWorstCase(context, server.url, query)
  await waitForStableLayout(page)
  return page
}

for (const [name, query] of [['with the three discovery ceilings', ''], ['without a ceiling', '?ceilings=0']] as const) {
  test(`1024x900 row 1 with attention, scope and Hide inactive, ${name}: measured in French and English`, async () => {
    const rows: Record<string, { content: number; width: number; rows: number; bar: number }> = {}
    for (const locale of ['en', 'fr'] as const) {
      const page = await worstCase(1024, locale, query)
      try {
        const l = await measure(page)
        const row1 = await page.evaluate(`(() => {
          const row = document.querySelector('header [data-topbar-row="1"]')
          const kids = [...row.children].filter(k => k.getBoundingClientRect().width > 0 && !k.matches('[data-topbar-spacer]'))
          const gap = parseFloat(getComputedStyle(row).columnGap) || 0
          return { width: row.getBoundingClientRect().width, content: kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1) }
        })()`) as { width: number; content: number }
        rows[locale] = { ...row1, rows: l.rows, bar: l.barHeight }
        assert.equal(await page.locator('header [data-testid="attention-counter"]').count(), 1, 'the attention counter is drawn')
        assert.equal(await page.locator('header [data-scope-selector]').count(), 1, 'the scope selector is drawn')
        assert.equal(await page.locator('header').getByRole('button', { name: locale === 'fr' ? /^Masquer les inactifs/ : /^Hide inactive/ }).count(), 1, 'the Hide inactive toggle is drawn (#372)')
        console.log(`#500 1024px ${name} ${locale}: bar ${l.barHeight} px, ${l.rows} rows; row 1 children ${row1.content.toFixed(2)} of ${row1.width.toFixed(2)} px (margin ${(row1.width - row1.content).toFixed(2)})`)
        assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `${locale}: no horizontal page scroll`)
      } finally {
        await page.context().close()
      }
    }
    // The row wraps rather than overflows; French may not make the bar taller than English does
    assert.ok(rows.fr.bar <= rows.en.bar && rows.fr.rows <= rows.en.rows, `French ${rows.fr.rows} rows / ${rows.fr.bar} px, English ${rows.en.rows} rows / ${rows.en.bar} px`)
  })
}

test('320x568 worst case in French: no sideways scroll, nothing cropped', async () => {
  const page = await worstCase(320, 'fr')
  try {
    assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no horizontal page scroll')
    // Every drawn control lies inside the window and the bar: scrollWidth alone misses a box cut by a clipped ancestor
    const out = await page.evaluate(`(() => {
      const w = window.innerWidth
      const header = document.querySelector('header')
      const hb = header.getBoundingClientRect()
      const bad = []
      for (const el of header.querySelectorAll('button, select, [data-testid="attention-counter"], [data-testid="connection-detail"]')) {
        const r = el.getBoundingClientRect()
        if (r.width <= 1 || r.height <= 1 || el.closest('.sr-only')) continue
        const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 40)
        if (r.left < -0.5 || r.right > w + 0.5 || r.right > hb.right + 0.5 || r.left < hb.left - 0.5) bad.push(name + ' ' + r.left.toFixed(1) + '..' + r.right.toFixed(1))
        else if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') bad.push('text cut in ' + name)
      }
      // Text cut with an ellipsis: the full text stays in the DOM for screen readers, but a sighted person loses it
      const ellipsis = [...header.querySelectorAll('*')].filter(e => getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 1).map(e => (e.textContent || '').trim())
      return { bad, ellipsis, header: header.scrollWidth <= header.clientWidth + 1, bar: hb.height, controls: [...header.querySelectorAll('button, select')].filter(e => e.getBoundingClientRect().width > 1).length }
    })()`) as { bad: string[]; ellipsis: string[]; header: boolean; bar: number; controls: number }
    console.log(`#500 320px worst case fr: bar ${out.bar} px, ${out.controls} controls drawn, outside the window or clipped: ${out.bad.length}; cut with an ellipsis: ${JSON.stringify(out.ellipsis)}`)
    assert.deepEqual(out.bad, [])
    assert.ok(out.header, 'the bar does not scroll inside itself')
    // No text of the bar is cut with an ellipsis, the Sessions label included (#595)
    assert.deepEqual(out.ellipsis, [])
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
