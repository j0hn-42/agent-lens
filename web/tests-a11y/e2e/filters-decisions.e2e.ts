// #372, the owner's decisions, measured in a real browser against the demo app (`pnpm --dir web run test:e2e`):
// (1) the line under the Sessions panel header that says both visibility filters wraps at 320 px and at 640 x 512
//     (1280 x 1024 at 200 %) in English and in French: nothing cut, nothing outside the panel, no sideways scroll
//     (WCAG 1.4.10). Its cost in height is measured against the same panel with the line removed;
// (2) Settings > General: the "Motion and cards" row keeps every tab inside the window (the heights are logged, the
//     tallest panel stays the one docs/reading-the-ui.md quotes), and "Open View controls" closes Settings, opens the
//     View popover (unfolded, or the folded "Canvas controls" block) with the focus on Freeze motion; Escape gives it
//     back to View.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
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

async function open(w: number, h: number, locale: 'en' | 'fr', reducedMotion: 'reduce' | 'no-preference' = 'reduce'): Promise<Page> {
  // Reduced motion locks Freeze motion on (disabled): the focus test opens without it
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion })
  await context.addInitScript(l => { try { window.localStorage.setItem('agent-lens:locale', l) } catch { /* blocked */ } }, locale)
  const page = await context.newPage()
  await page.goto(server.url, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor({ timeout: 120_000 })
  await waitForStableLayout(page)
  return page
}

// A string so the TS transpiler injects no helper into the page.
const LINE_PROBE = `(() => {
  const panel = document.getElementById('sessions-panel')
  const line = panel && panel.querySelector('[data-testid="sessions-filter-scope"]')
  if (!line) return null
  const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height } }
  const search = panel.querySelector('[role="search"]')
  const withLine = box(search).t
  const lineBox = box(line)
  const spans = [...line.children].filter(c => c.getAttribute('aria-hidden') !== 'true').map(c => ({ text: c.textContent, ...box(c) }))
  line.style.display = 'none'
  const withoutLine = box(search).t
  line.style.display = ''
  const card = box(panel.querySelector('.glass-card'))
  return {
    text: line.textContent, lang: line.closest('[lang]') ? line.closest('[lang]').getAttribute('lang') : null,
    line: lineBox, spans, card, cost: withLine - withoutLine,
    scroll: line.scrollWidth, client: line.clientWidth,
    docScroll: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
  }
})()`
interface Box { l: number; r: number; t: number; b: number; h: number }
interface LineProbe {
  text: string; lang: string | null; line: Box; spans: Array<Box & { text: string }>; card: Box; cost: number
  scroll: number; client: number; docScroll: number; vw: number
}

const EXPECTED = {
  en: 'List: Active only · Canvas: Hide inactive (10 min)',
  fr: 'Liste : Actives seulement · Canevas : Masquer les inactifs (10 min)',
} as const
const ONE_SESSION = {
  en: 'List: Active only · Canvas: Hide inactive',
  fr: 'Liste : Actives seulement · Canevas : Masquer les inactifs',
} as const
const ALL_LABEL = { en: 'All sessions', fr: 'Toutes les sessions' } as const

for (const locale of ['en', 'fr'] as const) {
  for (const [w, h] of [[320, 568], [640, 512], [1440, 900]] as const) {
    test(`(1) ${locale} ${w}x${h}: the line of the two filters wraps inside the Sessions panel, nothing cut (1.4.10)`, { timeout: 180_000 }, async () => {
      const page = await open(w, h, locale)
      try {
        await page.locator('header').getByRole('button', { name: /^Sessions/ }).click()
        const line = page.locator('#sessions-panel [data-testid="sessions-filter-scope"]')
        await line.waitFor()
        // The demo opens on one session (no time window on the canvas half); All sessions is the longest line
        assert.equal(await line.textContent(), ONE_SESSION[locale], 'one session: the canvas filter has no window')
        await page.locator('#sessions-panel [data-row-key^="session:"]').filter({ hasText: ALL_LABEL[locale] }).first().click()
        await line.filter({ hasText: '10 min' }).waitFor()
        await waitForStableLayout(page)
        const m = await page.evaluate(LINE_PROBE) as LineProbe | null
        assert.ok(m, 'the line is drawn')
        console.log(`# (1) ${locale} ${w}x${h}: line ${m.line.h} px high, the panel ${m.cost} px taller than without it, card ${Math.round(m.card.l)}..${Math.round(m.card.r)}`)
        assert.equal(m.text, EXPECTED[locale])
        assert.equal(m.lang, locale, 'the line is inside the block that declares the language')
        assert.ok(m.scroll <= m.client + 1, `the line is not cut (scroll ${m.scroll} > client ${m.client})`)
        for (const s of m.spans) assert.ok(s.l >= m.card.l - 0.5 && s.r <= m.card.r + 0.5, `"${s.text}" stays inside the panel`)
        assert.ok(m.line.l >= -0.5 && m.line.r <= m.vw + 0.5, 'the line stays inside the window')
        assert.ok(m.docScroll <= m.vw, `no sideways scroll (${m.docScroll} > ${m.vw})`)
      } finally {
        await page.context().close()
      }
    })
  }
}

const TAB_HEIGHTS = `(() => {
  const dialog = document.querySelector('[role="dialog"]')
  const shown = document.querySelector('[role="tabpanel"]:not([hidden])')
  return { panel: Math.round(shown.getBoundingClientRect().height), scroll: dialog.scrollHeight, client: dialog.clientHeight }
})()`

for (const locale of ['en', 'fr'] as const) {
  test(`(2) ${locale}: the heights of the Settings tabs with the "Motion and cards" row, and without it`, { timeout: 180_000 }, async () => {
    const page = await open(1440, 900, locale)
    try {
      await page.locator('body').press(',')
      await page.getByRole('tablist').waitFor()
      const heights: Record<string, { panel: number; scroll: number; client: number }> = {}
      const count = await page.getByRole('tab').count()
      for (let i = 0; i < count; i++) {
        const tab = page.getByRole('tab').nth(i)
        await tab.click()
        heights[(await tab.textContent()) ?? String(i)] = await page.evaluate(TAB_HEIGHTS) as { panel: number; scroll: number; client: number }
      }
      await page.getByRole('tab').first().click()
      const general = page.getByRole('tabpanel').first()
      const viewSection = general.locator('section[aria-label]').last()
      const withRow = heights[(await page.getByRole('tab').first().textContent()) ?? '0']
      await viewSection.evaluate(el => { (el as HTMLElement).style.display = 'none' })
      const withoutRow = await page.evaluate(TAB_HEIGHTS) as { panel: number }
      console.log(`# (2) ${locale} 1440x900 tab panels: ${JSON.stringify(heights)}; General without the row: ${withoutRow.panel} px`)
      const tallest = Math.max(...Object.values(heights).map(x => x.panel))
      const others = Math.max(...Object.entries(heights).filter(([, v]) => v !== withRow).map(([, v]) => v.panel))
      assert.ok(withRow.panel <= others, `General (${withRow.panel} px) stays under the tallest other tab (${others} px)`)
      assert.equal(tallest, others, 'the tallest panel is unchanged')
    } finally {
      await page.context().close()
    }
  })
}

const focusedName = (page: Page) => page.evaluate(`(() => { const el = document.activeElement; return el ? (el.getAttribute('aria-label') || el.textContent || '').trim() : '' })()`)

for (const [w, h, folded] of [[1440, 900, false], [320, 256, true]] as const) {
  test(`(2) en ${w}x${h}${folded ? ', folded' : ''}: "Open View controls" closes Settings, opens View with the focus on Freeze motion, Escape returns to View`, { timeout: 180_000 }, async () => {
    const page = await open(w, h, 'en', 'no-preference')
    try {
      if (folded) assert.equal(await page.getByRole('button', { name: 'Canvas controls' }).count(), 1, 'the controls are folded at this size')
      await page.locator('body').press(',')
      await page.getByRole('tablist').waitFor()
      await page.getByRole('button', { name: 'Open View controls' }).click()
      await page.getByRole('dialog', { name: 'View settings' }).waitFor()
      assert.equal(await page.getByRole('dialog', { name: 'Settings', exact: true }).count(), 0, 'Settings is closed')
      assert.equal(await focusedName(page), 'Freeze motion', 'the focus is on the first control of the popover')
      // Freeze motion (2.2.2) is the first control of the popover: one press of Space from here
      assert.equal(await page.getByRole('button', { name: 'Freeze motion' }).getAttribute('aria-pressed'), 'false')
      if (folded) assert.equal(await page.getByRole('button', { name: 'Canvas controls' }).getAttribute('aria-expanded'), 'true', 'the folded block opened first')
      await page.keyboard.press('Escape')
      assert.equal(await page.getByRole('dialog', { name: 'View settings' }).count(), 0, 'Escape closes the popover')
      assert.equal(await focusedName(page), 'View', 'the focus is back on View (2.4.3)')
    } finally {
      await page.context().close()
    }
  })
}
