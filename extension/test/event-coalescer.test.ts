/**
 * The panel's events in batches (#656): VisualizerPanel.sendEvent buffered them one window (16 ms) and sends what came
 * meanwhile as one `agent-event-batch` marked `live`, a lone event as the `agent-event` it always was. Any other
 * message flushes the buffer first, so the page receives everything in the order the extension sent it.
 */
import './helpers/alias-vscode'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, ExtensionToWebviewMessage } from '../src/protocol'
import { EventCoalescer, PANEL_EVENT_FLUSH_MS, PANEL_EVENT_BATCH_MAX } from '../src/event-coalescer'

const ev = (n: number, extra: Partial<AgentEvent> = {}): AgentEvent =>
  ({ time: n, type: 'tool_call_start', sessionId: 's', payload: { n }, ...extra })

/** A coalescer on a hand-driven clock: `tick()` runs the pending flush, as the timer would */
function harness(opts: { maxBatch?: number } = {}) {
  const sent: ExtensionToWebviewMessage[] = []
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const c = new EventCoalescer({
    post: (m) => sent.push(m),
    maxBatch: opts.maxBatch,
    schedule: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return t },
    cancel: (t) => { (t as { cancelled: boolean }).cancelled = true },
  })
  const pending = () => timers.filter(t => !t.cancelled)
  const tick = () => { for (const t of pending()) { t.cancelled = true; t.fn() } }
  /** Every event the page received, in order, whatever the message carried it */
  const events = () => sent.flatMap(m => m.type === 'agent-event' ? [m.event] : m.type === 'agent-event-batch' ? m.events : [])
  return { c, sent, timers, pending, tick, events }
}

describe('EventCoalescer (#656)', () => {
  it('holds an event for one 16 ms window, then sends a lone one as a plain agent-event', () => {
    const h = harness()
    h.c.push(ev(1))
    assert.equal(h.sent.length, 0, 'nothing is posted synchronously')
    assert.equal(h.pending().length, 1)
    assert.equal(h.pending()[0].ms, PANEL_EVENT_FLUSH_MS)
    assert.equal(PANEL_EVENT_FLUSH_MS, 16)
    h.tick()
    assert.deepEqual(h.sent, [{ type: 'agent-event', event: ev(1) }])
  })

  it('sends the events of one window as one agent-event-batch marked live, in order, each event unchanged', () => {
    const h = harness()
    const evs = [ev(1), ev(2, { replayed: true }), ev(3)]
    for (const e of evs) h.c.push(e)
    assert.equal(h.timers.length, 1, 'one timer per window, not one per event')
    h.tick()
    assert.deepEqual(h.sent, [{ type: 'agent-event-batch', events: evs, live: true }])
    assert.equal(h.events()[0].replayed, undefined, 'a live event is not made history')
    assert.equal(h.events()[1].replayed, true, 'a replayed one stays replayed')
  })

  it('any other message flushes the buffer first: the page keeps the order the extension sent', () => {
    const h = harness()
    h.c.push(ev(1)); h.c.push(ev(2))
    h.c.post({ type: 'reset', reason: 'panel-reopened' })
    h.c.push(ev(3))
    h.c.post({ type: 'connection-status', status: 'watching', source: 'x' })
    h.c.push(ev(4)); h.c.push(ev(5))
    h.tick()
    assert.deepEqual(h.sent.map(m => m.type), ['agent-event-batch', 'reset', 'agent-event', 'connection-status', 'agent-event-batch'])
    assert.deepEqual(h.events().map(e => e.time), [1, 2, 3, 4, 5])
    assert.equal(h.pending().length, 0, 'a flush cancels the timer of its window')
  })

  it('a full buffer is sent at once, without waiting for the window, in batches of at most maxBatch', () => {
    const h = harness({ maxBatch: 4 })
    for (let i = 1; i <= 10; i++) h.c.push(ev(i))
    assert.deepEqual(h.sent.map(m => m.type === 'agent-event-batch' ? m.events.length : 1), [4, 4])
    h.tick()
    assert.deepEqual(h.sent.map(m => m.type === 'agent-event-batch' ? m.events.length : 1), [4, 4, 2])
    assert.deepEqual(h.events().map(e => e.time), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.ok(PANEL_EVENT_BATCH_MAX >= 100 && PANEL_EVENT_BATCH_MAX <= 1000)
  })

  it('a flush with nothing buffered sends nothing', () => {
    const h = harness()
    h.c.flush()
    h.c.post({ type: 'reset', reason: 'r' })
    assert.deepEqual(h.sent, [{ type: 'reset', reason: 'r' }])
  })

  it('dispose drops what is buffered and cancels the timer: a closed panel receives nothing more', () => {
    const h = harness()
    h.c.push(ev(1))
    h.c.dispose()
    assert.equal(h.pending().length, 0)
    h.c.push(ev(2))
    h.tick()
    assert.deepEqual(h.sent, [])
  })

  it('uses a real 16 ms timer by default', async () => {
    const sent: ExtensionToWebviewMessage[] = []
    const c = new EventCoalescer({ post: (m) => sent.push(m) })
    c.push(ev(1)); c.push(ev(2))
    assert.equal(sent.length, 0)
    await new Promise(r => setTimeout(r, PANEL_EVENT_FLUSH_MS * 4))
    assert.deepEqual(sent, [{ type: 'agent-event-batch', events: [ev(1), ev(2)], live: true }])
    c.dispose()
  })
})

describe('VisualizerPanel sends its events through the coalescer (#656)', () => {
  type Posted = ExtensionToWebviewMessage
  function fakeWebviewPanel() {
    const posted: Posted[] = []
    let onDispose: (() => void) | undefined
    const panel = {
      webview: {
        html: '',
        cspSource: 'vscode-resource:',
        postMessage: (m: Posted) => { posted.push(m); return Promise.resolve(true) },
        onDidReceiveMessage: () => ({ dispose() {} }),
        asWebviewUri: (u: unknown) => u,
      },
      onDidDispose: (fn: () => void) => { onDispose = fn; return { dispose() {} } },
      reveal() {},
    }
    return { panel, posted, close: () => onDispose?.() }
  }

  it('events then another message: one live batch, then that message; a lone event later stays an agent-event', async (t) => {
    const { VisualizerPanel } = await import('../src/webview-provider')
    const f = fakeWebviewPanel()
    // Closed even when an assertion fails: the static instance and its 16 ms timer must not outlive the test
    t.after(() => f.close())
    const p = VisualizerPanel.revive(f.panel as never, { path: '/ext', fsPath: '/ext' } as never)
    p.sendEvent(ev(1)); p.sendEvent(ev(2))
    assert.equal(f.posted.length, 0)
    p.setConnectionStatus('watching', 'x')
    assert.deepEqual(f.posted.map(m => m.type), ['agent-event-batch', 'connection-status'])
    p.sendEvent(ev(3))
    await new Promise(r => setTimeout(r, PANEL_EVENT_FLUSH_MS * 4))
    assert.deepEqual(f.posted.at(-1), { type: 'agent-event', event: ev(3) })
    p.sendEvent(ev(4))
    f.close()
    await new Promise(r => setTimeout(r, PANEL_EVENT_FLUSH_MS * 4))
    assert.equal(f.posted.length, 3, 'nothing is posted to a disposed panel')
  })
})
