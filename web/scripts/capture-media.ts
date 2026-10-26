// Regenerates the README media from the demo tour (docs/demo.md): the hero GIF, the tour video, three named
// captures and the "flat log vs canvas" image, all written to docs/media/.
//
//   pnpm run capture:media
//
// The demo app is started on a free port by demo-server.ts and stopped at the end, so a developer's own servers
// (3000 / 3001) are never touched. The tour plays in real time (about 90 s), so the run takes two minutes.
// Needs Chromium (`pnpm --dir web exec playwright install chromium`) and `ffmpeg` on the PATH.
// Nothing here is invented: every image is the demo's own mock data, as the page draws it.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from 'playwright'
import { startDemoServer } from '../tests-a11y/e2e/demo-server'
import { TOUR_SCENARIO } from '../lib/tour-scenario'

const OUT_DIR = path.resolve(__dirname, '..', '..', 'docs', 'media')
const VIEWPORT = { width: 1280, height: 800 }
/** Seconds of the tour kept in the video: after about 72 s every agent is finished and the canvas is empty. */
const VIDEO_SECONDS = 72
const HERO = { from: 2, seconds: 10 }

function ffmpeg(args: string[]): void {
  const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
  if (res.error || res.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed`)
}

/** The tour is time-driven: a page is only comparable to another one when it is read at the same second. */
async function openTour(page: Page, url: string): Promise<void> {
  await page.goto(`${url}/?scenario=tour`)
  // Hide the Next.js dev overlay: it is not part of the product
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
}

/** The text of a flat log of the first seconds of the tour: what the same events look like without the canvas. */
function flatLog(untilSeconds: number): string[] {
  const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  const shown = new Set(['agent_spawn', 'message', 'tool_call_start', 'tool_call_end', 'subagent_dispatch', 'subagent_return'])
  return TOUR_SCENARIO
    .filter(e => e.time <= untilSeconds && shown.has(e.type))
    .slice(0, 26)
    .map(e => {
      const p = e.payload as Record<string, unknown>
      const who = String(p.agent ?? p.name ?? p.child ?? '')
      const what = [p.tool, p.args ?? p.task ?? p.content ?? p.result].filter(Boolean).join(' ').replace(/\s+/g, ' ')
      return `${clock(e.time)}  ${e.type.padEnd(15)} ${who.padEnd(14)} ${what}`.slice(0, 96)
    })
}

function beforeAfterHtml(log: string[], canvasPng: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const img = `data:image/png;base64,${fs.readFileSync(canvasPng).toString('base64')}`
  return `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0b0c16;color:#cad3f5;font:14px system-ui,sans-serif;width:1600px}
    .wrap{display:flex;gap:24px;padding:24px}
    .pane{flex:1;display:flex;flex-direction:column;gap:10px;min-width:0}
    h2{margin:0;font-size:15px;font-weight:600;color:#a5adcb}
    pre{margin:0;background:#161826;border:1px solid #2c3050;border-radius:8px;padding:14px;height:480px;overflow:hidden;
        font:12px/1.5 ui-monospace,Menlo,monospace;color:#b8c0e0;white-space:pre}
    img{width:100%;border:1px solid #2c3050;border-radius:8px}
  </style><div class="wrap">
    <div class="pane" style="flex:.9"><h2>The same events, as a flat log</h2><pre>${esc(log.join('\n'))}</pre></div>
    <div class="pane" style="flex:1.1"><h2>The same events, in Agent Lens</h2><img src="${img}"></div>
  </div>`
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lens-media-'))
  const server = await startDemoServer()
  const browser = await chromium.launch()
  try {
    // First load compiles the pages: do it once outside the recording, so the video starts on a ready app
    const warm = await browser.newContext({ viewport: VIEWPORT })
    await openTour(await warm.newPage(), server.url)
    await warm.close()

    const ctx = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: work, size: VIEWPORT } })
    const created = Date.now()
    const page = await ctx.newPage()
    await openTour(page, server.url)
    await page.getByRole('button', { name: 'Not now' }).click()
    const t0 = Date.now()
    const videoOffset = (t0 - created) / 1000
    const at = async (s: number) => { const wait = s * 1000 - (Date.now() - t0); if (wait > 0) await page.waitForTimeout(wait) }
    const shot = (name: string) => page.screenshot({ path: path.join(OUT_DIR, name) })

    await at(11)
    await page.screenshot({ path: path.join(work, 'canvas-0011.png') })
    await at(40)
    await shot('fleet.png')
    await at(46)
    // The exchange between the two teammates: the link button opens the Conversation panel on it
    await page.getByRole('button', { name: /^Open Conversation\. Latest message/ }).click()
    await page.waitForTimeout(900)
    await shot('comms.png')
    await page.getByRole('button', { name: /Conversation/ }).first().click()
    await at(62)
    await page.getByRole('button', { name: 'Cost' }).click()
    await page.waitForTimeout(900)
    await shot('cost.png')
    await page.getByRole('button', { name: 'Cost' }).click()
    // Files & repeats: the file two agents edited (conflict), the file and the Glob read again, the command that looped
    await at(64)
    await page.getByRole('button', { name: /Files & repeats/ }).first().click()
    await page.getByText(/^Repeated reads and calls: \d+ repeated targets? observed/).click()
    await page.waitForTimeout(900)
    await shot('repeats.png')
    await at(VIDEO_SECONDS)

    const videoPath = await page.video()!.path()
    await ctx.close()

    // Video: the tour from its first second, without the loading and the empty canvas of its end
    ffmpeg(['-ss', String(videoOffset), '-t', String(VIDEO_SECONDS), '-i', videoPath,
      '-an', '-c:v', 'libx264', '-crf', '30', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      path.join(OUT_DIR, 'tour.mp4')])
    // Hero GIF, cut from that video: 720 px wide, 10 images a second, one 48-colour palette for the whole clip
    // (about 2.8 MB: GitHub shows a README GIF of that size without delay)
    const palette = path.join(work, 'palette.png')
    const clip = ['-ss', String(HERO.from), '-t', String(HERO.seconds), '-i', path.join(OUT_DIR, 'tour.mp4')]
    const filters = 'fps=10,scale=720:-1:flags=lanczos'
    ffmpeg([...clip, '-vf', `${filters},palettegen=max_colors=48`, palette])
    ffmpeg([...clip, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`, '-loop', '0', path.join(OUT_DIR, 'hero.gif')])

    // Flat log vs canvas, rendered from the demo's own events and the capture taken at 0:11
    const compare = await browser.newPage({ viewport: { width: 1600, height: 560 } })
    await compare.setContent(beforeAfterHtml(flatLog(11), path.join(work, 'canvas-0011.png')))
    await compare.screenshot({ path: path.join(OUT_DIR, 'before-after.png') })
  } finally {
    await browser.close()
    await server.stop()
    fs.rmSync(work, { recursive: true, force: true })
  }
  for (const f of fs.readdirSync(OUT_DIR).sort()) console.log(`${f}  ${(fs.statSync(path.join(OUT_DIR, f)).size / 1024).toFixed(0)} KB`)
}

main().catch(err => { console.error(err); process.exit(1) })
