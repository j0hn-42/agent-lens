// Harness for the Context panel (#599): the real ProjectContextPanel drawn alone in a real browser, served by the demo server (same
// origin, route fulfilled in the browser), with the stylesheets of the demo page and an esbuild bundle of context-panel-entry.tsx.
// The relay answer of GET /issue-links?scope=session is fulfilled by the harness (3 PRs: long branch, draft, failing checks).
// Same pattern as files-repeats.ts.
import path from 'node:path'
import type { BrowserContext, Page } from 'playwright'

const WEB_DIR = path.resolve(__dirname, '..', '..')
export const HARNESS_PATH = '/__e2e-context-panel'
export const PANEL = '[data-dock-panel="files"]'

let bundle: string | null = null
async function bundled(): Promise<string> {
  if (bundle) return bundle
  const esbuild = await import('esbuild')
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, 'context-panel-entry.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser',
    tsconfig: path.join(WEB_DIR, 'tsconfig.json'), jsx: 'automatic', absWorkingDir: WEB_DIR, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_DEMO': '"1"', 'process.env.NEXT_PUBLIC_RELAY_PORT': '""' },
  })
  bundle = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  return bundle
}

const REPO = 'https://github.com/j0hn-42/agent-lens'
const check = (state: string, total: number, failing: number, pending: number) => ({ state, total, failing, pending })
export const WORK = {
  repo: REPO,
  prs: [
    { number: 599, title: 'Reflow en français du panneau Contexte vérifié à 320 px', url: `${REPO}/pull/599`, branch: 'fix/599-reflow-contexte-tres-long-nom-de-branche', checks: check('passing', 12, 0, 0) },
    { number: 612, title: 'Brouillon: refonte de la barre de session', url: `${REPO}/pull/612`, branch: 'feat/612-barre', draft: true, checks: check('failing', 12, 3, 1) },
    { number: 7, title: 'Mise à jour', url: `${REPO}/pull/7`, branch: 'docs/7', checks: check('pending', 4, 0, 2) },
    // A branch with no hyphen, slash or space: no break opportunity, so only `break-all` keeps it inside the table at 320 px
    // (#613: the branches above can wrap at their hyphens, and the test stayed green without `break-all`)
    { number: 8, title: 'Sans tiret', url: `${REPO}/pull/8`, branch: 'refactorauthenticationmiddlewareforsessionstore', checks: check('passing', 2, 0, 0) },
  ],
  issues: [{ number: 130, title: 'Un titre d’issue assez long pour passer à la ligne dans un panneau étroit', url: `${REPO}/issues/130` }],
  prsTruncated: false,
  issuesTruncated: false,
}

/** Opens the harness in a new page of `context` (viewport and stored locale are the context's). */
export async function openContextPanel(context: BrowserContext, serverUrl: string): Promise<Page> {
  const demoHtml = await (await fetch(serverUrl)).text()
  const head = [...demoHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m => m[0]).join('\n')
  if (!head) throw new Error('no stylesheet found in the demo page')
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>
<body><div id="root"></div><script>${await bundled()}</script></body></html>`
  const page = await context.newPage()
  await page.route(`${serverUrl}${HARNESS_PATH}**`, route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.route(`${serverUrl}/issue-links**`, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(WORK) }))
  await page.goto(`${serverUrl}${HARNESS_PATH}`, { waitUntil: 'networkidle' })
  await page.locator(PANEL).waitFor()
  await page.locator('[data-testid="session-work"] table').waitFor()
  return page
}

/** Boxes of the Branch / Pull request / Checks table, in px, to prove it is readable. */
export const MEASURE_TABLE = `(() => {
  const panel = document.querySelector('[data-dock-panel="files"]')
  const table = panel && panel.querySelector('[data-testid="session-work"] table')
  if (!panel || !table) return null
  const p = panel.getBoundingClientRect(), t = table.getBoundingClientRect()
  const heads = [...table.querySelectorAll('th')].map(th => { const r = th.getBoundingClientRect(); return { text: th.textContent.trim(), w: Math.round(r.width), cut: th.scrollWidth > th.clientWidth + 1 } })
  const cells = [...table.querySelectorAll('tbody td')].map(td => { const r = td.getBoundingClientRect(); return { w: Math.round(r.width), cut: td.scrollWidth > td.clientWidth + 1 } })
  const scroller = document.querySelector('[data-testid="session-work"]').parentElement
  return { panelW: Math.round(p.width), tableW: Math.round(t.width), tableRight: Math.round(t.right), panelRight: Math.round(p.right), heads, cells,
    scrollerScrollW: scroller.scrollWidth, scrollerClientW: scroller.clientWidth }
})()`

export interface TableMeasure {
  panelW: number; tableW: number; tableRight: number; panelRight: number
  heads: Array<{ text: string; w: number; cut: boolean }>; cells: Array<{ w: number; cut: boolean }>
  scrollerScrollW: number; scrollerClientW: number
}
