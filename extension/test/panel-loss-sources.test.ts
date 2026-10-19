/**
 * Sources that read the same history again without the watcher's `replayed` marker (#592, #605 review): the JSONL
 * event log connected again (same file twice, or A -> B -> A) is counted once, and OpenCode, whose re-reads carry no
 * marker, is left out of the count (the figure stays a lower bound, docs/relay-sources.md).
 */
import './helpers/alias-vscode'
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'

type Mods = {
  JsonlEventSource: typeof import('../src/event-source').JsonlEventSource
  wireJsonlSourceToPanel: typeof import('../src/jsonl-panel').wireJsonlSourceToPanel
  runtime: typeof import('../src/session-runtime')
  panelLoss: typeof import('../src/panel-loss').panelLoss
}

const ev = (sessionId: string, i: number) => JSON.stringify({ time: i, type: 'message', payload: { agent: 'a', content: `m${i}` }, sessionId }) + '\n'

describe('JSONL event log connected again (#605 review)', () => {
  let m: Mods
  let dir = ''
  before(async () => {
    m = {
      JsonlEventSource: (await import('../src/event-source')).JsonlEventSource,
      wireJsonlSourceToPanel: (await import('../src/jsonl-panel')).wireJsonlSourceToPanel,
      runtime: await import('../src/session-runtime'),
      panelLoss: (await import('../src/panel-loss')).panelLoss,
    }
  })
  beforeEach(() => { m.panelLoss.clear(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-jsonl-loss-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  /** What extension.ts does: one source at a time, the previous one disconnected first */
  function connect(file: string) {
    const source = new m.JsonlEventSource(file)
    const wiring = m.wireJsonlSourceToPanel(source)
    source.start()
    return { disconnect: () => { wiring.dispose(); source.dispose() } }
  }
  const figure = () => m.panelLoss.snapshotAfterReplay(() => {})?.evicted ?? {}

  it('the same file connected twice: still N, not 2N', () => {
    const a = path.join(dir, 'a.jsonl')
    fs.writeFileSync(a, ev('log-1', 1) + ev('log-1', 2) + ev('log-1', 3))
    const first = connect(a)
    assert.deepEqual(figure(), { 'log-1': 3 })
    first.disconnect()
    const second = connect(a)
    try { assert.deepEqual(figure(), { 'log-1': 3 }) } finally { second.disconnect() }
  })

  it('A -> B -> A: each file counted once, and lines appended to A meanwhile are counted', () => {
    const a = path.join(dir, 'a.jsonl')
    const b = path.join(dir, 'b.jsonl')
    fs.writeFileSync(a, ev('log-a', 1) + ev('log-a', 2))
    fs.writeFileSync(b, ev('log-b', 1))
    connect(a).disconnect()
    connect(b).disconnect()
    fs.appendFileSync(a, ev('log-a', 3))
    const again = connect(a)
    try { assert.deepEqual(figure(), { 'log-a': 3, 'log-b': 1 }) } finally { again.disconnect() }
  })

  it('lines appended while connected are new events, counted on top', () => {
    const a = path.join(dir, 'a.jsonl')
    fs.writeFileSync(a, ev('log-1', 1))
    connect(a).disconnect()
    fs.appendFileSync(a, ev('log-1', 2))
    const again = connect(a)
    try { assert.deepEqual(figure(), { 'log-1': 2 }) } finally { again.disconnect() }
  })

  it('the events reach the panel unchanged (no replayed marker added)', () => {
    const a = path.join(dir, 'a.jsonl')
    fs.writeFileSync(a, ev('log-1', 1))
    const seen: AgentEvent[] = []
    const source = new m.JsonlEventSource(a)
    source.onEvent(e => seen.push(e))
    const wiring = m.wireJsonlSourceToPanel(source)
    source.start()
    wiring.dispose(); source.dispose()
    assert.equal(seen.length, 1)
    assert.equal(seen[0].replayed, undefined)
  })
})

describe('OpenCode left out of the count (#605 review)', () => {
  it('a watcher wired with countPanelLoss: false is not counted', async () => {
    const vscode = require('vscode') as typeof import('vscode')
    const runtime = await import('../src/session-runtime')
    const { panelLoss } = await import('../src/panel-loss')
    panelLoss.clear()
    const onEvent = new vscode.EventEmitter<AgentEvent>()
    const none = new vscode.EventEmitter<never>()
    const watcher = {
      onEvent: onEvent.event, onSessionDetected: none.event, onSessionLifecycle: none.event,
      getActiveSessions: () => [], replaySessionStart: () => {}, start: () => {}, dispose: () => {},
    } as unknown as import('../src/session-runtime').AgentSessionWatcher
    const wiring = runtime.wireWatcherToPanel(watcher, { sessionLabelPrefix: 'OpenCode', countPanelLoss: false })
    onEvent.fire({ time: 1, type: 'message', payload: { agent: 'a' }, sessionId: 'oc-1' } as unknown as AgentEvent)
    wiring.dispose()
    assert.equal(panelLoss.snapshotAfterReplay(() => {}), null)
  })

  it('opencode-runtime.ts wires its watcher that way', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/opencode-runtime.ts'), 'utf8')
    assert.match(src, /countPanelLoss: false/)
  })
})
