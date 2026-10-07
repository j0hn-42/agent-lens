/**
 * EventReconciler thresholds and edge paths (issue #53): every named constant has a boundary test
 * (exactly at the limit, one below, one above), plus same-source repeats inside a held batch,
 * forgetSession, clear and the source passed to deliver.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent, AgentEventType } from '../src/protocol'
import { deriveEventId, EventReconciler } from '../src/event-source-priority'
import {
  EVENT_ID_EXPLICIT_MAX, EVENT_ID_HASH_INPUT_MAX, EVENT_ID_TIME_BUCKET_S,
  EVENT_DEDUP_MAX_PER_SESSION, EVENT_DEDUP_MAX_SESSIONS, EVENT_HOLD_MAX,
} from '../src/constants'

const ev = (type: AgentEventType, payload: Record<string, unknown>, time = 1, sessionId = 's1'): AgentEvent =>
  ({ time, type, payload, sessionId })

function harness(opts: { maxPerSession?: number; maxSessions?: number; maxHeld?: number } = {}) {
  const out: AgentEvent[] = []
  const r = new EventReconciler({ deliver: e => out.push(e), ...opts })
  return { r, out }
}

describe('named thresholds of deriveEventId', () => {
  it('EVENT_ID_EXPLICIT_MAX: an explicit id is honoured up to the limit, ignored one above', () => {
    const same = (n: number) =>
      deriveEventId(ev('message', { eventId: 'x'.repeat(n), text: 'a' })) === deriveEventId(ev('message', { eventId: 'x'.repeat(n), text: 'b' }))
    assert.equal(same(EVENT_ID_EXPLICIT_MAX - 1), true, 'one below: explicit')
    assert.equal(same(EVENT_ID_EXPLICIT_MAX), true, 'at the limit: explicit')
    assert.equal(same(EVENT_ID_EXPLICIT_MAX + 1), false, 'one above: falls back to the content hash')
  })

  it('EVENT_ID_HASH_INPUT_MAX: only the first chars of the serialised payload feed the hash', () => {
    const head = JSON.stringify({ text: '' }).length - 2 // chars before the text value
    const idWithMark = (jsonIndex: number, mark: 'a' | 'b') =>
      deriveEventId(ev('message', { text: 'z'.repeat(jsonIndex - head) + mark + 'z'.repeat(50) }))
    const differs = (jsonIndex: number) => idWithMark(jsonIndex, 'a') !== idWithMark(jsonIndex, 'b')
    assert.equal(differs(EVENT_ID_HASH_INPUT_MAX - 2), true, 'one inside the limit: part of the hash')
    assert.equal(differs(EVENT_ID_HASH_INPUT_MAX - 1), true, 'last char inside the limit: part of the hash')
    assert.equal(differs(EVENT_ID_HASH_INPUT_MAX), false, 'first char beyond the limit: ignored')
    assert.equal(differs(EVENT_ID_HASH_INPUT_MAX + 1), false, 'one more beyond: ignored')
  })

  it('EVENT_ID_TIME_BUCKET_S: copies within one bucket merge, across a boundary they do not', () => {
    const B = EVENT_ID_TIME_BUCKET_S
    const id = (t: number) => deriveEventId(ev('agent_spawn', { name: 'main' }, t))
    assert.equal(id(0), id(B - 0.001), 'just below the first boundary: same bucket')
    assert.notEqual(id(B - 0.001), id(B), 'exactly at the boundary: next bucket')
    assert.equal(id(B), id(2 * B - 0.001), 'the next bucket ends just before 2B')
    assert.notEqual(id(2 * B - 0.001), id(2 * B), 'the boundary after')
  })

  it('the documented bucket is 2 seconds: 1.999 and 2.0 are different buckets, 2.0 and 3.999 the same', () => {
    assert.equal(EVENT_ID_TIME_BUCKET_S, 2)
    const id = (t: number) => deriveEventId(ev('agent_spawn', { name: 'main' }, t))
    assert.notEqual(id(1.999), id(2.0))
    assert.equal(id(2.0), id(3.999))
    assert.notEqual(id(3.999), id(4.0))
  })

  it('the default bucket is EVENT_ID_TIME_BUCKET_S', () => {
    const t = EVENT_ID_TIME_BUCKET_S + 0.5
    assert.equal(deriveEventId(ev('agent_spawn', { name: 'm' }, t)), deriveEventId(ev('agent_spawn', { name: 'm' }, t), EVENT_ID_TIME_BUCKET_S))
    assert.notEqual(deriveEventId(ev('agent_spawn', { name: 'm' }, t)), deriveEventId(ev('agent_spawn', { name: 'm' }, t), 1000))
  })

  it('snake_case tool_use_id (hook payloads) is an identity like toolUseId', () => {
    assert.equal(
      deriveEventId(ev('tool_call_start', { tool_use_id: 'tu_9', a: 1 })),
      deriveEventId(ev('tool_call_start', { toolUseId: 'tu_9', a: 2 })),
    )
    assert.notEqual(
      deriveEventId(ev('tool_call_start', { tool_use_id: 'tu_9' })),
      deriveEventId(ev('tool_call_start', { tool_use_id: 'tu_10' })),
    )
  })

  it('an empty tool_use_id is not an identity', () => {
    assert.notEqual(
      deriveEventId(ev('message', { tool_use_id: '', text: 'a' })),
      deriveEventId(ev('message', { tool_use_id: '', text: 'b' })),
    )
  })
})

describe('named bounds of the reconciler (defaults)', () => {
  it('EVENT_DEDUP_MAX_PER_SESSION: the newest N ids are remembered, the one beyond is forgotten', () => {
    const { r, out } = harness()
    const N = EVENT_DEDUP_MAX_PER_SESSION
    for (let i = 0; i <= N; i++) r.submit(ev('tool_call_start', { toolUseId: `t${i}` }), { source: 'hook' })
    out.length = 0
    r.submit(ev('tool_call_start', { toolUseId: `t${N}` }), { source: 'jsonl' }) // newest: remembered, dropped
    r.submit(ev('tool_call_start', { toolUseId: 't1' }), { source: 'jsonl' }) // the oldest of the N kept: dropped
    r.submit(ev('tool_call_start', { toolUseId: 't0' }), { source: 'jsonl' }) // one beyond: forgotten, delivered
    assert.deepEqual(out.map(e => e.payload.toolUseId), ['t0'])
  })

  it('EVENT_DEDUP_MAX_SESSIONS: the newest N sessions are remembered, the one beyond is forgotten', () => {
    const { r, out } = harness()
    const N = EVENT_DEDUP_MAX_SESSIONS
    for (let i = 0; i <= N; i++) r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, `s${i}`), { source: 'hook' })
    assert.equal(r.rememberedSessions, N)
    out.length = 0
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's1'), { source: 'jsonl' }) // oldest of the N kept: dropped
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's0'), { source: 'jsonl' }) // evicted: delivered
    assert.deepEqual(out.map(e => e.sessionId), ['s0'])
  })

  it('EVENT_HOLD_MAX: held below the bound, flushed when it is reached', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      for (let i = 0; i < EVENT_HOLD_MAX - 1; i++) r.submit(ev('message', { n: i }), { source: 'jsonl' })
      assert.equal(out.length, 0, 'one below the bound: all held')
      r.submit(ev('message', { n: -1 }), { source: 'jsonl' })
      assert.equal(out.length, EVENT_HOLD_MAX, 'at the bound: flushed')
    })
  })
})

describe('bounds with explicit options (at the limit, one above)', () => {
  it('maxPerSession: N ids are remembered, the N+1th evicts the oldest', () => {
    const { r, out } = harness({ maxPerSession: 3 })
    for (const id of ['a', 'b', 'c']) r.submit(ev('tool_call_start', { toolUseId: id }), { source: 'hook' })
    out.length = 0
    for (const id of ['a', 'b', 'c']) r.submit(ev('tool_call_start', { toolUseId: id }), { source: 'jsonl' })
    assert.equal(out.length, 0, 'at the limit nothing was evicted')
    r.submit(ev('tool_call_start', { toolUseId: 'd' }), { source: 'hook' })
    r.submit(ev('tool_call_start', { toolUseId: 'b' }), { source: 'jsonl' }) // still remembered: dropped
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'jsonl' }) // evicted by d: delivered
    assert.deepEqual(out.map(e => e.payload.toolUseId), ['d', 'a'])
  })

  it('maxSessions: N sessions are remembered, the N+1th evicts the oldest', () => {
    const { r, out } = harness({ maxSessions: 2 })
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's1'), { source: 'hook' })
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's2'), { source: 'hook' })
    assert.equal(r.rememberedSessions, 2, 'at the limit')
    out.length = 0
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's1'), { source: 'jsonl' })
    assert.equal(out.length, 0, 'still remembered at the limit')
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's3'), { source: 'hook' })
    assert.equal(r.rememberedSessions, 2, 'one above: capped')
    out.length = 0
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's1'), { source: 'jsonl' }) // oldest: evicted, delivered
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's3'), { source: 'jsonl' }) // newest: remembered, dropped
    assert.deepEqual(out.map(e => e.sessionId), ['s1'])
  })

  it('maxHeld: below the bound held, at the bound flushed, above held again', () => {
    const { r, out } = harness({ maxHeld: 3 })
    r.withHistory(() => {
      r.submit(ev('message', { n: 1 }), { source: 'jsonl' })
      r.submit(ev('message', { n: 2 }), { source: 'jsonl' })
      assert.equal(out.length, 0, 'one below the bound')
      r.submit(ev('message', { n: 3 }), { source: 'jsonl' })
      assert.equal(out.length, 3, 'at the bound')
      r.submit(ev('message', { n: 4 }), { source: 'jsonl' })
      assert.equal(out.length, 3, 'one above: held again')
    })
    assert.equal(out.length, 4)
  })
})

describe('same-source repeats inside a held batch (withHistory)', () => {
  it('two identical events of one source are both delivered', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      r.submit(ev('message', { text: 'again' }), { source: 'jsonl' })
      r.submit(ev('message', { text: 'again' }), { source: 'jsonl' })
    })
    assert.equal(out.length, 2)
  })

  it('repeats of one source plus a copy of the other: repeats kept, the copy collapses', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'jsonl' }), { source: 'jsonl' })
      r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'jsonl' }), { source: 'jsonl' })
      r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'hook' }), { source: 'hook' })
    })
    assert.deepEqual(out.map(e => e.payload.src), ['jsonl', 'jsonl'])
  })

  it('a same-source repeat arriving after a cross-source collapse is kept', () => {
    const { r, out } = harness()
    r.withHistory(() => {
      r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'jsonl' }), { source: 'jsonl' })
      r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'hook' }), { source: 'hook' })
      r.submit(ev('tool_call_start', { toolUseId: 'a', src: 'jsonl' }), { source: 'jsonl' })
    })
    assert.deepEqual(out.map(e => e.payload.src), ['jsonl', 'jsonl'])
  })
})

describe('forgetSession, clear and the source passed to deliver', () => {
  it('forgetSession drops the memory of that session only', () => {
    const { r, out } = harness()
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's1'), { source: 'hook' })
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's2'), { source: 'hook' })
    r.forgetSession('s1')
    out.length = 0
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's1'), { source: 'jsonl' }) // forgotten: delivered
    r.submit(ev('tool_call_start', { toolUseId: 'a' }, 1, 's2'), { source: 'jsonl' }) // remembered: dropped
    assert.deepEqual(out.map(e => e.sessionId), ['s1'])
  })

  it('clear drops held events and every memory', () => {
    const { r, out } = harness()
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'hook' })
    r.withHistory(() => {
      r.submit(ev('message', { text: 'held' }), { source: 'jsonl' })
      r.clear()
      assert.equal(r.heldCount, 0)
    })
    assert.equal(r.rememberedSessions, 0)
    out.length = 0
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'jsonl' })
    assert.equal(out.length, 1)
  })

  it('deliver receives the source of the surviving copy', () => {
    const seen: string[] = []
    const r = new EventReconciler({ deliver: (e, source) => { seen.push(`${e.type}:${source}`) } })
    r.submit(ev('message', { text: 'x' }), { source: 'jsonl' })
    r.submit(ev('tool_call_start', { toolUseId: 'a' }), { source: 'hook' })
    r.withHistory(() => {
      r.submit(ev('permission_requested', { agent: 'm' }, 3), { source: 'jsonl' })
      r.submit(ev('permission_requested', { agent: 'm' }, 3.5), { source: 'hook' })
    })
    assert.deepEqual(seen, ['message:jsonl', 'tool_call_start:hook', 'permission_requested:hook'])
  })
})
