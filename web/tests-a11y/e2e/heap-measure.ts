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

const text = (n: number, seed: number) => {
  // Distinct content per event (not one repeated literal): a cheap pseudo-random alphabet walk
  let s = ''
  let x = seed * 2654435761 >>> 0
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ._/-'
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; s += alphabet[x % alphabet.length] }
  return s
}

const SIZES = PROFILE === 'worst'
  ? { args: 4096, result: 4096, message: 4096, edit: 4096 }
  : { args: 80, result: 200, message: 2000, edit: 500 }

/** The events of one session: a main agent, then cycles of Edit start, Edit end, message. */
function sessionEvents(sid: string, n: number): unknown[] {
  const out: unknown[] = [{ time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true }, sessionId: sid }]
  for (let i = 1; out.length < n; i++) {
    const seed = i * 7919 + sid.length
    const id = `${sid}-t${i}`
    out.push({ time: i, type: 'tool_call_start', sessionId: sid, payload: {
      agent: 'main', tool: 'Edit', toolUseId: id, args: text(SIZES.args, seed),
      inputData: { file_path: `src/file-${i % 97}.ts`, old_string: text(SIZES.edit, seed + 1), new_string: text(SIZES.edit, seed + 2) },
    } })
    if (out.length < n) out.push({ time: i + 0.3, type: 'tool_call_end', sessionId: sid, payload: { agent: 'main', tool: 'Edit', toolUseId: id, result: text(SIZES.result, seed + 3) } })
    if (out.length < n) out.push({ time: i + 0.6, type: 'message', sessionId: sid, payload: { agent: 'main', role: 'assistant', content: text(SIZES.message, seed + 4) } })
  }
  return out
}

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

/** Posts the batches from the parent, yielding between them so the app's handlers run as with a live stream. */
async function feed(page: Page, sessionIds: string[]) {
  for (const sid of sessionIds) {
    const events = sessionEvents(sid, EVENTS_PER_SESSION)
    for (let i = 0; i < events.length; i += BATCH) {
      await page.evaluate(`(() => { document.getElementById('app').contentWindow.postMessage(${JSON.stringify({ type: 'agent-event-batch', events: events.slice(i, i + BATCH) })}, '*') })()`)
    }
  }
}

async function settle(frame: Frame) {
  // Let the frame drain its message queue: two animation frames and an idle moment
  await frame.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 500))))')
}

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
    const sample = sessionEvents('heap-s0', 300)
    const avgJson = sample.reduce<number>((a, e) => a + JSON.stringify(e).length, 0) / sample.length

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
    console.log('| étape | tas JS utilisé (Mo) | instantané (Mo) |')
    console.log('|---|---|---|')
    const snapCell = (v: number | null) => (v === null ? '-' : mb(v))
    console.log(`| avant le flux | ${mb(before)} | ${snapCell(snapBefore)} |`)
    console.log(`| buffers pleins | ${mb(filled)} | ${snapCell(snapFilled)} |`)
    console.log(`| après reset | ${mb(after)} | ${snapCell(snapAfter)} |`)
    console.log(`retenu par les buffers (pleins - reset) : ${mb(filled - after)} Mo ; croissance (pleins - avant) : ${mb(filled - before)} Mo`)
    const kept = Math.min(total, SESSIONS * 5000)
    console.log(`par event retenu (${kept} events au plus dans les buffers par session) : ${((filled - after) / kept).toFixed(0)} octets`)
  } finally {
    await browser.close()
    await server?.stop()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
