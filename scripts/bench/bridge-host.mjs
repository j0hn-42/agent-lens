// #656: extension host side of the panel bridge, in Node (the V8 of the extension host). Not run by any test.
// `before`: what VisualizerPanel.sendEvent did, one webview.postMessage({ type: 'agent-event' }) per event.
// `after`: the real EventCoalescer of extension/src/event-coalescer.ts, as sendEvent uses it now (buffer, batches of
// PANEL_EVENT_BATCH_MAX marked `live`; the last partial batch is flushed as its 16 ms timer would).
// What webview.postMessage costs is modeled: VS Code serializes the message to JSON in the extension host, wraps that
// string in an RPC call (JSON again), and the renderer parses both before handing it to the webview.
// Usage: node --import tsx scripts/bench/bridge-host.mjs [events=60000] [rounds=7]
import { makeBurst, median } from './bridge-burst.mjs'
import * as coalescer from '../../extension/src/event-coalescer.ts'

// The extension package is CommonJS: its exports arrive on `default` under the ESM loader
const { EventCoalescer } = coalescer.EventCoalescer ? coalescer : coalescer.default

const N = Number(process.argv[2] ?? 60000)
const ROUNDS = Number(process.argv[3] ?? 7)
const events = makeBurst(N)

/** webview.postMessage, extension host half: serializeWebviewMessage, then the RPC call that carries it */
function hostSerialize(message, wire) {
  wire.push(JSON.stringify([7, '$postMessage', ['webview-handle-0001', JSON.stringify(message), []]]))
}

function once(mode) {
  const wire = []
  let t = performance.now()
  if (mode === 'before') {
    for (const event of events) hostSerialize({ type: 'agent-event', event }, wire)
  } else {
    const c = new EventCoalescer({ post: (m) => hostSerialize(m, wire), schedule: () => 1, cancel: () => {} })
    for (const event of events) c.push(event)
    c.flush()
  }
  const host = performance.now() - t
  t = performance.now()
  let got = 0
  for (const w of wire) {
    const m = JSON.parse(JSON.parse(w)[2][1])
    got += m.type === 'agent-event' ? 1 : m.events.length
  }
  const renderer = performance.now() - t
  if (got !== N) throw new Error(`${mode}: ${got} events received, ${N} sent`)
  return { mode, messages: wire.length, host, renderer, bytes: wire.reduce((s, w) => s + w.length, 0) }
}

const modes = ['before', 'after']
for (const m of modes) once(m) // warm-up
const rows = []
for (let r = 0; r < ROUNDS; r++) for (const m of modes) rows.push(once(m))
console.log(`node ${process.version}, events=${N}, rounds=${ROUNDS} (median, min-max)`)
for (const m of modes) {
  const rr = rows.filter(r => r.mode === m)
  const span = (k) => `${median(rr.map(r => r[k])).toFixed(0)} ms (${Math.min(...rr.map(r => r[k])).toFixed(0)}-${Math.max(...rr.map(r => r[k])).toFixed(0)})`
  console.log(`${m.padEnd(6)} messages=${String(rr[0].messages).padStart(6)} host=${span('host')} renderer=${span('renderer')} wire=${(rr[0].bytes / 1e6).toFixed(1)} MB`)
}
