// Memory held by the client event buffers (#659), not a test: it prints a table, it asserts nothing.
//
//   unshare -rn sh -c 'ip link set lo up; pnpm --dir web exec node --import tsx tests-a11y/e2e/heap-measure.ts'
//   HEAP_PROFILE=worst HEAP_SNAPSHOT=/tmp/659 ... (writes one .heapsnapshot per step there)
//
// Embeds the demo app in a frame fed by its parent like a VS Code webview (as in truncation-dismiss.e2e.ts), then
// fills every client buffer of the bridge: 50 sessions (SESSION_BUFFER_MAX_SESSIONS) of 5200 events each, past
// the 5000 cap of a session buffer (SESSION_BUFFER_MAX_EVENTS), so the 'All' buffer (MAX_ALL_BUFFER, 50 000) is
// full too. The events are posted with postMessage, so each one is a structured clone: no string is shared
// between two events, as with a real extension. The JS heap of the app's frame is read through CDP after a
// forced GC: before the feed, after it, and after a `reset` (which empties the buffers, as the extension does
// when the panel reopens). The drop at the reset is what the buffers retained.
//
// Two payload profiles:
// - real: the caps of the extension's transcript parser (ARGS_MAX 80, RESULT_MAX 200, MESSAGE_MAX 2000,
//   EDIT_CONTENT_MAX 500 for each side of an Edit), one tool call (start + end) and one message per cycle;
// - worst: every free-text field at the normalizer cap (NORM_TEXT_MAX 4096), which no parser path emits today.
import { chromium, type CDPSession, type Frame, type Page } from 'playwright'
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { startDemoServer } from './demo-server'
import { postWhenListening } from './bridge-ready'

const SESSIONS = Number(process.env.HEAP_SESSIONS ?? 50)
const EVENTS_PER_SESSION = Number(process.env.HEAP_EVENTS_PER_SESSION ?? 5200)
const PROFILE = (process.env.HEAP_PROFILE ?? 'real') as 'real' | 'worst'
const SNAPSHOT_DIR = process.env.HEAP_SNAPSHOT
const BATCH = 500

const SIZES = PROFILE === 'worst'
  ? { args: 4096, result: 4096, message: 4096, edit: 4096 }
  : { args: 80, result: 200, message: 2000, edit: 500 }

// The generator runs in the parent page (plain JS in a string, so no transpiler helper is injected): the events
// are built where they are posted, and only a few numbers cross the CDP connection.
const GENERATOR = `
window.__heapText = (n, seed) => {
  // Distinct content per event (not one repeated literal): a cheap pseudo-random alphabet walk
  let s = ''
  let x = (seed * 2654435761) >>> 0
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ._/-'
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; s += alphabet[x % alphabet.length] }
  return s
}
// The events of one session: a main agent, then cycles of Edit start, Edit end, message
window.__heapEvents = (sid, n, sizes) => {
  const text = window.__heapText
  const out = [{ time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true }, sessionId: sid }]
  for (let i = 1; out.length < n; i++) {
    const seed = i * 7919 + sid.length
    const id = sid + '-t' + i
    out.push({ time: i, type: 'tool_call_start', sessionId: sid, payload: {
      agent: 'main', tool: 'Edit', toolUseId: id, args: text(sizes.args, seed),
      inputData: { file_path: 'src/file-' + (i % 97) + '.ts', old_string: text(sizes.edit, seed + 1), new_string: text(sizes.edit, seed + 2) },
    } })
    if (out.length < n) out.push({ time: i + 0.3, type: 'tool_call_end', sessionId: sid, payload: { agent: 'main', tool: 'Edit', toolUseId: id, result: text(sizes.result, seed + 3) } })
    if (out.length < n) out.push({ time: i + 0.6, type: 'message', sessionId: sid, payload: { agent: 'main', role: 'assistant', content: text(sizes.message, seed + 4) } })
  }
  return out
}
// Posts one session in batches, yielding between them so the app's handlers run as with a live stream
window.__heapFeed = async (sid, n, sizes, batch) => {
  const win = document.getElementById('app').contentWindow
  const events = window.__heapEvents(sid, n, sizes)
  for (let i = 0; i < events.length; i += batch) {
    win.postMessage({ type: 'agent-event-batch', events: events.slice(i, i + batch) }, '*')
    await new Promise(r => setTimeout(r, 0))
  }
}
window.__heapAvgJson = (n, sizes) => {
  const ev = window.__heapEvents('heap-s0', n, sizes)
  return ev.reduce((a, e) => a + JSON.stringify(e).length, 0) / ev.length
}
`

async function heapUsed(cdp: CDPSession): Promise<number> {
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage')
  const { usedSize } = await cdp.send('Runtime.getHeapUsage') as { usedSize: number }
  return usedSize
}

async function snapshot(cdp: CDPSession, name: string): Promise<number | null> {
  if (!SNAPSHOT_DIR) return null
  const file = join(SNAPSHOT_DIR, `${PROFILE}-${name}.heapsnapshot`)
  const fd = openSync(file, 'w')
  const onChunk = (p: { chunk: string }) => { writeSync(fd, p.chunk) }
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk)
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk)
  closeSync(fd)
  // Total self size of the snapshot's nodes (what DevTools shows as the snapshot size). The file can pass the
  // longest string V8 parses: only the `nodes` array is read, from the bytes between its markers.
  const raw = readFileSync(file)
  const head = raw.subarray(0, 4096).toString('utf8')
  const fields = JSON.parse(/"node_fields":(\[[^\]]*\])/.exec(head)![1]) as string[]
  const start = raw.indexOf('"nodes":[') + '"nodes":['.length
  const end = raw.indexOf(']', start)
  const selfIdx = fields.indexOf('self_size')
  let total = 0
  let field = 0
  let num = 0
  for (let i = start; i <= end; i++) {
    const c = raw[i]
    if (c >= 48 && c <= 57) { num = num * 10 + (c - 48); continue }
    if (c === 44 || c === 93) { if (field === selfIdx) total += num; field = (field + 1) % fields.length; num = 0 }
  }
  return total
}

async function feed(page: Page, sessionIds: string[]) {
  for (const sid of sessionIds) {
    await page.evaluate(`window.__heapFeed(${JSON.stringify(sid)}, ${EVENTS_PER_SESSION}, ${JSON.stringify(SIZES)}, ${BATCH})`)
  }
}

async function settle(frame: Frame) {
  // Let the frame drain its message queue: two animation frames and an idle moment
  await frame.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 500))))')
}

/** Mio (1024^2 bytes), like the caps of the buffers */
const mb = (b: number) => (b / 1024 / 1024).toFixed(1)

async function main() {
  const external = process.env.E2E_BASE_URL
  const server = external ? null : await startDemoServer()
  const base = external ?? server!.url
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.setContent(`<!doctype html><html lang="en"><head><title>frame</title></head><body style="margin:0">
      <iframe id="app" title="Agent Lens" src="${base}" style="border:0;width:100vw;height:100vh;display:block"></iframe></body></html>`)
    await page.evaluate(GENERATOR)
    const frame = (await (await page.$('#app'))!.contentFrame())!
    await frame.locator('header').getByRole('button', { name: /^Sessions/ }).waitFor({ timeout: 120_000 })
    const now = Date.now()
    const sessionIds = Array.from({ length: SESSIONS }, (_, i) => `heap-s${i}`)
    await postWhenListening(page, [{ type: 'session-list', sessions: sessionIds.map((id, i) => ({ id, label: `heap ${i}`, status: 'active', startTime: now, lastActivityTime: now })) }])
    // The app frame is cross-site (about:blank parent): it may run in its own renderer, so attach CDP to it
    let target = 'cadre de l\'app'
    const cdp = await page.context().newCDPSession(frame).catch(() => { target = 'page parente (même processus)'; return page.context().newCDPSession(page) })
    await settle(frame)

    const before = await heapUsed(cdp)
    const snapBefore = await snapshot(cdp, 'before')
    const avgJson = await page.evaluate(`window.__heapAvgJson(300, ${JSON.stringify(SIZES)})`) as number

    const t0 = Date.now()
    await feed(page, sessionIds)
    await settle(frame)
    const feedS = (Date.now() - t0) / 1000
    const filled = await heapUsed(cdp)
    const snapFilled = await snapshot(cdp, 'filled')

    await page.evaluate(`document.getElementById('app').contentWindow.postMessage({ type: 'reset', reason: 'panel-reopened' }, '*')`)
    await settle(frame)
    const after = await heapUsed(cdp)
    const snapAfter = await snapshot(cdp, 'reset')

    const total = SESSIONS * EVENTS_PER_SESSION
    console.log(`profil ${PROFILE} : ${SESSIONS} sessions x ${EVENTS_PER_SESSION} events = ${total} events postés en ${feedS.toFixed(0)} s, JSON moyen ${avgJson.toFixed(0)} car./event`)
    console.log(`tas lu par CDP sur : ${target}`)
    console.log('| étape | tas JS utilisé (Mio) | instantané (Mio) |')
    console.log('|---|---|---|')
    const snapCell = (v: number | null) => (v === null ? '-' : mb(v))
    console.log(`| avant le flux | ${mb(before)} | ${snapCell(snapBefore)} |`)
    console.log(`| buffers pleins | ${mb(filled)} | ${snapCell(snapFilled)} |`)
    console.log(`| après reset | ${mb(after)} | ${snapCell(snapAfter)} |`)
    console.log(`retenu par les buffers (pleins - reset) : ${mb(filled - after)} Mio ; croissance (pleins - avant) : ${mb(filled - before)} Mio`)
  } finally {
    await browser.close()
    await server?.stop()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
