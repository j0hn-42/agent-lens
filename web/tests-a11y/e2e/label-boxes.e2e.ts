// Real-font check of the agent labels of a team of 10 at the fit zoom (#593, follow-up of #378).
// scripts/canvas-label-collisions.test.ts proves the plan with a model of 0.6 to 1 em per glyph; here the REAL
// canvas of the demo (?scenario=team10: an orchestrator and nine teammates) runs in Chromium and every text
// the canvas paints is recorded with its REAL measureText (the platform's `monospace`, the font the canvas
// asks for) and the transform in force, then the boxes of the visible agent labels are compared two by two.
// Only the last complete frame counts. No dev server needed: the demo is started on a free port.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
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

export interface TextBox { text: string; font: string; x: number; y: number; w: number; h: number; alpha: number; modelW: number }

/** Plain JS string (tsx would inject a __name helper the page lacks): records the paint calls of every 2D context. */
const RECORDER = `(() => {
  const proto = CanvasRenderingContext2D.prototype
  const fill = proto.fillText
  let cur = [], last = []
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = cb => raf(t => { if (cur.length) last = cur; cur = []; cb(t) })
  proto.fillText = function (text, x, y, maxWidth) {
    try {
      const m = this.measureText(text)
      const tf = this.getTransform()
      const px = parseFloat(this.font.match(/([0-9.]+)px/)[1])
      const left = this.textAlign === 'center' ? -m.width / 2 : this.textAlign === 'right' || this.textAlign === 'end' ? -m.width : 0
      const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent
      const top = this.textBaseline === 'top' || this.textBaseline === 'hanging' ? 0 : this.textBaseline === 'middle' ? -(asc + desc) / 2 : -asc
      const dpr = window.devicePixelRatio || 1
      // the four corners go through the transform (scale and translation only in this canvas)
      const x0 = (tf.a * (x + left) + tf.e) / dpr, x1 = (tf.a * (x + left + m.width) + tf.e) / dpr
      const y0 = (tf.d * (y + top) + tf.f) / dpr, y1 = (tf.d * (y + top + asc + desc) + tf.f) / dpr
      cur.push({ text: String(text), font: this.font, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), alpha: this.globalAlpha, modelW: String(text).length * px * 0.6 * Math.abs(tf.a) / dpr })
    } catch (e) {}
    return fill.call(this, text, x, y, maxWidth)
  }
  window.__lastFrameTexts = () => last
})()`

async function openTeam(width: number, height: number): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height } })
  const page = await context.newPage()
  await page.addInitScript(RECORDER)
  await page.goto(`${server.url}/?scenario=team10`)
  await page.getByRole('button', { name: 'Files' }).waitFor()
  // the whole scenario is played within a few seconds: wait for the 10 agents to be listed
  await page.waitForFunction(
    () => (window as unknown as { __lastFrameTexts: () => TextBox[] }).__lastFrameTexts().some(t => t.text === 'performance-profiler'),
    null, { timeout: 60_000 },
  )
  return { page, close: () => context.close() }
}

/** Boxes (CSS px, viewport) of the texts of the last frame, after a fit and a settled layout. */
async function fittedTexts(page: Page): Promise<TextBox[]> {
  await page.getByRole('button', { name: 'Fit to view' }).click()
  await waitForStableLayout(page)
  // let the camera animation and the label plan settle: the boxes must be unchanged over three samples
  let prev = ''
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250)
    const cur = JSON.stringify(await page.evaluate(() => (window as unknown as { __lastFrameTexts: () => TextBox[] }).__lastFrameTexts()))
    if (cur === prev) break
    prev = cur
  }
  return page.evaluate(() => (window as unknown as { __lastFrameTexts: () => TextBox[] }).__lastFrameTexts())
}

const TEAM_NAMES = [
  'orchestrator', 'explore-agent', 'research-agent', 'security-reviewer', 'test-runner', 'migration-planner',
  'api-contract-checker', 'docs-writer', 'lint-fixer', 'performance-profiler',
]

/** Name lines of the agents; the other lines of a label are found below them, by the same font and alignment. */
const overlap = (a: TextBox, b: TextBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('control: the overlap test sees boxes that share a pixel and ignores boxes that only touch', () => {
  const box = (x: number, y: number): TextBox => ({ text: 't', font: '', x, y, w: 50, h: 13, alpha: 1, modelW: 50 })
  assert.equal(overlap(box(0, 0), box(49, 12)), true)
  assert.equal(overlap(box(0, 0), box(50, 0)), false)
  assert.equal(overlap(box(0, 0), box(0, 13)), false)
})

for (const [width, height] of [[1280, 800], [1920, 1080]] as const) {
  test(`team of 10 at the fit zoom, ${width}x${height}: no two visible labels overlap, measured with the real font`, async () => {
    const { page, close } = await openTeam(width, height)
    try {
      const all = await fittedTexts(page)
      if (process.env.LABEL_DUMP) console.log(JSON.stringify(all, null, 1))
      const visible = all.filter(t => t.alpha > 0.05 && t.w > 0 && t.x + t.w > 0 && t.y + t.h > 0 && t.x < width && t.y < height)
      // The label plan hides the labels that would collide: the test is not vacuous only if several remain visible.
      const shown = TEAM_NAMES.filter(n => visible.some(t => t.text === n))
      console.log(`${width}x${height}: ${shown.length} of ${TEAM_NAMES.length} agent labels visible (${shown.join(', ')}), ${visible.length} text boxes compared`)
      assert.ok(shown.includes('orchestrator'), 'the label of the orchestrator is visible')
      assert.ok(shown.length >= 3, `at least 3 agent labels are visible (texts: ${visible.map(t => t.text).join(' | ')})`)
      const clashes: string[] = []
      for (let i = 0; i < visible.length; i++) {
        for (let j = i + 1; j < visible.length; j++) {
          if (overlap(visible[i], visible[j])) clashes.push(`"${visible[i].text}" ${JSON.stringify([visible[i].x, visible[i].y, visible[i].w, visible[i].h].map(Math.round))} on "${visible[j].text}" ${JSON.stringify([visible[j].x, visible[j].y, visible[j].w, visible[j].h].map(Math.round))}`)
        }
      }
      assert.deepEqual(clashes, [], `${clashes.length} overlapping text boxes at ${width}x${height}`)
    } finally {
      await close()
    }
  })
}

// #594: "N names hidden" is the plan's count of the frame drawn. With the whole team framed between the bars, it must
// equal the team names the canvas did not paint in that frame (recorded with the real font, as above).
for (const [width, height] of [[1024, 768], [1280, 800], [1920, 1080]] as const) {
  test(`team of 10 at the fit zoom, ${width}x${height}: "N names hidden" equals the names not painted (#594)`, async () => {
    const { page, close } = await openTeam(width, height)
    try {
      const all = await fittedTexts(page)
      // the button reads the plan every 200 ms: give it one more read after the texts settled
      await page.waitForTimeout(400)
      const visible = all.filter(t => t.alpha > 0.05 && t.w > 0 && t.x + t.w > 0 && t.y + t.h > 0 && t.x < width && t.y < height)
      const shown = TEAM_NAMES.filter(n => visible.some(t => t.text === n || t.text.startsWith(`${n} ·`)))
      const hidden = TEAM_NAMES.length - shown.length
      assert.ok(hidden > 0, `precondition: names are hidden at ${width}x${height}`)
      const button = page.locator('[data-hidden-names]')
      assert.equal((await button.textContent())?.trim(), `${hidden} names hidden`, `painted: ${shown.join(', ')}`)
      console.log(`${width}x${height}: ${hidden} of ${TEAM_NAMES.length} names hidden, the button says "${(await button.textContent())?.trim()}"`)
      // Its name is its text, and it opens the Sessions and agents list
      await page.getByRole('button', { name: `${hidden} names hidden`, exact: true }).click()
      await page.locator('#sessions-panel').waitFor({ state: 'visible', timeout: 10_000 })
    } finally {
      await close()
    }
  })
}

test('the real monospace stays within the 0.6 to 1 em per glyph the plan models', async () => {
  const { page, close } = await openTeam(1280, 800)
  try {
    const all = await fittedTexts(page)
    const names = all.filter(t => TEAM_NAMES.includes(t.text))
    assert.ok(names.length >= 3, `name lines found: ${names.length}`)
    for (const t of names) {
      const em = t.w / (t.modelW / 0.6)
      assert.ok(em <= 1 * 1.0001 && em > 0, `"${t.text}": ${em.toFixed(3)} em per glyph in ${t.font}`)
    }
  } finally {
    await close()
  }
})
