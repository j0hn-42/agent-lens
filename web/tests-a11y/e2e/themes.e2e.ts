// Browser checks of the themes: graphite by default, the selector switches neon / graphite / paper, the choice
// survives a reload, the canvas palette follows, and no theme breaks the page. Runs against the demo app:
//
//   pnpm --dir web run test:e2e
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser, type Page } from 'playwright'
import { startDemoServer, type DemoServer } from './demo-server'

let browser: Browser
let server: DemoServer

before(async () => {
  server = await startDemoServer()
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await server?.stop()
})

const rootState = (page: Page) => page.evaluate(() => {
  const root = document.documentElement
  const cs = getComputedStyle(root)
  return {
    theme: root.dataset.theme,
    dark: root.classList.contains('dark'),
    scheme: root.style.colorScheme,
    void: cs.getPropertyValue('--lens-void').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }
})

test('graphite is the default; the selector switches themes and the choice survives a reload', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  try {
    await page.goto(server.url)
    const select = page.getByRole('combobox', { name: 'Theme' })
    await select.waitFor()
    assert.equal(await select.inputValue(), 'graphite')
    let s = await rootState(page)
    assert.deepEqual([s.theme, s.dark, s.scheme, s.void], ['graphite', true, 'dark', '#121212'])
    assert.equal(s.bodyBg, 'rgb(5, 5, 16)', 'the page background is the scene ground, not themed')

    await select.selectOption('paper')
    s = await rootState(page)
    assert.deepEqual([s.theme, s.dark, s.scheme, s.void], ['paper', false, 'light', '#f6f6f4'])
    assert.equal(s.bodyBg, 'rgb(5, 5, 16)', 'paper: the page background stays the scene ground')

    await select.selectOption('neon')
    s = await rootState(page)
    assert.deepEqual([s.theme, s.dark, s.scheme, s.void], ['neon', true, 'dark', '#050510'])
    assert.equal(s.bodyBg, 'rgb(5, 5, 16)')

    await select.selectOption('paper')
    await page.reload()
    await page.getByRole('combobox', { name: 'Theme' }).waitFor()
    assert.equal(await page.getByRole('combobox', { name: 'Theme' }).inputValue(), 'paper')
    assert.equal((await rootState(page)).theme, 'paper')
  } finally {
    await context.close()
  }
})

test('?theme= picks the theme when nothing is stored, and the selector reflects it', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(`${server.url}?theme=neon`)
    await page.getByRole('combobox', { name: 'Theme' }).waitFor()
    assert.equal((await rootState(page)).theme, 'neon')
    assert.equal(await page.getByRole('combobox', { name: 'Theme' }).inputValue(), 'neon')
  } finally {
    await context.close()
  }
})

test('a theme stored by an earlier version (dark / light) maps to graphite / paper', async () => {
  for (const [stored, expected] of [['dark', 'graphite'], ['light', 'paper']] as const) {
    const context = await browser.newContext()
    await context.addInitScript(value => { try { localStorage.setItem('agent-lens-theme', value) } catch { /* blocked */ } }, stored)
    const page = await context.newPage()
    try {
      await page.goto(server.url)
      await page.getByRole('combobox', { name: 'Theme' }).waitFor()
      assert.equal((await rootState(page)).theme, expected)
    } finally {
      await context.close()
    }
  }
})

test('the selector is reachable and operable with the keyboard', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(server.url)
    const select = page.getByRole('combobox', { name: 'Theme' })
    await select.focus()
    await page.keyboard.press('ArrowDown')
    assert.equal((await rootState(page)).theme, 'paper', 'ArrowDown moves from graphite to paper')
  } finally {
    await context.close()
  }
})

test('a stored non-default theme hydrates without a mismatch and paints with its own palette', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors: string[] = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(String(e)))
  try {
    await page.goto(`${server.url}?theme=paper`)
    await page.getByRole('combobox', { name: 'Theme' }).waitFor()
    await page.waitForTimeout(1500)
    assert.deepEqual(errors.filter(e => /hydrat/i.test(e)), [])
    // A COLORS-based inline style (the select border) uses the paper control border, not graphite's
    const border = await page.getByRole('combobox', { name: 'Theme' }).evaluate(el => getComputedStyle(el).borderTopColor)
    assert.equal(border, 'rgb(138, 138, 134)')
  } finally {
    await context.close()
  }
})
