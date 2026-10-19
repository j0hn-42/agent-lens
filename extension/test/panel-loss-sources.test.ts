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

  /** Everything the page would be told, a running total of other sessions included if there were one */
  const total = () => {
    const loss = m.panelLoss.snapshotAfterReplay(() => {}) as { evicted: Record<string, number>; otherEvents?: number } | null
    return loss ? Object.values(loss.evicted).reduce((x, y) => x + y, 0) + (loss.otherEvents ?? 0) : 0
  }
  const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => ev(`${prefix}${i}`, i)).join('')

  it('A -> B -> A with 200 sessions in B: never more than the 250 events proven (#605 review round 2, B1)', () => {
    const a = path.join(dir, 'a.jsonl')
    const b = path.join(dir, 'b.jsonl')
    fs.writeFileSync(a, Array.from({ length: 50 }, (_, i) => ev('a1', i)).join(''))
    fs.writeFileSync(b, many('b', 200))
    connect(a).disconnect()
    connect(b).disconnect()
    const again = connect(a)
    try {
      const shown = total()
      assert.ok(shown <= 250, `shown ${shown}, proven 250`)
      assert.equal(figure().a1, 50)
    } finally { again.disconnect() }
  })

  it('disconnecting a log of 201 sessions keeps the other sources\' figure (#605 review round 2, M1)', () => {
    const a = path.join(dir, 'a.jsonl')
    fs.writeFileSync(a, many('j', 201))
    const conn = connect(a)
    // Another source (a Claude session) emits after the log was read: the most recent session
    for (let i = 0; i < 10; i++) m.panelLoss.note({ time: i, type: 'message', payload: {}, sessionId: 'claude-1' } as unknown as AgentEvent)
    conn.disconnect()
    const after = figure()
    assert.equal(after['claude-1'], 10)
    const shown = total()
    assert.ok(shown > 10, `the log's named sessions keep their count too (shown ${shown})`)
    assert.ok(shown <= 211)
  })

  /** The source's follow-up read, as its watcher or poll timer would run it */
  const follow = (source: unknown) => (source as { readNewLines(): void }).readNewLines()

  it('the log truncated while connected, then the same lines written again: never more than the events proven (#605 review round 3, M1)', () => {
    const a = path.join(dir, 'a.jsonl')
    const lines = ev('S', 1) + ev('S', 2) + ev('S', 3)
    fs.writeFileSync(a, lines)
    const source = new m.JsonlEventSource(a)
    const wiring = m.wireJsonlSourceToPanel(source)
    source.start()
    try {
      assert.deepEqual(figure(), { S: 3 })
      fs.writeFileSync(a, '')
      follow(source)
      fs.writeFileSync(a, lines + ev('S', 4))
      follow(source)
      const shown = figure().S ?? 0
      assert.ok(shown <= 4, `shown ${shown}, 4 distinct events`)
      assert.ok(shown >= 3, `what was counted stays as a floor (shown ${shown})`)
    } finally { wiring.dispose(); source.dispose() }
  })

  it('the log truncated, then rewritten over several reads: still never more than the events proven', () => {
    const a = path.join(dir, 'a.jsonl')
    const lines = ev('S', 1) + ev('S', 2) + ev('S', 3)
    fs.writeFileSync(a, lines)
    const source = new m.JsonlEventSource(a)
    const wiring = m.wireJsonlSourceToPanel(source)
    source.start()
    try {
      fs.writeFileSync(a, '')
      follow(source)
      fs.writeFileSync(a, ev('S', 1))
      follow(source)
      fs.appendFileSync(a, ev('S', 2) + ev('S', 3) + ev('S', 4))
      follow(source)
      const shown = figure().S ?? 0
      assert.ok(shown <= 4, `shown ${shown}, 4 distinct events`)
      assert.ok(shown >= 3, `what was counted stays as a floor (shown ${shown})`)
    } finally { wiring.dispose(); source.dispose() }
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
