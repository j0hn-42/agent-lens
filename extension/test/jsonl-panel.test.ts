/**
 * The bounds of wireJsonlSourceToPanel (#613, #605 review): at most JSONL_COUNTED_SESSIONS_MAX sessions per
 * connection are counted, and a session id longer than the page reads (web/lib/event-loss.ts, 256 characters) is not
 * kept in the set of counted sessions.
 */
import './helpers/alias-vscode'
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'

type Mods = {
  wire: typeof import('../src/jsonl-panel').wireJsonlSourceToPanel
  MAX: typeof import('../src/jsonl-panel').JSONL_COUNTED_SESSIONS_MAX
  ID_MAX: typeof import('../src/jsonl-panel').JSONL_SESSION_ID_MAX
  panelLoss: typeof import('../src/panel-loss').panelLoss
}

/** A source whose events the test fires by hand */
function fakeSource() {
  let listener: ((e: AgentEvent) => void) | null = null
  return {
    readingExisting: false,
    onEvent: (l: (e: AgentEvent) => void) => { listener = l; return { dispose: () => { listener = null } } },
    fire: (sessionId: string) => listener?.({ time: 0, type: 'message', payload: { agent: 'a' }, sessionId } as unknown as AgentEvent),
  }
}

describe('wireJsonlSourceToPanel bounds (#613)', () => {
  let m: Mods
  before(async () => {
    const mod = await import('../src/jsonl-panel')
    m = { wire: mod.wireJsonlSourceToPanel, MAX: mod.JSONL_COUNTED_SESSIONS_MAX, ID_MAX: mod.JSONL_SESSION_ID_MAX, panelLoss: (await import('../src/panel-loss')).panelLoss }
  })
  beforeEach(() => m.panelLoss.clear())
  const figure = () => m.panelLoss.snapshotAfterReplay(() => {})?.evicted ?? {}

  it(`counts ${10_000} sessions per connection, not the next one`, () => {
    assert.equal(m.MAX, 10_000)
    const source = fakeSource()
    const wiring = m.wire(source)
    try {
      for (let i = 0; i < m.MAX; i++) source.fire(`s${i}`)
      source.fire(`s${m.MAX - 1}`)
      source.fire('beyond')
      const f = figure()
      assert.equal(f[`s${m.MAX - 1}`], 2, 'a session already counted keeps being counted')
      assert.equal(f.beyond, undefined, 'the session past the cap is left out of the figure, though the most recent')
    } finally { wiring.dispose() }
  })

  it('a session id longer than the page reads is not counted (nor kept in the set)', () => {
    assert.equal(m.ID_MAX, 256)
    const source = fakeSource()
    const wiring = m.wire(source)
    try {
      source.fire('x'.repeat(m.ID_MAX))
      source.fire('y'.repeat(m.ID_MAX + 1))
      const f = figure()
      assert.equal(f['x'.repeat(m.ID_MAX)], 1)
      assert.equal(f['y'.repeat(m.ID_MAX + 1)], undefined)
    } finally { wiring.dispose() }
  })
})
