/**
 * Hooks vs JSONL reconciliation (issue #53): conflict table, derived ids and the overlap
 * scenarios (present in both sources, live during history load, missing post-tool hook, late JSONL).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, AgentEventType } from '../src/protocol'
import {
  resolveConflict, deriveEventId, EventReconciler, EVENT_SOURCE_PRIORITY, DEFAULT_PRIORITY,
  type EventSource, type SourcedEvent,
} from '../src/event-source-priority'

const ev = (type: AgentEventType, payload: Record<string, unknown>, time = 1, sessionId = 's1'): AgentEvent =>
  ({ time, type, payload, sessionId })
const sourced = (e: AgentEvent, source: EventSource): SourcedEvent => ({ event: e, source })

describe('resolveConflict (table-driven)', () => {
  const rows: Array<{ type: AgentEventType; winner: EventSource }> = [
    { type: 'message', winner: 'jsonl' },
    { type: 'tool_call_start', winner: 'jsonl' },
    { type: 'tool_call_end', winner: 'jsonl' },
    { type: 'context_update', winner: 'jsonl' },
    { type: 'model_detected', winner: 'jsonl' },
    { type: 'subagent_dispatch', winner: 'jsonl' },
    { type: 'permission_requested', winner: 'hook' },
    { type: 'agent_idle', winner: 'hook' },
    { type: 'agent_complete', winner: 'hook' },
  ]
  for (const { type, winner } of rows) {
    for (const order of [['jsonl', 'hook'], ['hook', 'jsonl']] as Array<[EventSource, EventSource]>) {
      it(`${type}: ${winner} wins whatever the argument order (${order.join(',')})`, () => {
        const a = sourced(ev(type, { who: order[0] }), order[0])
        const b = sourced(ev(type, { who: order[1] }), order[1])
        assert.equal(resolveConflict(a, b).source, winner)
      })
    }
  }
  it('same source: keeps the first, never merges', () => {
    const a = sourced(ev('message', { n: 1 }), 'hook')
    const b = sourced(ev('message', { n: 2 }), 'hook')
    assert.equal(resolveConflict(a, b), a)
  })
  it('the table is the documented one', () => {
    assert.equal(DEFAULT_PRIORITY, 'jsonl')
    assert.deepEqual(Object.keys(EVENT_SOURCE_PRIORITY).sort(), ['agent_complete', 'agent_idle', 'permission_requested'])
  })
})

describe('deriveEventId', () => {
  it('is identical for the hook and JSONL copies of one tool call', () => {
    const hook = ev('tool_call_start', { agent: 'main', tool: 'Bash', args: 'ls', toolUseId: 'tu_1' }, 12.4)
    const jsonl = ev('tool_call_start', { agent: 'orchestrator', tool: 'Bash', args: 'ls -la', toolUseId: 'tu_1' }, 97)
    assert.equal(deriveEventId(hook), deriveEventId(jsonl))
  })
  it('differs by type, tool_use_id and session', () => {
    const base = ev('tool_call_start', { toolUseId: 'tu_1' })
    assert.notEqual(deriveEventId(base), deriveEventId(ev('tool_call_end', { toolUseId: 'tu_1' })))
    assert.notEqual(deriveEventId(base), deriveEventId(ev('tool_call_start', { toolUseId: 'tu_2' })))
    assert.notEqual(deriveEventId(base), deriveEventId(ev('tool_call_start', { toolUseId: 'tu_1' }, 1, 'other')))
  })
  it('uses an explicit id first', () => {
    assert.equal(deriveEventId(ev('message', { eventId: 'e-9', text: 'a' })), deriveEventId(ev('message', { eventId: 'e-9', text: 'b' }, 50)))
  })
  it('buckets lifecycle events by time and agent', () => {
    const a = ev('agent_spawn', { name: 'main' }, 0.2)
    assert.equal(deriveEventId(a), deriveEventId(ev('agent_spawn', { name: 'main' }, 1.4)))
    assert.notEqual(deriveEventId(a), deriveEventId(ev('agent_spawn', { name: 'main' }, 9)))
    assert.notEqual(deriveEventId(a), deriveEventId(ev('agent_spawn', { name: 'other' }, 0.2)))
  })
  it('never merges two different messages without a key', () => {
    assert.notEqual(deriveEventId(ev('message', { text: 'one' })), deriveEventId(ev('message', { text: 'two' })))
    assert.equal(deriveEventId(ev('message', { text: 'one' })), deriveEventId(ev('message', { text: 'one' })))
  })
})

function harness() {
  const out: AgentEvent[] = []
  const r = new EventReconciler({ deliver: e => out.push(e) })
  return { r, out }
}
const ids = (out: AgentEvent[]) => out.map(e => `${e.type}:${e.payload.toolUseId ?? e.payload.n ?? e.payload.name}`)

describe('EventReconciler overlap', () => {
  it('an event present in both sources appears once (history + live copy)', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      r.submit(ev('tool_call_start', { toolUseId: 'tu_1', src: 'jsonl' }), { source: 'jsonl' })
      r.submit(ev('tool_call_start', { toolUseId: 'tu_1', src: 'hook' }), { source: 'hook' })
    })
    assert.equal(out.length, 1)
    assert.equal(out[0].payload.src, 'jsonl', 'JSONL is authoritative for tool content')
  })

  it('permission prompt present in both: the hook copy wins', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      r.submit(ev('permission_requested', { agent: 'main', src: 'jsonl' }, 3), { source: 'jsonl' })
      r.submit(ev('permission_requested', { agent: 'main', src: 'hook' }, 3.5), { source: 'hook' })
    })
    assert.deepEqual(out.map(e => e.payload.src), ['hook'])
  })

  it('live events arriving during the history load are neither lost nor duplicated', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'jsonl' })
      r.submit(ev('tool_call_start', { toolUseId: 'live-only' }), { source: 'hook' }) // live, not in the file yet
      assert.equal(out.length, 0, 'held while the history loads')
      assert.equal(r.heldCount, 2)
      r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'hook' }) // live copy of a history event
      r.submit(ev('tool_call_end', { toolUseId: 'a' }), { source: 'jsonl' })
    })
    assert.deepEqual(ids(out), ['tool_call_start:a', 'tool_call_start:live-only', 'tool_call_end:a'])
    assert.equal(r.heldCount, 0)
  })

  it('events arriving after the load are delivered immediately and deduplicated against it', () => {
    const { r, out } = harness()
    r.withHistory(() => r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'jsonl' }))
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'hook' })
    r.submit(ev('tool_call_start', { toolUseId: 'b' }), { source: 'hook' })
    assert.deepEqual(ids(out), ['tool_call_start:a', 'tool_call_start:b'])
  })

  it('hook post-tool event missing: the JSONL end is still delivered once', () => {
    const { r, out } = harness()
    r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'hook' }), { source: 'hook' })
    // PostToolUse never arrived; the transcript has both lines
    r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'jsonl' }), { source: 'jsonl' })
    r.submit(ev('tool_call_end', { toolUseId: 'a', src: 'jsonl' }), { source: 'jsonl' })
    assert.deepEqual(out.map(e => `${e.type}:${e.payload.src}`), ['tool_call_start:hook', 'tool_call_end:jsonl'])
  })

  it('JSONL arriving late: the copy of what the hook already delivered is dropped, new lines are kept', () => {
    const { r, out } = harness()
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'hook' })
    r.submit(ev('tool_call_end', { toolUseId: 'a' }), { source: 'hook' })
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'jsonl' })
    r.submit(ev('tool_call_end', { toolUseId: 'a' }), { source: 'jsonl' })
    r.submit(ev('message', { text: 'only in the transcript' }), { source: 'jsonl' })
    assert.equal(out.length, 3)
    assert.equal(out[2].type, 'message')
  })

  it('same-source repeats are real activity and are kept', () => {
    const { r, out } = harness()
    r.submit(ev('message', { text: 'again' }), { source: 'jsonl' })
    r.submit(ev('message', { text: 'again' }), { source: 'jsonl' })
    assert.equal(out.length, 2)
  })

  it('does not merge across sessions', () => {
    const { r, out } = harness()
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's1'), { source: 'jsonl' })
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's2'), { source: 'hook' })
    assert.equal(out.length, 2)
  })

  it('flushes the held events even when the load throws', () => {
    const { r, out } = harness()
    assert.throws(() => r.withHistory(() => {
      r.submit(ev('message', { text: 'x' }), { source: 'jsonl' })
      throw new Error('boom')
    }), /boom/)
    assert.equal(out.length, 1)
    assert.equal(r.isLoading, false)
  })

  it('nested loads flush once, at the outermost end', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      r.withHistory(() => r.submit(ev('message', { text: 'x' }), { source: 'jsonl' }))
      assert.equal(out.length, 0)
    })
    assert.equal(out.length, 1)
  })

  it('bounds the hold: flushes early beyond maxHeld', () => {
    const out: AgentEvent[] = []
    const r = new EventReconciler({ deliver: e => out.push(e), maxHeld: 3 })
    r.withHistory(() => {
      for (let i = 0; i < 4; i++) r.submit(ev('message', { n: i }), { source: 'jsonl' })
      assert.equal(out.length, 3)
    })
    assert.equal(out.length, 4)
  })

  it('bounds the remembered ids per session (oldest forgotten)', () => {
    const out: AgentEvent[] = []
    const r = new EventReconciler({ deliver: e => out.push(e), maxPerSession: 2 })
    for (const id of ['a', 'b', 'c']) r.submit(ev('tool_call_start', { toolUseId: id }), { source: 'hook' })
    r.submit(ev('tool_call_start', { toolUseId: 'c' }), { source: 'jsonl' }) // remembered: dropped
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'jsonl' }) // forgotten: delivered
    assert.equal(out.length, 4)
  })
})
