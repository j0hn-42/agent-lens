import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { capReplayBatches, appendBounded, createEvictedTally } from '../src/relay-guards'

const ev = (n: number, sessionId = 's', type = 'message'): AgentEvent => ({ time: n, type, payload: { n }, sessionId }) as unknown as AgentEvent

describe('evicted counter per session (#366)', () => {
  it('counts events dropped by the per-session buffer cap', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = createEvictedTally()
    for (let i = 0; i < 10; i++) appendBounded(buffers, 'a', ev(i, 'a'), { perSession: 4 }, evicted)
    assert.equal(buffers.get('a')!.length, 4)
    assert.equal(evicted.bySession.get('a'), 6)
  })
  it('does not count an activity replaced by a newer one', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = createEvictedTally()
    for (let i = 0; i < 5; i++) appendBounded(buffers, 'a', ev(i, 'a', 'agent_activity'), { perSession: 50 }, evicted)
    assert.equal(evicted.bySession.get('a') ?? 0, 0)
  })
  it('counts the events of a whole session evicted for the global budget', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = createEvictedTally()
    for (let i = 0; i < 3; i++) appendBounded(buffers, 'old', ev(i, 'old'), {}, evicted)
    appendBounded(buffers, 'new', ev(9, 'new'), { sessions: 1 }, evicted)
    assert.equal(buffers.has('old'), false)
    assert.equal(evicted.bySession.get('old'), 3)
  })
  it('counts what the replay cap drops, per session', () => {
    const evicted = new Map<string, number>()
    const events = Array.from({ length: 10 }, (_, i) => ev(i, 'a'))
    capReplayBatches([{ type: 'agent-event-batch', events }], { perSession: 4, total: 100, batchSize: 100 }, evicted)
    assert.equal(evicted.get('a'), 6)
  })
})

describe('evicted counter: bounds and uncovered branches (#366)', () => {
  it('stays bounded: past the session cap the oldest entries fold into `other`', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const tally = createEvictedTally()
    const lim = { sessions: 3 }
    for (let s = 0; s < 40; s++) {
      appendBounded(buffers, `s${s}`, ev(1, `s${s}`), lim, tally)
      appendBounded(buffers, `s${s}`, ev(2, `s${s}`), lim, tally)
    }
    assert.ok(tally.bySession.size <= 3)
    assert.ok(buffers.size <= 3)
    const sum = [...tally.bySession.values()].reduce((a, b) => a + b, 0) + tally.other
    assert.equal(sum, 2 * 37, 'every evicted event is still accounted for')
  })
  it('a single session over the total budget is trimmed at its head and counted', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const tally = createEvictedTally()
    for (let i = 0; i < 10; i++) appendBounded(buffers, 'a', ev(i, 'a'), { perSession: 100, total: 5 }, tally)
    assert.equal(buffers.get('a')!.length, 5)
    assert.equal(tally.bySession.get('a'), 5)
  })
  it('does not count the lifecycle and activity events re-added at the head of the replay', () => {
    const dropped = new Map<string, number>()
    const events = [ev(0, 'a', 'agent_spawn'), ev(1, 'a', 'agent_activity'), ev(2, 'a'), ev(3, 'a'), ev(4, 'a'), ev(5, 'a')]
    const out = capReplayBatches([{ type: 'agent-event-batch', events }], { perSession: 2, total: 100, batchSize: 100 }, dropped)
    assert.equal(out.flatMap(b => b.events).length, 4)
    assert.equal(dropped.get('a'), 2, 'only the two cut messages are lost')
  })
  it('counts in full the sessions the total replay budget never reached', () => {
    const dropped = new Map<string, number>()
    const batch = (s: string, n: number) => ({ type: 'agent-event-batch' as const, events: Array.from({ length: n }, (_, i) => ev(i, s)) })
    capReplayBatches([batch('old', 7), batch('mid', 5), batch('new', 4)], { perSession: 100, total: 4, batchSize: 100 }, dropped)
    assert.equal(dropped.get('new') ?? 0, 0)
    assert.equal(dropped.get('mid'), 5)
    assert.equal(dropped.get('old'), 7)
  })
})
