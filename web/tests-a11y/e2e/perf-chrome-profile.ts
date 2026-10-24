// Chrome profile of the canvas under load while a node is hovered (#661), not a test: it prints a table, it asserts
// nothing, and CI does not run it (it is not a *.e2e.ts file).
//
//   # This tree's demo, started for you (port taken in a private network namespace)
//   unshare -rn sh -c 'ip link set lo up; pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-chrome-profile.ts'
//   # Several builds already served (before/after): label=url pairs, profiled in alternation
//   PROFILE_TARGETS=before=http://127.0.0.1:3100,after=http://127.0.0.1:3300 pnpm --dir web exec node --import tsx tests-a11y/e2e/perf-chrome-profile.ts
//
// For each target, device pixel ratio and run: the app is embedded like a VS Code webview (the bridge only listens
// to its parent frame), fed one session of PROFILE_AGENTS agents (a main agent and its sub-agents, each with a
// running tool, so all are active and drawn at full rate), left to settle, then a node is hovered (the pointer
// moves 1 px back and forth over it, the tooltip stays shown) while a DevTools trace is recorded through CDP
// (devtools.timeline categories) and Performance.getMetrics is read before and after. chrome-trace-summary.ts
// turns the trace into numbers: frames, forced layouts ("Forced reflow"), Layout, Paint, RasterTask, style.
// Medians over PROFILE_RUNS runs are printed; PROFILE_OUT=<dir> also keeps each trace and a JSON of every run.
import fs from 'node:fs'
import path from 'node:path'
import { chromium, type Browser, type CDPSession, type Frame, type Page } from 'playwright'
import { startDemoServer } from './demo-server'
import { postWhenListening } from './bridge-ready'
import { summarizeTrace, type TraceEvent, type TraceSummary } from './chrome-trace-summary'

const AGENTS = Number(process.env.PROFILE_AGENTS ?? 150)
const RUNS = Number(process.env.PROFILE_RUNS ?? 3)
const DPRS = (process.env.PROFILE_DPR ?? '1,2').split(',').map(Number)
const SETTLE_MS = Number(process.env.PROFILE_SETTLE_MS ?? 8000)
const SAMPLE_MS = Number(process.env.PROFILE_SAMPLE_MS ?? 5000)
const ZOOM_STEPS = Number(process.env.PROFILE_ZOOM_STEPS ?? 14)
const OUT = process.env.PROFILE_OUT
const VIEWPORT = { width: 1280, height: 800 }
const CATEGORIES = [
  'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'toplevel', 'v8.execute', 'blink.user_timing',
]
const METRICS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'] as const

interface Hovered { x: number; y: number; title: string }
interface PerfSnapshot { frameMs: number; p95Ms: number; drawCalls: number; agents: number; toolCalls: number }
interface Run {
  target: string; scene: 'overview' | 'zoomed'; dpr: number; run: number; hovered: string; tooltipShownRatio: number
  overlay: PerfSnapshot; metrics: Record<(typeof METRICS)[number], number>; trace: TraceSummary
}

const session = { id: 'perf', label: 'perf-661', status: 'active', startTime: Date.now() - 1000, lastActivityTime: Date.now(), workspace: '/w/perf', runtime: 'claude' }
const event = (time: number, type: string, payload: Record<string, unknown>) => ({ type: 'agent-event', event: { time, type, sessionId: 'perf', payload } })

/** One main agent and AGENTS-1 sub-agents, each with a running tool: every agent is active, none is finished. */
function fleetEvents(): unknown[] {
  const out: unknown[] = [event(1, 'agent_spawn', { name: 'main', isMain: true, task: 'Profile the canvas' })]
  for (let i = 1; i < AGENTS; i++) {
    const name = `worker-${i}`
    // Dispatched like a real sub-agent: the prompt is a message on the link, so the edge bubbles and their buttons exist
    out.push(event(1 + i * 0.01, 'subagent_dispatch', { parent: 'main', child: name, toolUseId: `toolu_${name}`, task: `Task ${i}` }))
    out.push(event(1 + i * 0.01, 'agent_spawn', { name, parent: 'main', toolUseId: `toolu_${name}`, task: `Task ${i}` }))
    out.push(event(1.2 + i * 0.01, 'context_update', { agent: name, tokens: 1800 + i * 300, breakdown: { systemPrompt: 1400, userMessages: 400, toolResults: i * 300, reasoning: 0, subagentResults: 0 } }))
    out.push(event(1.5 + i * 0.01, 'tool_call_start', { agent: name, tool: 'Read', args: `src/file-${i}.ts`, toolUseId: `toolu_${i}` }))
  }
  return out
}

async function openApp(browser: Browser, base: string, dpr: number): Promise<{ host: Page; app: Frame; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr })
  const host = await context.newPage()
  await host.route(`${base}/__profile_host`, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>host</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style><iframe id="app" src="${base}/?perf"></iframe>`,
  }))
  await host.goto(`${base}/__profile_host`)
  const app = (await (await host.locator('#app').elementHandle())!.contentFrame())!
  await postWhenListening(host, [{ type: 'config', showMockData: false }, { type: 'session-list', sessions: [session] }])
  await app.getByRole('button', { name: /^Sessions: perf-661/ }).waitFor({ timeout: 60_000 })
  // The bridge already answered: the fleet is posted directly (postWhenListening waits for a first answer)
  await host.evaluate((msgs) => { const w = (document.getElementById('app') as HTMLIFrameElement).contentWindow!; for (const m of msgs) w.postMessage(m, '*') }, fleetEvents())
  await app.waitForFunction((n) => {
    const p = (window as unknown as { __agentLensPerf?: { agents: number } }).__agentLensPerf
    return !!p && p.agents >= n
  }, AGENTS, { timeout: 60_000 })
  return { host, app, close: () => context.close() }
}

const readPerf = (app: Frame) => app.evaluate(() => (window as unknown as { __agentLensPerf: PerfSnapshot }).__agentLensPerf)

/** The canvas tooltip (the only aria-hidden element whose inline visibility the draw loop sets), after two frames. */
const tooltipState = (app: Frame) => app.evaluate(() => new Promise<{ shown: boolean; title: string }>((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[data-sensitive][aria-hidden="true"]')].find(e => e.style.visibility !== '')
    resolve({ shown: el?.style.visibility === 'visible', title: el?.firstElementChild?.textContent ?? '' })
  }))
}))

/** Spiral out from the centre of the viewport until the pointer is over a node (its tooltip shows). */
async function findNode(host: Page, app: Frame): Promise<Hovered> {
  const cx = VIEWPORT.width / 2, cy = VIEWPORT.height / 2
  for (let r = 0; r < 360; r += 12) {
    const steps = Math.max(1, Math.round((2 * Math.PI * r) / 12))
    for (let k = 0; k < steps; k++) {
      const x = Math.round(cx + r * Math.cos((2 * Math.PI * k) / steps)), y = Math.round(cy + r * Math.sin((2 * Math.PI * k) / steps))
      await host.mouse.move(x, y)
      const t = await tooltipState(app)
      if (t.shown) return { x, y, title: t.title }
    }
  }
  throw new Error('no node found under the pointer')
}

async function readStream(cdp: CDPSession, handle: string): Promise<string> {
  const chunks: string[] = []
  for (;;) {
    const r = await cdp.send('IO.read', { handle, size: 1 << 20 })
    chunks.push(r.base64Encoded ? Buffer.from(r.data, 'base64').toString('utf8') : r.data)
    if (r.eof) break
  }
  await cdp.send('IO.close', { handle })
  return chunks.join('')
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics: list } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(list.map(m => [m.name, m.value]))
}

async function trace(host: Page, app: Frame, node: { x: number; y: number }, file: string | null) {
  const cdp = await host.context().newCDPSession(host)
  await cdp.send('Performance.enable')
  const m0 = await metrics(cdp)
  const done = new Promise<string>(resolve => cdp.once('Tracing.tracingComplete', e => resolve(e.stream!)))
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: CATEGORIES, recordMode: 'recordContinuously' }, transferMode: 'ReturnAsStream' })
  const t0 = Date.now()
  let checks = 0, shown = 0, i = 0
  // The pointer moves 1 px back and forth over the node: pointer events keep coming, the tooltip stays on it
  while (Date.now() - t0 < SAMPLE_MS) {
    await host.mouse.move(node.x + (i++ % 2), node.y)
    await host.waitForTimeout(30)
    if (i % 10 === 0) { checks++; if ((await tooltipState(app)).shown) shown++ }
  }
  await cdp.send('Tracing.end')
  const raw = await readStream(cdp, await done)
  const m1 = await metrics(cdp)
  await cdp.detach()
  if (file) fs.writeFileSync(file, raw)
  const parsed = JSON.parse(raw) as { traceEvents?: TraceEvent[] } | TraceEvent[]
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents ?? []
  const delta = Object.fromEntries(METRICS.map(k => [k, (m1[k] ?? 0) - (m0[k] ?? 0)])) as Run['metrics']
  return { tooltipShownRatio: checks ? shown / checks : 0, metrics: delta, trace: summarizeTrace(events) }
}

/** Overview (the whole fleet fitted, agent details hidden by the zoom), then zoomed on the hovered node (details drawn). */
async function profileOnce(browser: Browser, target: string, base: string, dpr: number, run: number): Promise<Run[]> {
  const { host, app, close } = await openApp(browser, base, dpr)
  const out: Run[] = []
  try {
    await host.waitForTimeout(SETTLE_MS)
    // The tour offer covers part of the canvas: declined when it shows (same in every build)
    const notNow = app.getByRole('button', { name: 'Not now' })
    if (await notNow.isVisible()) await notNow.click()
    let node = null as Hovered | null
    for (const scene of ['overview', 'zoomed'] as const) {
      if (scene === 'zoomed') {
        // Ctrl + wheel zooms around the pointer (a plain wheel pans): the node stays under it
        await host.keyboard.down('Control')
        for (let i = 0; i < ZOOM_STEPS; i++) { await host.mouse.wheel(0, -100); await host.waitForTimeout(60) }
        await host.keyboard.up('Control')
        await host.waitForTimeout(1500)
      }
      // After the zoom the same node is kept when it is still under the pointer, else another one is looked for
      const prev = node
      const still: { shown: boolean; title: string } | null = prev ? await tooltipState(app) : null
      node = prev && still?.shown ? { x: prev.x, y: prev.y, title: still.title } : await findNode(host, app)
      const file = OUT ? path.join(OUT, `trace-${target}-${scene}-dpr${dpr}-run${run}.json`) : null
      if (OUT) await host.screenshot({ path: path.join(OUT, `shot-${target}-${scene}-dpr${dpr}-run${run}.png`) })
      const r = await trace(host, app, node, file)
      out.push({ target, scene, dpr, run, hovered: node.title, overlay: await readPerf(app), ...r })
    }
  } finally { await close() }
  return out
}

const median = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b)
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null
}
const fmt = (n: number | null, d = 2) => (n === null ? 'n/a' : n.toFixed(d))

function table(runs: Run[], targets: string[]): string {
  const rows = [
    '| scene | build | dpr | agents | frames | rAF interval (ms) | rAF callback mean / p95 (ms) | main thread busy (ms/s) | forced Layout / frame | forced style recalc / frame | Layout ms / frame | Style ms / frame | Paint ms / frame | Raster ms / frame | LayoutCount (getMetrics) | tooltip shown |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const scene of ['overview', 'zoomed'] as const) for (const dpr of DPRS) for (const t of targets) {
    const rs = runs.filter(r => r.target === t && r.dpr === dpr && r.scene === scene)
    if (!rs.length) continue
    const f = (pick: (r: Run) => number | null) => median(rs.map(pick))
    rows.push(`| ${scene} | ${t} | ${dpr} | ${f(r => r.overlay.agents)} | ${f(r => r.trace.frames)} | ${fmt(f(r => r.trace.frameIntervalMs.mean))} | ${fmt(f(r => r.trace.frameMs.mean))} / ${fmt(f(r => r.trace.frameMs.p95))} | ${fmt(f(r => r.trace.mainBusy.ms / (SAMPLE_MS / 1000)), 0)} | ${fmt(f(r => r.trace.forcedLayoutsPerFrame))} | ${fmt(f(r => r.trace.forcedStyleRecalcsPerFrame))} | ${fmt(f(r => r.trace.perFrameMs.layout), 3)} | ${fmt(f(r => r.trace.perFrameMs.styleRecalc), 3)} | ${fmt(f(r => r.trace.perFrameMs.paint), 3)} | ${fmt(f(r => r.trace.perFrameMs.raster), 3)} | ${f(r => r.metrics.LayoutCount)} | ${fmt(f(r => r.tooltipShownRatio))} |`)
  }
  return rows.join('\n')
}

async function main() {
  const spec = process.env.PROFILE_TARGETS
  const server = spec ? null : await startDemoServer()
  const targets: [string, string][] = spec
    ? spec.split(',').map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)] as [string, string] })
    : [['current', server!.url]]
  if (OUT) fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const version = browser.version()
  const runs: Run[] = []
  try {
    for (let run = 0; run < RUNS; run++) for (const dpr of DPRS) {
      // Alternate the order so neither build always runs first (warm caches, thermal state)
      const order = run % 2 ? [...targets].reverse() : targets
      for (const [label, url] of order) {
        for (const r of await profileOnce(browser, label, url, dpr, run)) {
          console.error(`${label} ${r.scene} dpr=${dpr} run=${run}: ${r.trace.frames} frames, ${r.trace.forcedLayouts.count} forced layouts, ${r.trace.forcedStyleRecalcs.count} forced style recalcs, hovered "${r.hovered}"`)
          runs.push(r)
        }
      }
    }
  } finally {
    await browser.close()
    await server?.stop()
  }
  if (OUT) fs.writeFileSync(path.join(OUT, 'runs.json'), JSON.stringify(runs, null, 2))
  console.log(`Chromium ${version}, viewport ${VIEWPORT.width}x${VIEWPORT.height}, ${AGENTS} agents, ${RUNS} runs, ${SAMPLE_MS} ms traced while hovering; medians.`)
  console.log(table(runs, targets.map(t => t[0])))
}

main().catch((e) => { console.error(e); process.exit(1) })
