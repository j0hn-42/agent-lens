// Harness for the Files & repeats panel with repeated reads (#518): the real panel drawn alone in a real browser, served by the demo
// server (same origin, route fulfilled in the browser), with the stylesheets of the demo page and an esbuild bundle of
// files-repeats-entry.tsx. Same pattern as topbar-worstcase.ts.
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright'

const WEB_DIR = path.resolve(__dirname, '..', '..')
export const HARNESS_PATH = '/__e2e-files-repeats'

let bundle: string | null = null
async function bundled(): Promise<string> {
  if (bundle) return bundle
  const esbuild = await import('esbuild')
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, 'files-repeats-entry.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser',
    tsconfig: path.join(WEB_DIR, 'tsconfig.json'), jsx: 'automatic', absWorkingDir: WEB_DIR, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_DEMO': '"1"', 'process.env.NEXT_PUBLIC_RELAY_PORT': '""' },
  })
  bundle = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  return bundle
}

/** Opens the harness in a new page of `context` (viewport and stored locale are the context's). */
export async function openFilesRepeats(context: BrowserContext, serverUrl: string, query = ''): Promise<Page> {
  const demoHtml = await (await fetch(serverUrl)).text()
  const head = [...demoHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m => m[0]).join('\n')
  if (!head) throw new Error('no stylesheet found in the demo page')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>
<body><div id="root"></div><script>${await bundled()}</script></body></html>`
  const page = await context.newPage()
  await page.route(`${serverUrl}${HARNESS_PATH}**`, route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto(`${serverUrl}${HARNESS_PATH}${query}`, { waitUntil: 'networkidle' })
  await page.locator('[data-dock-panel="files"]').waitFor()
  return page
}

/** Where the file list starts, in px from the top of the panel, and how many file rows are fully visible in the scroller. */
export const MEASURE = `(() => {
  const panel = document.querySelector('[data-dock-panel="files"]')
  const region = panel && panel.querySelector('[role="region"]')
  if (!panel || !region) return null
  const rows = [...region.querySelectorAll('li')].filter(li => li.querySelector('progress, [role="progressbar"]') || li.textContent.includes('file-'))
  const first = rows[0]
  const p = panel.getBoundingClientRect(), r = region.getBoundingClientRect()
  const visible = rows.filter(li => { const b = li.getBoundingClientRect(); return b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5 }).length
  return { panelW: Math.round(p.width), panelH: Math.round(p.height), firstFileTop: first ? Math.round(first.getBoundingClientRect().top - p.top) : null, visible, total: rows.length }
})()`

export interface Measure { panelW: number; panelH: number; firstFileTop: number | null; visible: number; total: number }
