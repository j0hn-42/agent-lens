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
  await page.waitForTimeout(500)
  return { page, close: () => context.close() }
}

async function axeFailures(page: Page, scenario: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    // The canvas is the only place with a continuously changing background, so contrast is
    // computed on the DOM chrome; page-level landmark rules are covered by the app shell.
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
          await page.waitForTimeout(400)
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
  // 320 CSS px is 400 % zoom of a 1280 px window; 640 CSS px is 200 % zoom.
  for (const width of [320, 640]) {
    test(`no horizontal page scroll at ${width} px wide`, async t => {
      if (skipReason) return t.skip(skipReason)
      const { page, close } = await open({ width, height: 700 })
      try {
        const m = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth,
        }))
        assert.ok(m.doc <= m.inner && m.body <= m.inner, `horizontal overflow at ${width}px: ${JSON.stringify(m)}`)
        await page.getByRole('button', { name: 'Pause and review history' }).click()
        await page.getByRole('slider', { name: 'Timeline position' }).waitFor()
        const r = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        assert.ok(r <= 0, `review mode overflows by ${r}px at ${width}px`)
      } finally { await close() }
    })
  }
})

describe('demo mode: prefers-reduced-motion', () => {
  test('no CSS animation or transition keeps running when motion is reduced', async t => {
    if (skipReason) return t.skip(skipReason)
    const { page, close } = await open({ reducedMotion: 'reduce' })
    try {
      await page.waitForTimeout(1500)
      const running = await page.evaluate(() =>
        document.getAnimations()
          .filter(a => a.playState === 'running')
          .map(a => `${a.constructor.name} on ${(a.effect as KeyframeEffect | null)?.target?.tagName ?? '?'}`))
      assert.deepEqual(running, [], 'ambient animations must stop under prefers-reduced-motion')
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
      await page.waitForTimeout(400)
      const hidden = await page.evaluate(findInvisibleFocusables, FOCUSABLE_SELECTOR)
      const { unexpected, stale } = compareViolations(
        'e2e:tab-order', hidden.length ? ['invisible-focusable'] : [], known,
      )
      assert.deepEqual(unexpected, [], `invisible controls must not be in the Tab order: ${hidden.join(', ')} (fix, or allow-list in known-violations.json with an issue number)`)
      assert.deepEqual(stale, [], 'no invisible control is focusable any more: remove "e2e:tab-order" from web/tests-a11y/known-violations.json')

      const knownInvisible = known.some(k => k.scenario === 'e2e:tab-order')
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
        if (!s) continue
        if (!s.visible && !knownInvisible) assert.fail(`Tab landed on an invisible element: ${s.id}`)
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
      await page.getByRole('button', { name: 'Pause and review history' }).click()
      const slider = page.getByRole('slider', { name: 'Timeline position' })
      await slider.focus()
      const value = async () => Number(await slider.getAttribute('aria-valuenow'))
      const max = Number(await slider.getAttribute('aria-valuemax'))
      await page.keyboard.press('Home')
      assert.equal(await value(), 0)
      await page.keyboard.press('End')
      assert.equal(await value(), max)
      await page.keyboard.press('ArrowLeft')
      assert.ok(await value() <= max, 'ArrowLeft never goes past the end')
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowRight')
      assert.ok(await value() >= 0)
    } finally { await close() }
  })
})
