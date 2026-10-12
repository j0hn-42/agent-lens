import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { capReplayBatches, appendBounded } from '../src/relay-guards'

const ev = (n: number, sessionId = 's', type = 'message'): AgentEvent => ({ time: n, type, payload: { n }, sessionId }) as unknown as AgentEvent

describe('evicted counter per session (#366)', () => {
  it('counts events dropped by the per-session buffer cap', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = new Map<string, number>()
    for (let i = 0; i < 10; i++) appendBounded(buffers, 'a', ev(i, 'a'), { perSession: 4 }, evicted)
    assert.equal(buffers.get('a')!.length, 4)
    assert.equal(evicted.get('a'), 6)
  })
  it('does not count an activity replaced by a newer one', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = new Map<string, number>()
    for (let i = 0; i < 5; i++) appendBounded(buffers, 'a', ev(i, 'a', 'agent_activity'), { perSession: 50 }, evicted)
    assert.equal(evicted.get('a') ?? 0, 0)
  })
  it('counts the events of a whole session evicted for the global budget', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = new Map<string, number>()
    for (let i = 0; i < 3; i++) appendBounded(buffers, 'old', ev(i, 'old'), {}, evicted)
    appendBounded(buffers, 'new', ev(9, 'new'), { sessions: 1 }, evicted)
    assert.equal(buffers.has('old'), false)
    assert.equal(evicted.get('old'), 3)
  })
  it('counts what the replay cap drops, per session', () => {
    const evicted = new Map<string, number>()
    const events = Array.from({ length: 10 }, (_, i) => ev(i, 'a'))
    capReplayBatches([{ type: 'agent-event-batch', events }], { perSession: 4, total: 100, batchSize: 100 }, evicted)
    assert.equal(evicted.get('a'), 6)
  })
})
