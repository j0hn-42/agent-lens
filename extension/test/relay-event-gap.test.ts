// Events a reconnecting client missed while its link was down (#366): the relay numbers what it delivers, remembers
// the numbers of what its buffer let go of, and counts for a client that says what it last received (`since`) the
// events numbered after it that the buffer or the replay cap left out. A lower bound: a forgotten number is not counted.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import {
  appendBounded, capReplayBatches, createEvictionLog, logEvicted, evictedAfter, parseSinceParam, formatSinceParam,
  RELAY_EVICTION_LOG_PER_SESSION,
} from '../src/relay-guards'

const ev = (n: number, sessionId = 's', type = 'message'): AgentEvent => ({ time: n, type, payload: { n }, sessionId }) as unknown as AgentEvent

describe('appendBounded hands over the events it evicts (#366)', () => {
  it('per-session cap: the evicted events, oldest first, and never a replaced activity', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const gone: AgentEvent[] = []
    const events = Array.from({ length: 10 }, (_, i) => ev(i, 'a'))
    for (const e of events) appendBounded(buffers, 'a', e, { perSession: 4 }, undefined, (_sid, evs) => gone.push(...evs))
    assert.deepEqual(gone, events.slice(0, 6))
    const act: AgentEvent[] = []
    for (let i = 0; i < 5; i++) appendBounded(buffers, 'b', ev(i, 'b', 'agent_activity'), { perSession: 50 }, undefined, (_s, evs) => act.push(...evs))
    assert.equal(act.length, 0, 'a replaced activity is not a loss')
  })
  it('a whole session dropped for the global budget hands over all its events, under its own id', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const gone: Array<[string, number]> = []
    for (let i = 0; i < 3; i++) appendBounded(buffers, 'old', ev(i, 'old'))
    appendBounded(buffers, 'new', ev(9, 'new'), { sessions: 1 }, undefined, (sid, evs) => gone.push([sid, evs.length]))
    assert.deepEqual(gone, [['old', 3]])
  })
})

describe('capReplayBatches hands over the events it leaves out (#366)', () => {
  it('only what is not re-added in front (lifecycle events are kept)', () => {
    const events = [ev(0, 'a', 'agent_spawn'), ...Array.from({ length: 9 }, (_, i) => ev(i + 1, 'a'))]
    const dropped: AgentEvent[] = []
    capReplayBatches([{ type: 'agent-event-batch', events }], { perSession: 4, total: 100, batchSize: 100 }, undefined, evs => dropped.push(...evs))
    assert.equal(dropped.length, 5)
    assert.ok(!dropped.includes(events[0]), 'the spawn is replayed')
  })
})

describe('eviction log (#366)', () => {
  it('counts, per session, the evicted numbers above `since`', () => {
    const log = createEvictionLog()
    logEvicted(log, 'a', [3, 7, 12])
    logEvicted(log, 'b', [8])
    assert.equal(evictedAfter(log, 'a', 5), 2)
    assert.equal(evictedAfter(log, 'a', 12), 0)
    assert.equal(evictedAfter(log, 'b', 0), 1)
    assert.equal(evictedAfter(log, 'nope', 0), 0)
  })
  it('stays bounded per session and in sessions, forgetting the LOWEST numbers first (still a lower bound)', () => {
    const log = createEvictionLog()
    const many = Array.from({ length: RELAY_EVICTION_LOG_PER_SESSION * 3 }, (_, i) => i + 1)
    logEvicted(log, 'a', many)
    assert.ok(log.bySession.get('a')!.length <= RELAY_EVICTION_LOG_PER_SESSION * 2)
    // The newest numbers are what a reconnecting client asks about
    assert.equal(evictedAfter(log, 'a', many.length - 10), 10)
    assert.ok(evictedAfter(log, 'a', 0) <= many.length, 'never more than what was evicted')
    for (let s = 0; s < 50; s++) logEvicted(log, `s${s}`, [s + 1], RELAY_EVICTION_LOG_PER_SESSION, 8)
    assert.ok(log.bySession.size <= 8)
  })
})

describe('since parameter (#366)', () => {
  it('round-trips instance and number, and rejects anything else', () => {
    assert.deepEqual(parseSinceParam('/events?since=' + formatSinceParam('a1b2c3d4e5f60718', 42)), { instance: 'a1b2c3d4e5f60718', seq: 42 })
    assert.deepEqual(parseSinceParam('/events?session=x&since=abcdef12.0'), { instance: 'abcdef12', seq: 0 })
    for (const bad of [undefined, '/events', '/events?since=', '/events?since=abc', '/events?since=zz!.1', '/events?since=abcdef12.-1',
      '/events?since=abcdef12.1.2', '/events?since=abcdef12.99999999999999999999', '/events?since=a.1&since=b.2', '/status?since=abcdef12.1',
      `/events?since=${'a'.repeat(65)}.1`]) {
      assert.equal(parseSinceParam(bad), null, String(bad))
    }
  })
})
