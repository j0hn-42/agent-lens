// Browser checks of the themes: Catppuccin Macchiato by default, the selector switches the nine themes, the choice
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

/** The theme selector lives in the Settings dialog: open it (once) and return the selector. */
async function themeSelect(page: Page) {
  const select = page.getByRole('combobox', { name: 'Theme' })
  if (!(await select.isVisible())) await page.getByRole('button', { name: 'Settings' }).click()
  await select.waitFor()
  return select
}

const rootState =(page: Page) => page.evaluate(() => {
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

test('catppuccin-macchiato is the default; the selector switches themes and the choice survives a reload', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  try {
    await page.goto(server.url)
    const select = (await themeSelect(page))
    await select.waitFor()
    assert.equal(await select.inputValue(), 'catppuccin-macchiato')
    let s = await rootState(page)
    assert.deepEqual([s.theme, s.dark, s.scheme, s.void], ['catppuccin-macchiato', true, 'dark', '#181926'])
    assert.equal(s.bodyBg, 'rgb(5, 5, 16)', 'the page background is the scene ground, not themed')

    // (the browser serialises #000000 as #000)
    for (const [id, voidColor] of [['graphite', '#121212'], ['midnight', '#0b0e1c'], ['ember', '#15110e'], ['anthropic', '#0e0e0d'], ['contrast', '#000'], ['catppuccin-mocha', '#11111b'], ['catppuccin-frappe', '#232634'], ['neon', '#050510']] as const) {
      await select.selectOption(id)
      s = await rootState(page)
      assert.deepEqual([s.theme, s.dark, s.scheme, s.void], [id, true, 'dark', voidColor])
      assert.equal(s.bodyBg, 'rgb(5, 5, 16)', `${id}: the page background stays the scene ground`)
    }
    await select.selectOption('graphite')

    await select.selectOption('neon')
    s = await rootState(page)
    assert.deepEqual([s.theme, s.dark, s.scheme, s.void], ['neon', true, 'dark', '#050510'])
    assert.equal(s.bodyBg, 'rgb(5, 5, 16)')

    await select.selectOption('graphite')
    await page.reload()
    await (await themeSelect(page)).waitFor()
    assert.equal(await (await themeSelect(page)).inputValue(), 'graphite')
    assert.equal((await rootState(page)).theme, 'graphite')
  } finally {
    await context.close()
  }
})

test('?theme= picks the theme when nothing is stored, and the selector reflects it', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(`${server.url}?theme=neon`)
    await (await themeSelect(page)).waitFor()
    assert.equal((await rootState(page)).theme, 'neon')
    assert.equal(await (await themeSelect(page)).inputValue(), 'neon')
  } finally {
    await context.close()
  }
})

test('a theme stored by an earlier version (dark / light / paper) maps to catppuccin-macchiato', async () => {
  for (const [stored, expected] of [['dark', 'catppuccin-macchiato'], ['light', 'catppuccin-macchiato'], ['paper', 'catppuccin-macchiato'], ['graphite', 'graphite'], ['anthropic', 'anthropic']] as const) {
    const context = await browser.newContext()
    await context.addInitScript(value => { try { localStorage.setItem('agent-lens-theme', value) } catch { /* blocked */ } }, stored)
    const page = await context.newPage()
    try {
      await page.goto(server.url)
      await (await themeSelect(page)).waitFor()
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
    const select = (await themeSelect(page))
    await select.focus()
    await page.keyboard.press('ArrowDown')
    assert.equal((await rootState(page)).theme, 'catppuccin-mocha', 'ArrowDown moves from macchiato to mocha')
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
    await page.goto(`${server.url}?theme=catppuccin-frappe`)
    await (await themeSelect(page)).waitFor()
    await page.waitForTimeout(1500)
    assert.deepEqual(errors.filter(e => /hydrat/i.test(e)), [])
    // A COLORS-based inline style (the select border) uses the Frappe overlay1 control border, not the default's
    const border = await (await themeSelect(page)).evaluate(el => getComputedStyle(el).borderTopColor)
    assert.equal(border, 'rgb(131, 139, 167)')
  } finally {
    await context.close()
  }
})
