// Browser checks for what jsdom cannot see: real layout, color contrast, reflow, reduced
// motion and the full-page Tab order (issue #43). Runs against the demo build:
//
//   pnpm run dev:demo            # in one terminal (E2E_BASE_URL defaults to :3000)
//   pnpm --dir web run test:e2e  # in another
//
// Needs a browser: `pnpm --dir web exec playwright install chromium` (CI does this).
// Without a reachable server the whole file is skipped locally and FAILS in CI.
import { test, before, after, describe } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { compareViolations, type KnownViolation } from '../axe-compare'
import { findInvisibleFocusables, FOCUSABLE_SELECTOR } from './focus-audit'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const IN_CI = !!process.env.CI
const known: KnownViolation[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'known-violations.json'), 'utf8'),
)

let browser: Browser
let skipReason: string | null = null

before(async () => {
  try {
    const res = await fetch(BASE_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    if (IN_CI) throw new Error(`demo server not reachable at ${BASE_URL}: ${String(err)}`)
    skipReason = `demo server not reachable at ${BASE_URL} (start it with pnpm run dev:demo)`
    return
  }
  browser = await chromium.launch()
})

after(async () => { await browser?.close() })

async function open(options: { width?: number; height?: number; reducedMotion?: 'reduce' | 'no-preference' } = {}) {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    reducedMotion: options.reducedMotion ?? 'no-preference',
  })
  const page = await context.newPage()
  await page.goto(BASE_URL)
  await page.getByRole('button', { name: 'Files' }).waitFor()
  await waitForStableLayout(page)
  return { page, close: () => context.close() }
}

// Plain JS string (tsx would inject a __name helper the page lacks). Resolves once the bounding
// boxes of all visible interactive elements and landmarks are unchanged over two consecutive
// animation frames AND have not changed for QUIET_MS, so late-rendering content (transcript rows,
// panels animating in) is measured only after it exists. Rejects after the timeout.
const QUIET_MS = 750
const STABLE_SCRIPT = `new Promise((resolve, reject) => {
  const sel = 'button, a[href], input, select, textarea, [role], [tabindex], main, aside, section, nav'
  const snap = () => Array.from(document.querySelectorAll(sel)).map(el => {
    const r = el.getBoundingClientRect()
    return [el.tagName, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',')
  }).join('|')
  const start = performance.now()
  let prev = snap(), lastChange = start, same = 0
  const tick = () => {
    const now = performance.now()
    const cur = snap()
    if (cur === prev) same++; else { same = 0; lastChange = now; prev = cur }
    if (same >= 2 && now - lastChange >= ${QUIET_MS}) return resolve(true)
    if (now - start > 15000) return reject(new Error('layout did not settle within 15 s'))
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})`

async function waitForStableLayout(page: Page) {
  await page.evaluate(STABLE_SCRIPT)
}

async function axeFailures(page: Page, scenario: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    // Nothing is excluded: axe cannot see inside the canvas bitmap, so only DOM chrome is checked.
    .analyze()
  const serious = results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical')
  const { unexpected, stale } = compareViolations(
    scenario, serious.map(v => v.id), known,
  )
  const detail = (id: string) => {
    const v = serious.find(x => x.id === id)
    return `${id}: ${v?.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`
  }
  return { unexpected: unexpected.map(detail), stale }
}

function expectClean(scenario: string, r: { unexpected: string[]; stale: string[] }) {
  assert.deepEqual(r.unexpected, [], `[${scenario}] new serious/critical axe violations (fix them or add them to web/tests-a11y/known-violations.json with an issue number)`)
  assert.deepEqual(r.stale, [], `[${scenario}] allow-listed violations no longer occur: remove them from web/tests-a11y/known-violations.json`)
}

describe('demo mode: axe-core, serious and critical only', () => {
  const panels: Array<[string, string]> = [['initial page', ''], ['files', 'Files'], ['chat', 'Chat'], ['timeline', 'Timeline'], ['cost', '$Cost']]
  for (const [name, button] of panels) {
    test(`e2e: ${name}`, async t => {
      if (skipReason) return t.skip(skipReason)
      const { page, close } = await open()
      try {
        if (button) {
          await page.getByRole('button', { name: new RegExp(`^${button.replace('$', '\\$')}`) }).first().click()
          await waitForStableLayout(page)
        }
        expectClean(`e2e:${name}`, await axeFailures(page, `e2e:${name}`))
      } finally { await close() }
    })
  }

  test('e2e: review mode', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await page.getByRole('button', { name: 'Pause and review history' }).click()
      await page.getByRole('slider', { name: 'Timeline position' }).waitFor()
      expectClean('e2e:review-mode', await axeFailures(page, 'e2e:review-mode'))
    } finally { await close() }
  })

  test('e2e: keyboard shortcuts dialog', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
      await page.getByRole('dialog').waitFor()
      expectClean('e2e:shortcuts-dialog', await axeFailures(page, 'e2e:shortcuts-dialog'))
    } finally { await close() }
  })
})

describe('demo mode: reflow and zoom (WCAG 1.4.10)', () => {
  // Measures clipping inside inner containers, not only page-level scroll: the main landmark and
  // every panel/dialog must not scroll horizontally, and every visible interactive element must
  // sit inside the viewport horizontally.
  // Plain JS string: tsx serialises named functions with a __name helper the page lacks.
  const MEASURE = `(() => {
    const vw = window.innerWidth
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    }
    const label = (el) =>
      \`\${el.tagName.toLowerCase()}[\${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}]\`
    const containers = Array.from(document.querySelectorAll(
      'main, [role="main"], [role="dialog"], [role="region"], aside, section, nav',
    )).filter(visible)
    const clippedContainers = containers
      .filter(el => el.clientWidth > 1 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
      .map(el => \`\${label(el)} scrollWidth=\${el.scrollWidth} clientWidth=\${el.clientWidth}\`)
    const outside = Array.from(document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [role="slider"], [role="tab"], [role="menuitem"], [tabindex]:not([tabindex="-1"])',
    )).filter(visible).filter(el => {
      const r = el.getBoundingClientRect()
      return r.left < -1 || r.right > vw + 1
    }).map(el => { const r = el.getBoundingClientRect(); return \`\${label(el)} \${Math.round(r.left)}..\${Math.round(r.right)}\` })
    return {
      doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: vw,
      clippedContainers, outside,
    }
  })()`
  const KNOWN_OUTSIDE = /^(div\[Agent graph|button\[Refactor the payment)/
  type Measure = { doc: number; body: number; inner: number; clippedContainers: string[]; outside: string[] }
  // Findings are collected over every step (initial, review mode, panels) and compared with the
  // allow-list once, so a known defect does not hide a new one in a later step.
  type Findings = { rules: Set<string>; details: string[] }
  const record = (f: Findings, width: number, where: string, m: Measure) => {
    const add = (rule: string, detail: string) => { f.rules.add(rule); f.details.push(`[${where} @${width}px] ${rule}: ${detail}`) }
    if (m.doc > m.inner || m.body > m.inner) add('page-overflow', `doc=${m.doc} body=${m.body}`)
    if (m.clippedContainers.length) add('clipped-container', m.clippedContainers.join('; '))
    // The allow-list entry covers only the elements tracked in issue #23 (transcript row buttons and
    // the Agent graph region); any other clipped control is a new, never allow-listed rule.
    const tracked = m.outside.filter(o => KNOWN_OUTSIDE.test(o))
    const untracked = m.outside.filter(o => !KNOWN_OUTSIDE.test(o))
    if (tracked.length) add('outside-viewport', tracked.join('; '))
    if (untracked.length) add('outside-viewport-untracked', untracked.join('; '))
  }

  // Click like a user; if another element intercepts the pointer, record it and fall back to the keyboard
  // so the remaining steps still run.
  async function openPanelChecked(page: Page, name: RegExp, f: Findings, where: string) {
    const btn = page.getByRole('button', { name }).first()
    try {
      await btn.click({ timeout: 3000 })
    } catch {
      f.rules.add('pointer-obstructed')
      f.details.push(`[${where}] pointer-obstructed: a panel covers the "${name.source}" button`)
      await btn.focus()
      await page.keyboard.press('Space')
    }
    await page.waitForFunction(
      (source: string) => Array.from(document.querySelectorAll('button[aria-pressed="true"]')).some(b => new RegExp(source, 'i').test((b.textContent ?? '') + (b.getAttribute('aria-label') ?? ''))),
      name.source,
    )
    await waitForStableLayout(page)
  }

  // 320 CSS px is 400 % zoom of a 1280 px window; 640 CSS px is 200 % zoom.
  for (const width of [320, 640]) {
    test(`no clipped content or horizontal scroll at ${width} px wide`, async t => {
      if (skipReason) return t.skip(skipReason)
      const { page, close } = await open({ width, height: 700 })
      try {
        const f: Findings = { rules: new Set(), details: [] }
        record(f, width, 'initial', await page.evaluate<Measure>(MEASURE))
        await page.getByRole('button', { name: 'Pause and review history' }).click()
        await page.getByRole('slider', { name: 'Timeline position' }).waitFor()
        await waitForStableLayout(page)
        record(f, width, 'review mode', await page.evaluate<Measure>(MEASURE))
        for (const [label, re] of [['files panel', /^Files/], ['chat panel', /^Chat/]] as const) {
          await openPanelChecked(page, re, f, `${label} @${width}px`)
          record(f, width, label, await page.evaluate<Measure>(MEASURE))
        }
        const scenario = `e2e:reflow-${width}`
        const { unexpected, stale } = compareViolations(scenario, [...f.rules], known)
        assert.deepEqual(unexpected, [], `[${scenario}] new reflow defects (fix them or allow-list in known-violations.json with an issue number):\n${f.details.join('\n')}`)
        assert.deepEqual(stale, [], `[${scenario}] allow-listed reflow defects no longer occur: remove them from known-violations.json`)
      } finally { await close() }
    })
  }
})

describe('demo mode: prefers-reduced-motion', () => {
  // The app animates on a canvas via requestAnimationFrame, which document.getAnimations() never
  // sees. Compare two canvas frames taken one second apart: they must differ with
  // no-preference (baseline, proves the check can detect motion) and be identical with reduce.
  // Follow-up for the canvas owner: expose a test-only draw counter behind ?e2e=1.
  // Fraction of canvas pixels that changed between two frames one second apart (run in the page).
  const DIFF_SCRIPT = `new Promise(resolve => {
    const c = document.querySelector('canvas')
    const snap = () => { const o = document.createElement('canvas'); o.width = c.width; o.height = c.height
      const x = o.getContext('2d'); x.drawImage(c, 0, 0); return x.getImageData(0, 0, o.width, o.height).data }
    const a = snap()
    setTimeout(() => { const b = snap(); let n = 0
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i+1] !== b[i+1] || a[i+2] !== b[i+2]) n++
      resolve(n / (a.length / 4)) }, 1000)
  })`
  async function changedFraction(reducedMotion: 'reduce' | 'no-preference') {
    const { page, close } = await open({ reducedMotion })
    try {
      await page.locator('canvas').first().waitFor()
      await page.waitForTimeout(3000) // let the layout settle so only ambient motion remains
      return await page.evaluate<number>(DIFF_SCRIPT)
    } finally { await close() }
  }

  test('canvas stops its ambient animation when motion is reduced', async t => {
    if (skipReason) return t.skip(skipReason)
    const baseline = await changedFraction('no-preference')
    if (baseline < 0.001) return t.skip(`baseline canvas is static (${baseline}), cannot detect motion; needs a ?e2e=1 draw counter from the canvas owner`)
    const reduced = await changedFraction('reduce')
    // Data-driven redraws (agent status, edge particles tied to events) still change pixels under
    // reduce; removing the matchMedia guard brings the two fractions close to equal.
    assert.ok(reduced < baseline * 0.75, `canvas keeps animating under prefers-reduced-motion: changed pixels ${reduced} vs ${baseline} baseline`)
  })

  test('no CSS animation keeps running when motion is reduced', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open({ reducedMotion: 'reduce' })
    try {
      await page.waitForTimeout(1000)
      const running = await page.evaluate(() =>
        document.getAnimations()
          .filter(a => a.playState === 'running' && (a.effect?.getComputedTiming().iterations ?? 1) === Infinity)
          .map(a => `${a.constructor.name} on ${(a.effect as KeyframeEffect | null)?.target?.tagName ?? '?'}`))
      assert.deepEqual(running, [], 'infinite CSS animations must stop under prefers-reduced-motion')
    } finally { await close() }
  })
})

describe('demo mode: keyboard', () => {
  test('no focusable control is invisible, and every Tab stop is visible', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await page.getByRole('button', { name: 'Pause and review history' }).click()
      await page.getByRole('button', { name: 'Chat' }).click()
      await waitForStableLayout(page)
      const hidden = (await page.evaluate(findInvisibleFocusables, FOCUSABLE_SELECTOR)).filter(h => !h.startsWith('nextjs-portal'))
      const { unexpected, stale } = compareViolations(
        'e2e:tab-order', hidden.length ? ['invisible-focusable'] : [], known,
      )
      assert.deepEqual(unexpected, [], `invisible controls must not be in the Tab order: ${hidden.join(', ')} (fix, or allow-list in known-violations.json with an issue number)`)
      assert.deepEqual(stale, [], 'no invisible control is focusable any more: remove "e2e:tab-order" from web/tests-a11y/known-violations.json')

      // Even while #10 is allow-listed, a Tab stop must be one of the invisible focusables found
      // by the static scan above; a new invisible stop elsewhere fails.
      const knownHidden = new Set(hidden)
      const stops: string[] = []
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab')
        const s = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return null
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return {
            id: `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? ''}]`,
            visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
          }
        })
        if (!s || s.id.startsWith('nextjs-portal')) continue // Next dev overlay, not app UI
        if (!s.visible && !knownHidden.has(s.id)) assert.fail(`Tab landed on an invisible element: ${s.id}`)
        stops.push(s.id)
      }
      assert.ok(new Set(stops).size >= 8, `expected a reachable control set, got ${new Set(stops).size} distinct stops`)
    } finally { await close() }
  })

  test('Space on a focused button activates only that button', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      const files = page.getByRole('button', { name: /^Files/ })
      await files.focus()
      const pressed = (name: RegExp) => page.getByRole('button', { name }).first().getAttribute('aria-pressed')
      assert.equal(await pressed(/^Files/), 'false')
      await page.keyboard.press('Space')
      assert.equal(await pressed(/^Files/), 'true', 'Space activates the focused button')
      assert.equal(await pressed(/^Timeline/), 'false', 'other toggles are untouched')
      assert.equal(await page.getByRole('button', { name: 'Pause and review history' }).count(), 1, 'Space did not pause playback')
    } finally { await close() }
  })

  test('Escape closes the most recently opened panel only', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await page.getByRole('button', { name: /^Files/ }).click()
      await page.getByRole('button', { name: /^Timeline/ }).click()
      const pressed = (name: RegExp) => page.getByRole('button', { name }).first().getAttribute('aria-pressed')
      assert.equal(await pressed(/^Timeline/), 'true')
      await page.keyboard.press('Escape')
      assert.equal(await pressed(/^Timeline/), 'false', 'last opened panel closed')
      assert.equal(await pressed(/^Files/), 'true', 'earlier panel stays open')
      await page.keyboard.press('Escape')
      assert.equal(await pressed(/^Files/), 'false')
    } finally { await close() }
  })

  test('the review scrubber answers Home, End and arrow keys', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await page.waitForTimeout(5000) // the demo needs a few seconds to build a non-empty history
      await page.getByRole('button', { name: 'Pause and review history' }).click()
      const slider = page.getByRole('slider', { name: 'Timeline position' })
      await slider.focus()
      const value = async () => Number(await slider.getAttribute('aria-valuenow'))
      const max = Number(await slider.getAttribute('aria-valuemax'))
      assert.ok(max >= 2, `history is too short to test arrow keys (max=${max})`)
      await page.keyboard.press('Home')
      assert.equal(await value(), 0)
      await page.keyboard.press('End')
      assert.equal(await value(), max)
      await page.keyboard.press('ArrowLeft')
      assert.ok(await value() < max, 'ArrowLeft moves the scrubber back')
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowRight')
      assert.ok(await value() > 0, 'ArrowRight moves the scrubber forward')
    } finally { await close() }
  })
})

describe('demo mode: context menu and tool popup (issue #43)', () => {
  const GRAPH = '[role="img"][tabindex="0"]'
  const activeLabel = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return el ? `${el.getAttribute('role') ?? el.tagName.toLowerCase()}:${(el.textContent ?? '').trim()}` : ''
    })
  const graphHasFocus = (page: Page) =>
    page.evaluate(sel => document.activeElement === document.querySelector(sel), GRAPH)

  async function openMenuByKeyboard(page: Page) {
    await page.locator(GRAPH).focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.getByRole('menu', { name: 'Context menu' })
    await menu.waitFor()
    return menu
  }

  // The tool card lives on the canvas bitmap, but every card also has a button in the graph outline
  // (same callback as a canvas click). Cards fade out after a few seconds, so click as soon as one exists.
  async function openToolPopup(page: Page) {
    const sel = 'ul[aria-label^="Tool calls of"] button[data-graph-node]'
    await page.waitForSelector(sel, { state: 'attached', timeout: 20000 })
    await page.evaluate(s => (document.querySelector(s) as HTMLButtonElement | null)?.click(), sel)
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ timeout: 5000 })
    return dialog
  }

  test('e2e: context menu opened with a right click has no serious axe violation', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await page.locator('canvas').first().click({ button: 'right', position: { x: 40, y: 200 } })
      await page.getByRole('menu', { name: 'Context menu' }).waitFor()
      expectClean('e2e:context-menu', await axeFailures(page, 'e2e:context-menu'))
    } finally { await close() }
  })

  test('e2e: tool popup has no serious axe violation', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await openToolPopup(page)
      expectClean('e2e:tool-popup', await axeFailures(page, 'e2e:tool-popup'))
    } finally { await close() }
  })

  test('context menu: right click, arrow keys, Home, End and Escape', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      // Right click on empty canvas: the canvas menu has several items (the agent menu has one).
      await page.locator('canvas').first().click({ button: 'right', position: { x: 40, y: 200 } })
      const menu = page.getByRole('menu', { name: 'Context menu' })
      await menu.waitFor()
      const items = menu.getByRole('menuitem')
      const count = await items.count()
      assert.ok(count >= 2, `expected at least two menu items, got ${count}`)
      const labels = (await items.allTextContents()).map(s => s.trim())
      assert.equal(await activeLabel(page), `menuitem:${labels[0]}`, 'first item is focused on open')
      await page.keyboard.press('ArrowDown')
      assert.equal(await activeLabel(page), `menuitem:${labels[1]}`, 'ArrowDown moves to the next item')
      await page.keyboard.press('ArrowUp')
      assert.equal(await activeLabel(page), `menuitem:${labels[0]}`, 'ArrowUp moves back')
      await page.keyboard.press('End')
      assert.equal(await activeLabel(page), `menuitem:${labels[count - 1]}`, 'End focuses the last item')
      await page.keyboard.press('Home')
      assert.equal(await activeLabel(page), `menuitem:${labels[0]}`, 'Home focuses the first item')
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
    } finally { await close() }
  })

  test('context menu: Shift+F10 opens it, Escape closes it and focus returns to the graph', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      const menu = await openMenuByKeyboard(page)
      assert.ok(await menu.getByRole('menuitem').count() >= 1)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
      assert.equal(await graphHasFocus(page), true, 'focus returns to the graph surface that opened the menu')
    } finally { await close() }
  })

  test('context menu: the ContextMenu key opens it and Tab closes it with focus returned', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      await page.locator(GRAPH).focus()
      await page.keyboard.press('ContextMenu')
      const menu = page.getByRole('menu', { name: 'Context menu' })
      await menu.waitFor()
      await page.keyboard.press('Tab')
      await menu.waitFor({ state: 'detached' })
      assert.equal(await graphHasFocus(page), true, 'focus returns to the graph surface')
    } finally { await close() }
  })

  test('tool popup: Escape closes it and focus is not lost to a detached node', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open()
    try {
      const dialog = await openToolPopup(page)
      assert.ok(await dialog.getByRole('button', { name: /close/i }).count() >= 1, 'popup has a named close button')
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      const connected = await page.evaluate(() => !!document.activeElement && document.activeElement.isConnected)
      assert.ok(connected, 'focus is on a live element')
    } finally { await close() }
  })
})
