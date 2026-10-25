// #656: cost of an attach burst on the webview side, in real Chromium (Playwright + CDP). Not run by any test.
// The production webview bundle (extension/dist/webview/index.js, `pnpm --dir web run build:webview`) is loaded in an
// iframe, as VS Code does; the parent frame posts the burst to it with window.postMessage (the last hop before the
// page), either one `agent-event` per event (before) or `agent-event-batch` of 500 marked `live` (what the panel sends
// now, extension/src/event-coalescer.ts). No port is opened by the page: requests are answered by page.route.
// Measures: post = time of the sending frame; last-dispatched = from the first post to the end of the page's last
// 'message' listener (bridge + hook); with TRACE=1, message-tasks = sum of the HandlePostMessage tasks of the trace.
// Usage: node scripts/bench/bridge-webview.mjs [events=60000] [rounds=3]   (MODES=single,batch:500,live:500 TRACE=1)
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeBurst, median, BURST_SESSION_ID } from './bridge-burst.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const N = Number(process.argv[2] ?? 60000)
const ROUNDS = Number(process.argv[3] ?? 3)
const require = createRequire(join(repo, 'web', 'package.json'))
const { chromium } = require('playwright')

const js = readFileSync(join(repo, 'extension/dist/webview/index.js'))
const css = readFileSync(join(repo, 'extension/dist/webview/index.css'))
const ORIGIN = 'http://bench.local'
const inner = `<!DOCTYPE html><html lang="en" class="dark" data-theme="catppuccin-macchiato" style="height:100%;margin:0">
<head><meta charset="UTF-8"><link rel="stylesheet" href="/index.css"><style>html,body,#root{height:100%;margin:0}</style></head>
<body><script>
window.__posted = []; window.__handlerMs = 0; window.__startAt = 0;
// Registered before the bundle: marks when a burst message enters dispatch
window.addEventListener('message', (e) => { const t = e.data && e.data.type; if (t === 'agent-event' || t === 'agent-event-batch') window.__startAt = performance.now() });
function acquireVsCodeApi() { return { postMessage: (m) => window.__posted.push(m && m.type), setState() {}, getState() {} } }
</script><div id="root"></div><script src="/index.js"></script>
<script>
// Registered after the bundle's bridge listener: it runs once the bridge (and the hook) handled the same message
window.__got = 0; window.__lastAt = 0;
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'agent-event') window.__got += 1;
  else if (d && d.type === 'agent-event-batch') window.__got += d.events.length;
  else return;
  window.__lastAt = performance.now(); window.__handlerMs += window.__lastAt - window.__startAt;
});
</script></body></html>`
const outer = `<!DOCTYPE html><html><body style="margin:0"><iframe id="f" src="/inner.html" style="width:1280px;height:800px;border:0"></iframe></body></html>`

const SID = BURST_SESSION_ID
const events = makeBurst(N)
const bytes = events.reduce((s, e) => s + JSON.stringify({ type: 'agent-event', event: e }).length, 0)
console.log(`events=${N} mean JSON size=${(bytes / N).toFixed(0)} B`)

const metric = (m, name) => m.metrics.find(x => x.name === name).value

async function run(browser, mode) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.route(`${ORIGIN}/**`, (route) => {
    const p = new URL(route.request().url()).pathname
    if (p === '/index.js') return route.fulfill({ body: js, contentType: 'text/javascript' })
    if (p === '/index.css') return route.fulfill({ body: css, contentType: 'text/css' })
    if (p === '/inner.html') return route.fulfill({ body: inner, contentType: 'text/html' })
    return route.fulfill({ body: outer, contentType: 'text/html' })
  })
  await page.goto(`${ORIGIN}/`)
  const frame = page.frames().find(f => f.url().endsWith('/inner.html'))
  await frame.waitForFunction(() => document.getElementById('root').childElementCount > 0)
  // The extension's opening messages: no mock data, one session the burst belongs to
  await page.evaluate((sid) => {
    const w = document.getElementById('f').contentWindow
    w.postMessage({ type: 'config', config: { showMockData: false, mode: 'claude' } }, '*')
    w.postMessage({ type: 'session-list', sessions: [{ id: sid, label: 'bench', status: 'active', startTime: Date.now() - 60000, lastActivityTime: Date.now() }] }, '*')
  }, SID)
  await page.waitForTimeout(1500)
  await page.evaluate((evs) => { window.__events = evs }, events)
  const cdp = await page.context().newCDPSession(page)
  const TRACE = process.env.TRACE === '1'
  if (TRACE) await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel'] }, transferMode: 'ReturnAsStream' })
  await page.waitForTimeout(300)
  const sent = await page.evaluate(({ mode }) => {
    const w = document.getElementById('f').contentWindow
    const evs = window.__events
    const t0 = performance.now()
    if (mode === 'single') for (const event of evs) w.postMessage({ type: 'agent-event', event }, '*')
    else {
      const size = Number(mode.split(':')[1])
      const live = mode.startsWith('live'); for (let i = 0; i < evs.length; i += size) w.postMessage(live ? { type: 'agent-event-batch', events: evs.slice(i, i + size), live: true } : { type: 'agent-event-batch', events: evs.slice(i, i + size) }, '*')
    }
    window.__t0 = t0
    return { postMs: performance.now() - t0, timeOrigin: performance.timeOrigin }
  }, { mode })
  await frame.waitForFunction((n) => window.__got >= n, N, { timeout: 300000, polling: 100 })
  const innerLast = await frame.evaluate(() => ({ lastAt: window.__lastAt, timeOrigin: performance.timeOrigin, handlerMs: window.__handlerMs }))
  const lastMs = innerLast.timeOrigin + innerLast.lastAt - (sent.timeOrigin + (await page.evaluate(() => window.__t0)))
  if (!TRACE) { await page.close(); return { mode, postMs: sent.postMs, lastMs, handlerMs: innerLast.handlerMs, dispatches: 0, dispatchMs: 0, tasks: 0, taskMs: 0 } }
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.end')
  const { stream } = await done
  let text = ''
  for (;;) { const r = await cdp.send('IO.read', { handle: stream, size: 1 << 22 }); text += r.base64Encoded ? Buffer.from(r.data, 'base64').toString() : r.data; if (r.eof) break }
  await cdp.send('IO.close', { handle: stream })
  const trace = JSON.parse(text)
  const evs = Array.isArray(trace) ? trace : trace.traceEvents
  if (process.env.DEBUG) { const c = {}; for (const e of evs) { const k = e.name + '|' + e.ph + '|' + (e.args?.data?.type ?? ''); c[k] = (c[k] ?? 0) + 1 } console.error(Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 30)) }
  // Each 'message' dispatch, and the top-level task that holds it (deserialization, listeners, task overhead)
  const dispatches = evs.filter(e => e.name === 'HandlePostMessage' && e.ph === 'X')
  const tasks = evs.filter(e => (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && e.ph === 'X' && e.dur)
  const byThread = new Map()
  for (const t of tasks) { const k = `${t.pid}:${t.tid}`; if (!byThread.has(k)) byThread.set(k, []); byThread.get(k).push(t) }
  for (const l of byThread.values()) l.sort((a, b) => a.ts - b.ts)
  const holding = new Set()
  for (const d of dispatches) {
    const l = byThread.get(`${d.pid}:${d.tid}`) ?? []
    let lo = 0, hi = l.length - 1, found = null
    while (lo <= hi) { const m = (lo + hi) >> 1; if (l[m].ts <= d.ts) { found = l[m]; lo = m + 1 } else hi = m - 1 }
    // walk back to the outermost task that contains it
    if (found && found.ts + found.dur >= d.ts + d.dur) holding.add(found)
  }
  const dispatchMs = dispatches.reduce((s, e) => s + e.dur, 0) / 1000
  const taskMs = [...holding].reduce((s, e) => s + e.dur, 0) / 1000
  await page.close()
  return { mode, postMs: sent.postMs, lastMs, handlerMs: innerLast.handlerMs, dispatches: dispatches.length, dispatchMs, tasks: holding.size, taskMs }
}

const browser = await chromium.launch()
browser.on('disconnected', () => console.error('browser disconnected'))
const modes = (process.env.MODES ?? 'single,batch:500,live:500').split(',')
const rows = []
for (let r = 0; r < ROUNDS; r++) for (const mode of modes) rows.push(await run(browser, mode))
await browser.close()
const f = (x) => x.toFixed(0)
console.log('mode        post(ms) last-dispatched(ms) listeners(ms) dispatches dispatch(ms) tasks task(ms)')
for (const r of rows) console.log([r.mode.padEnd(11), f(r.postMs).padStart(8), f(r.lastMs).padStart(19), f(r.handlerMs).padStart(13), String(r.dispatches).padStart(10), f(r.dispatchMs).padStart(12), String(r.tasks).padStart(5), f(r.taskMs).padStart(8)].join(' '))
const med = (k, m) => median(rows.filter(r => r.mode === m).map(r => r[k]))
console.log('median:')
for (const m of modes) console.log(`${m.padEnd(11)} post=${f(med('postMs', m))} last-dispatched=${f(med('lastMs', m))} listeners=${f(med('handlerMs', m))} dispatch=${f(med('dispatchMs', m))} message-tasks=${f(med('taskMs', m))} post+tasks=${f(med('postMs', m) + med('taskMs', m))}`)
