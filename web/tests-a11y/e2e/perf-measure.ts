// Canvas performance measurement (#216), not a test: it prints a table, it asserts nothing.
//
//   pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-measure.ts
//   E2E_BASE_URL=http://localhost:3000 pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-measure.ts
//
// Opens the demo with ?perf (the optimised loop) and ?perf=full (baseline: every frame drawn in full, no idle
// gate, no viewport culling), at rest (reduced motion, playback paused with Space) and zoomed in, and reads the
// numbers the perf overlay publishes in `window.__agentLensPerf`. See docs/performance.md.
import { chromium } from 'playwright'
import { startDemoServer } from './demo-server'

interface Snapshot { fps: number; frameMs: number; p95Ms: number; drawCalls: number; drawnFrames: number; skippedFrames: number; agents: number }

const LEVEL = process.env.PERF_STRESS ?? 'extreme'
const SETTLE_MS = Number(process.env.PERF_SETTLE_MS ?? 20_000)
const SAMPLE_MS = Number(process.env.PERF_SAMPLE_MS ?? 5_000)
const ZOOM_STEPS = Number(process.env.PERF_ZOOM_STEPS ?? 14)

async function main() {
  const external = process.env.E2E_BASE_URL
  const server = external ? null : await startDemoServer()
  const base = external ?? server!.url
  const browser = await chromium.launch()
  const rows: string[] = []
  try {
    for (const variant of ['full', 'optimised'] as const) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
      const page = await context.newPage()
      await page.goto(`${base}/?stress=${LEVEL}&perf${variant === 'full' ? '=full' : ''}`)
      await page.waitForFunction(() => !!(window as unknown as { __agentLensPerf?: unknown }).__agentLensPerf, null, { timeout: 120_000 })
      // Let the scene build, then pause the playback: nothing changes any more (a panel left open)
      await page.waitForTimeout(SETTLE_MS)
      await page.keyboard.press('Space')
      await page.waitForTimeout(2000)
      const read = () => page.evaluate(() => (window as unknown as { __agentLensPerf: Snapshot }).__agentLensPerf)
      const sample = async (label: string) => {
        const a = await read()
        // Frame-time samples: average work time over the window, from the overlay's own p95 and last frame
        const t0 = Date.now()
        const frames: number[] = []
        while (Date.now() - t0 < SAMPLE_MS) { frames.push((await read()).frameMs); await page.waitForTimeout(250) }
        const b = await read()
        const secs = SAMPLE_MS / 1000
        const avg = frames.reduce((x, y) => x + y, 0) / Math.max(1, frames.length)
        rows.push(`| ${variant} | ${label} | ${b.agents} | ${((b.drawnFrames - a.drawnFrames) / secs).toFixed(1)} | ${((b.skippedFrames - a.skippedFrames) / secs).toFixed(1)} | ${avg.toFixed(1)} | ${b.p95Ms.toFixed(1)} | ${b.drawCalls} |`)
      }
      await sample('au repos, vue d\'ensemble')
      // Zoom into one corner of the fleet with the wheel
      await page.mouse.move(320, 240)
      for (let i = 0; i < ZOOM_STEPS; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60) }
      await page.waitForTimeout(2000)
      await sample('au repos, zoomé')
      await context.close()
    }
  } finally {
    await browser.close()
    await server?.stop()
  }
  console.log('| boucle | scène | agents | images dessinées/s | images ignorées/s | temps de frame moyen (ms) | P95 (ms) | appels de dessin / frame |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const r of rows) console.log(r)
}

main().catch((e) => { console.error(e); process.exit(1) })
