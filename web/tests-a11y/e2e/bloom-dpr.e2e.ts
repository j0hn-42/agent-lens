// The bloom halo stays on the nodes at deviceScaleFactor 2 (#647), measured on the pixels of a real browser
// (`pnpm --dir web run test:e2e`). The draw loop leaves setTransform(dpr, 0, 0, dpr, 0, 0) on the context and the
// bloom layer is sized in backing-store pixels: without the identity transform in BloomRenderer.apply, the layer was
// composited at dpr x dpr scale, so the halo drifted away from the nodes (down and right) at dpr 2.
// The page hook wraps drawImage: when the draw loop composites the bloom layer (a detached canvas, additive) onto the
// graph canvas, it reads the canvas before and after. The bloom is blurred(canvas before), so the luminance the
// bloom added must be centred where the luminance of the canvas before it is centred. A shift of the halo moves the
// centroid of the added light away from it, and the share of the added light that stays near lit pixels drops.
// Measured on the demo (?scenario=team10, 900 x 600): share near lit pixels 0.64-0.69 with the fix at dpr 1 and 2,
// 0.19-0.40 at dpr 2 without the setTransform(1, 0, 0, 1, 0, 0) of BloomRenderer.apply (0.63 at dpr 1, the control).
// The centroid assertion would fail there too (inferred, not observed: under the mutation the `near` assertion fails
// first, so the centroid one never ran). Measured on the first sample at dpr 2 without the call (#613, 2026-10-25):
// near 0.309, centroid off by dx 0.142 and dy 0.073 of the canvas, both above the 0.03 bound; the dpr 1 control reads
// dx 0.000, dy 0.004.
// The samples are taken after 5 s, once the scene is drawn.
import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { chromium, type Browser } from 'playwright'
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

// A string so the TS transpiler injects no helper into the page.
const HOOK = `(() => {
  const S = window.__bloom = { samples: [] }
  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  const centroid = (w, h, f) => {
    let sum = 0, sx = 0, sy = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(y * w + x); sum += v; sx += v * x; sy += v * y }
    return sum > 0 ? { x: sx / sum / w, y: sy / sum / h, sum } : null
  }
  const draw = CanvasRenderingContext2D.prototype.drawImage
  CanvasRenderingContext2D.prototype.drawImage = function (img, ...rest) {
    const c = this.canvas
    const isBloom = c && c.closest && c.closest('[data-agent-canvas-root]') && this.globalCompositeOperation === 'lighter'
      && img instanceof HTMLCanvasElement && !img.isConnected && img.width < c.width / 2
    if (!isBloom || performance.now() < 5000 || S.samples.length >= 6) return draw.call(this, img, ...rest)
    const w = c.width, h = c.height
    const before = this.getImageData(0, 0, w, h).data
    const out = draw.call(this, img, ...rest)
    const after = this.getImageData(0, 0, w, h).data
    const t = this.getTransform()
    const scene = centroid(w, h, i => lum(before, i * 4))
    const added = centroid(w, h, i => Math.max(0, lum(after, i * 4) - lum(before, i * 4)))
    // Share of the added light within 3 cells (60 CSS px) of a lit cell (a node, a label, an edge) of the canvas before the bloom
    const cell = Math.round(20 * (w / c.clientWidth)), cw = Math.ceil(w / cell), ch = Math.ceil(h / cell)
    const lit = new Uint8Array(cw * ch), gain = new Float64Array(cw * ch)
    let total = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, k = Math.floor(y / cell) * cw + Math.floor(x / cell)
      if (lum(before, i * 4) > 40) lit[k] = 1
      const g = Math.max(0, lum(after, i * 4) - lum(before, i * 4)); gain[k] += g; total += g
    }
    let near = 0
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let ok = false
      for (let dy = -3; dy <= 3 && !ok; dy++) for (let dx = -3; dx <= 3 && !ok; dx++) {
        const X = cx + dx, Y = cy + dy
        if (X >= 0 && Y >= 0 && X < cw && Y < ch && lit[Y * cw + X]) ok = true
      }
      if (ok) near += gain[cy * cw + cx]
    }
    S.samples.push({ w, h, cssW: c.clientWidth, scale: t.a, scene, added, near: total > 0 ? near / total : 0, litCells: lit.reduce((a, b) => a + b, 0) })
    return out
  }
})()`

type Sample = { near: number; litCells: number; w: number; h: number; cssW: number; scale: number; scene: { x: number; y: number } | null; added: { x: number; y: number; sum: number } | null }

async function measure(dpr: number): Promise<Sample[]> {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: dpr, reducedMotion: 'no-preference' })
  try {
    const page = await context.newPage()
    await page.addInitScript(HOOK)
    await page.goto(`${server.url}/?scenario=team10`, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => ((window as unknown as { __bloom: { samples: unknown[] } }).__bloom?.samples.length ?? 0) >= 4, undefined, { timeout: 30_000 })
    return await page.evaluate(() => (window as unknown as { __bloom: { samples: Sample[] } }).__bloom.samples)
  } finally {
    await context.close()
  }
}

for (const dpr of [1, 2]) {
  test(`dpr ${dpr}: the light the bloom adds is centred on the light of the canvas, not shifted`, async () => {
    const samples = await measure(dpr)
    assert.ok(samples.length >= 4, `bloom composited at dpr ${dpr}`)
    for (const s of samples) {
      assert.equal(s.w, Math.round(s.cssW * dpr), 'the backing store has dpr pixels per CSS pixel')
      assert.ok(s.scene && s.added && s.added.sum > 0, 'the canvas has light and the bloom adds some')
      const dx = Math.abs(s.added!.x - s.scene!.x)
      const dy = Math.abs(s.added!.y - s.scene!.y)
      // Fractions of the canvas width / height.
      assert.ok(s.litCells > 5, `the canvas has lit cells (${s.litCells})`)
      assert.ok(s.near > 0.55, `dpr ${dpr}: only ${(s.near * 100).toFixed(1)} % of the bloom light falls near a lit pixel of the canvas`)
      assert.ok(dx < 0.03 && dy < 0.03, `dpr ${dpr}: halo centroid off the scene by ${dx.toFixed(3)} x ${dy.toFixed(3)} of the canvas (scene ${s.scene!.x.toFixed(3)},${s.scene!.y.toFixed(3)}, halo ${s.added!.x.toFixed(3)},${s.added!.y.toFixed(3)})`)
    }
  })
}
