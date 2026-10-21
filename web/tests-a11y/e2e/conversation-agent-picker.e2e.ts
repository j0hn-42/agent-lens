// Agent picker of the Conversation panel, measured in a real browser against the demo of 83 agents (?scenario=workflow83, owner's
// request: "the list of agents is not visible at all, a sideways scroll"). Before, the row of tabs was 12 508 px wide in a 240 px
// strip (1 tab of 84 visible at 1280 px). At 320, 390 and 1280 px, in French and in English: the agent area never scrolls sideways,
// the button and its list stay inside the panel, every agent is reachable by a vertical scroll only, the agent chosen outside the
// picker (a message row, as on the canvas) is shown by the button and its option is in view on opening, and under 768 px the button,
// the options and the Filter pair button are 44 px high (#476).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'
import { waitForStableLayout } from './stable-layout'

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

const AGENTS = 83
const TEXT = {
  fr: { button: /^Agent : /, all: `Tous (${AGENTS})`, search: 'Rechercher un agent', showDone: /^Terminés \(/, pair: 'Filtrer une paire' },
  en: { button: /^Agent: /, all: `All (${AGENTS})`, search: 'Search agents', showDone: /^Finished \(/, pair: 'Filter pair' },
} as const
const TEAMS = { fr: /^Équipes/, en: /^Teams/ } as const

async function open(w: number, h: number, locale: 'fr' | 'en'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' })
  await context.addInitScript((l) => {
    try { window.localStorage.setItem('agent-lens:locale', l); window.localStorage.setItem('agent-lens:tour-offered', '1') } catch { /* blocked */ }
  }, locale)
  const page = await context.newPage()
  await page.goto(`${server.url}/?scenario=workflow83`, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  await page.locator('body').press('c')
  const panel = page.locator('[data-dock-panel="conversation"]')
  await panel.waitFor()
  // every member has spoken once the button counts the 83 agents (the scenario plays in about 4 s)
  await panel.getByRole('button', { name: TEXT[locale].button }).filter({ hasText: TEXT[locale].all }).waitFor({ timeout: 60_000 })
  await waitForStableLayout(page)
  return page
}

/** Geometry of the agent area: its sideways overflow, the panel box, and the boxes of the button, the list and its options. */
const MEASURE = `(() => {
  const panel = document.querySelector('[data-dock-panel="conversation"]')
  const button = panel.querySelector('[data-agent-picker-button]')
  const area = button.closest('[data-agent-picker]')
  const listbox = panel.querySelector('[role="listbox"]')
  const box = el => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height } }
  const p = box(panel)
  const options = listbox ? [...listbox.querySelectorAll('[role="option"]')] : []
  const lb = listbox ? box(listbox) : null
  return {
    areaScroll: area.scrollWidth, areaClient: area.clientWidth,
    listScroll: listbox ? listbox.scrollWidth : 0, listClient: listbox ? listbox.clientWidth : 0,
    docScroll: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
    panel: p, button: box(button), listbox: lb,
    options: options.length,
    // reachable without a sideways scroll: the whole width of the option is inside the list
    reachable: lb ? options.filter(o => { const r = box(o); return r.l >= lb.l - 0.5 && r.r <= lb.r + 0.5 }).length : 0,
    minOptionH: options.length ? Math.min(...options.map(o => box(o).h)) : null,
  }
})()`

interface Geometry {
  areaScroll: number; areaClient: number; listScroll: number; listClient: number; docScroll: number; vw: number
  panel: { l: number; r: number; t: number; b: number; h: number }; button: { l: number; r: number; t: number; b: number; h: number }
  listbox: { l: number; r: number; t: number; b: number; h: number } | null; options: number; reachable: number; minOptionH: number | null
}

const within = (inner: { l: number; r: number; t: number; b: number }, outer: { l: number; r: number; t: number; b: number }) =>
  inner.l >= outer.l - 0.5 && inner.r <= outer.r + 0.5 && inner.t >= outer.t - 0.5 && inner.b <= outer.b + 0.5

for (const locale of ['fr', 'en'] as const) {
  for (const [w, h] of [[320, 640], [390, 800], [1280, 800]] as Array<[number, number]>) {
    test(`${locale} ${w}x${h}: 83 agents, one picker, no sideways scroll, every agent reachable, the chosen one in view`, { timeout: 180_000 }, async () => {
      const page = await open(w, h, locale)
      try {
        const panel = page.locator('[data-dock-panel="conversation"]')
        assert.equal(await panel.getByRole('tablist').count(), 0, 'no row of tabs with 83 agents')
        let g = await page.evaluate(MEASURE) as Geometry
        console.log(`# [${locale} ${w}x${h}] closed: agent area ${g.areaScroll}/${g.areaClient} px, button ${Math.round(g.button.r - g.button.l)}x${Math.round(g.button.h)} px`)
        assert.ok(g.areaScroll <= g.areaClient + 1, `the agent area does not scroll sideways (${g.areaScroll} > ${g.areaClient})`)
        assert.ok(g.docScroll <= g.vw, `the page does not scroll sideways (${g.docScroll} > ${g.vw})`)
        assert.ok(within(g.button, g.panel), `the button is inside the panel ${JSON.stringify(g.button)} / ${JSON.stringify(g.panel)}`)
        const touch = w < 768
        if (touch) {
          assert.ok(g.button.h >= 44 - 0.5, `the button is 44 px high under 768 px (${g.button.h})`)
          const pairH = await panel.getByRole('button', { name: TEXT[locale].pair, exact: true }).evaluate(b => b.getBoundingClientRect().height)
          assert.ok(pairH >= 44 - 0.5, `Filter pair is 44 px high under 768 px (${pairH})`)
        }

        // open, unfold the finished agents: the 83 agents and All are options, all reachable by a vertical scroll only
        const button = panel.getByRole('button', { name: TEXT[locale].button })
        await button.click()
        const search = panel.getByRole('combobox', { name: TEXT[locale].search })
        await search.waitFor()
        assert.equal(await search.evaluate(el => el === document.activeElement), true, 'focus moves to the search field')
        await panel.getByRole('button', { name: TEXT[locale].showDone }).click()
        await waitForStableLayout(page)
        // On a short panel (320 x 640) the list keeps its minimum of three options and the open area scrolls vertically to show it
        await page.evaluate(() => document.querySelector('[data-dock-panel="conversation"] [role="listbox"]')?.scrollIntoView({ block: 'nearest' }))
        g = await page.evaluate(MEASURE) as Geometry
        console.log(`# [${locale} ${w}x${h}] panel ${Math.round(g.panel.h)} px, list ${Math.round(g.listbox?.h ?? 0)} px, options ${g.options}, reachable without a sideways scroll ${g.reachable}, option height ${g.minOptionH}, area ${g.areaScroll}/${g.areaClient}`)
        assert.equal(g.options, AGENTS + 1, 'every agent and All are listed')
        assert.equal(g.reachable, AGENTS + 1, `${g.reachable} of ${AGENTS + 1} options reachable without a sideways scroll`)
        assert.ok(g.listScroll <= g.listClient + 1, `the list does not scroll sideways (${g.listScroll} > ${g.listClient})`)
        assert.ok(g.areaScroll <= g.areaClient + 1, 'the open agent area does not scroll sideways')
        assert.ok(g.listbox && within(g.listbox, g.panel), `the list is inside the panel ${JSON.stringify(g.listbox)} / ${JSON.stringify(g.panel)}`)
        if (touch) assert.ok((g.minOptionH ?? 0) >= 44 - 0.5, `options are 44 px high under 768 px (${g.minOptionH})`)
        // the list keeps room for at least two whole options, so it is a list one can browse, not a sliver
        assert.ok(g.listbox && g.listbox.h >= 2 * (g.minOptionH ?? 0), `the list shows at least two options (${g.listbox?.h} px for options of ${g.minOptionH} px)`)
        await page.screenshot({ path: `test-results/agent-picker-${locale}-${w}-open.png` }).catch(() => {})
        await page.keyboard.press('Escape')
        assert.equal(await button.evaluate(el => el === document.activeElement), true, 'Escape gives the focus back to the button')

        // a choice made outside the picker (a message row selects its agent, as the canvas does): shown by the button, in view on opening
        if (!touch) {
          await panel.locator('[role="listitem"] button[aria-pressed]').last().click()
          await page.waitForTimeout(300)
          const text = await button.innerText()
          assert.doesNotMatch(text, new RegExp(TEXT[locale].all.replace(/[()]/g, '\\$&')), `the button shows the chosen agent (${text})`)
          // the chosen name is shown whole: it wraps inside the button, never cut by an ellipsis or by the button edge
          const clip = await button.evaluate(b => {
            const name = b.querySelector('[lang="en"]')!
            const br = b.getBoundingClientRect()
            const rects = [...name.getClientRects()]
            return {
              overflow: b.scrollWidth - b.clientWidth,
              inside: rects.length > 0 && rects.every(r => r.left >= br.left - 0.5 && r.right <= br.right + 0.5 && r.top >= br.top - 0.5 && r.bottom <= br.bottom + 0.5),
              ellipsis: [...b.querySelectorAll('*')].some(e => getComputedStyle(e).textOverflow === 'ellipsis'),
            }
          })
          assert.ok(clip.overflow <= 1 && clip.inside && !clip.ellipsis, `the chosen agent name is not cut (${JSON.stringify(clip)})`)
          await button.click()
          await search.waitFor()
          await waitForStableLayout(page)
          const inView = await page.evaluate(() => {
            const panel = document.querySelector('[data-dock-panel="conversation"]')!
            const input = panel.querySelector('[role="combobox"]')!
            const opt = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
            const lb = panel.querySelector('[role="listbox"]')!
            if (!opt) return { ok: false, text: null }
            const a = lb.getBoundingClientRect(), b = opt.getBoundingClientRect()
            return { ok: b.top >= a.top - 0.5 && b.bottom <= a.bottom + 0.5, text: opt.textContent }
          })
          assert.ok(inView.ok, `the chosen agent's option is in view on opening (${inView.text})`)
          assert.ok(text.includes((inView.text ?? '').split(' ')[0]), 'the active option is the chosen agent')
          await page.keyboard.press('Escape')
        }
      } finally {
        await page.context().close()
      }
    })
  }
}

// Reflow at 200 % (WCAG 1.4.10): 640 x 400 is 1280 x 800 zoomed to 200 %. The panel is 230 px high; before, the open area was
// capped at 70 % and the list squeezed to 15 px, no option visible. Now the list keeps at least three options of height (plus a
// group heading), the Teams block folds while it is open, and when the panel cannot hold it all the open area scrolls vertically.
for (const locale of ['fr', 'en'] as const) {
  test(`${locale} 640x400 (200 % zoom): the open list keeps room for three options and every option stays reachable`, { timeout: 180_000 }, async () => {
    const page = await open(640, 400, locale)
    try {
      const panel = page.locator('[data-dock-panel="conversation"]')
      assert.equal(await panel.getByRole('region', { name: TEAMS[locale] }).count(), 1, 'the Teams block is shown while the list is closed')
      await panel.getByRole('button', { name: TEXT[locale].button }).click()
      await panel.getByRole('combobox', { name: TEXT[locale].search }).waitFor()
      await panel.getByRole('button', { name: TEXT[locale].showDone }).click()
      await waitForStableLayout(page)
      assert.equal(await panel.getByRole('region', { name: TEAMS[locale] }).count(), 0, 'the Teams block is folded while the list is open')
      // bring the list into the view of the open area, then into the middle of its own options
      await page.evaluate(() => {
        const lb = document.querySelector('[data-dock-panel="conversation"] [role="listbox"]')!
        lb.scrollIntoView({ block: 'nearest' })
        lb.scrollTop = lb.scrollHeight / 2
      })
      const m = await page.evaluate(`(() => {
        const panel = document.querySelector('[data-dock-panel="conversation"]')
        const area = panel.querySelector('[data-agent-picker]')
        const lb = panel.querySelector('[role="listbox"]')
        const p = panel.getBoundingClientRect(), a = area.getBoundingClientRect(), l = lb.getBoundingClientRect()
        const top = Math.max(p.top, a.top, l.top), bottom = Math.min(p.bottom, a.bottom, l.bottom)
        const options = [...lb.querySelectorAll('[role="option"]')]
        const optH = Math.min(...options.map(o => o.getBoundingClientRect().height))
        return {
          listH: l.height, optH, options: options.length,
          visible: options.filter(o => { const r = o.getBoundingClientRect(); return r.top >= top - 0.5 && r.bottom <= bottom + 0.5 }).length,
          docScroll: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
          areaX: area.scrollWidth - area.clientWidth, listX: lb.scrollWidth - lb.clientWidth,
        }
      })()`) as { listH: number; optH: number; options: number; visible: number; docScroll: number; vw: number; areaX: number; listX: number }
      console.log(`# [${locale} 640x400] list ${Math.round(m.listH)} px, options of ${m.optH} px, ${m.visible} whole options visible mid-list, ${m.options} options`)
      assert.ok(m.listH >= 3 * m.optH - 0.5, `the list is at least three options high (${m.listH} px for options of ${m.optH} px)`)
      assert.ok(m.visible >= 3, `three whole options are visible at once (${m.visible})`)
      assert.equal(m.options, AGENTS + 1, 'every agent and All are listed')
      assert.ok(m.docScroll <= m.vw && m.areaX <= 1 && m.listX <= 1, `nothing scrolls sideways ${JSON.stringify(m)}`)
    } finally {
      await page.context().close()
    }
  })
}
