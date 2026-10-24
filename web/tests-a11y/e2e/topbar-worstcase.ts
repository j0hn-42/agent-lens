// Harness for the worst case of the top bar (#500): the real TopBar drawn alone in a real browser with an attention counter,
// a scope selector and the Hide inactive toggle (#372) at once, which the demo never shows (no relay link, no finished session).
// The page is served by the demo server (same origin, route fulfilled in the browser), takes its stylesheets from the demo page
// (Tailwind compiled from the same sources) and its script from an esbuild bundle of topbar-worstcase-entry.tsx.
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright'

const WEB_DIR = path.resolve(__dirname, '..', '..')
export const HARNESS_PATH = '/__e2e-topbar-worstcase'

let bundle: string | null = null
async function bundled(): Promise<string> {
  if (bundle) return bundle
  const esbuild = await import('esbuild')
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, 'topbar-worstcase-entry.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser',
    tsconfig: path.join(WEB_DIR, 'tsconfig.json'), jsx: 'automatic', absWorkingDir: WEB_DIR, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_DEMO': '"1"', 'process.env.NEXT_PUBLIC_RELAY_PORT': '""' },
  })
  bundle = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  return bundle
}

/** Opens the harness in a new page of `context` (viewport and locale are the context's). */
export async function openWorstCase(context: BrowserContext, serverUrl: string, query = ''): Promise<Page> {
  const demoHtml = await (await fetch(serverUrl)).text()
  const head = [...demoHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m => m[0]).join('\n')
  if (!head) throw new Error('no stylesheet found in the demo page')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>
<body><div id="root"></div><script>${await bundled()}</script></body></html>`
  const page = await context.newPage()
  await page.route(`${serverUrl}${HARNESS_PATH}**`, route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto(`${serverUrl}${HARNESS_PATH}${query}`, { waitUntil: 'networkidle' })
  await page.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor()
  return page
}
