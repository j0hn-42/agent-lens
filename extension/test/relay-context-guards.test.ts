/**
 * Guards of the context_update replacement in the replay buffer (#567, tests #574): the scan limit, the candidate
 * cap, provenance and isolation between sessions. Unit level on appendBounded (the only entry point).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { appendBounded, createEvictedTally } from '../src/relay-guards'

const reading = (agent: string, tokens: number, extra: Partial<AgentEvent> = {}, time = 1): AgentEvent => ({
  time, type: 'context_update', sessionId: 's',
  payload: { agent, tokens, tokensMax: 200000, breakdown: { systemPrompt: 1 } }, ...extra,
}) as unknown as AgentEvent
const tool = (n: number): AgentEvent => ({ time: 1, type: 'tool_call_start', payload: { n }, sessionId: 's' }) as unknown as AgentEvent
const limits = { perSession: 100000, total: 1000000 }
const feed = (buffers: Map<string, AgentEvent[]>, sid: string, ...events: AgentEvent[]) => {
  for (const e of events) appendBounded(buffers, sid, e, limits)
}

describe('replaceSupersededReading guards (#574)', () => {
  it('baseline: a later reading at the same instant replaces the earlier one', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const a = reading('main', 10), b = reading('main', 20)
    feed(buffers, 's', a, tool(1), b)
    assert.deepEqual(buffers.get('s'), [tool(1), b])
  })

  it('CONTEXT_SCAN_LIMIT: an earlier reading more than 64 events back is kept', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const a = reading('main', 10), b = reading('main', 20)
    feed(buffers, 's', a)
    for (let i = 0; i < 64; i++) feed(buffers, 's', tool(i))
    feed(buffers, 's', b)
    // a is at index 0, buf.length is 65 when b arrives: the scan covers indexes 1..64 only
    assert.ok(buffers.get('s')!.includes(a), 'out of scan range: kept')
    assert.equal(buffers.get('s')!.length, 66)
  })

  it('CONTEXT_SCAN_LIMIT: an earlier reading exactly 64 events back is still replaced', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const a = reading('main', 10), b = reading('main', 20)
    feed(buffers, 's', a)
    for (let i = 0; i < 63; i++) feed(buffers, 's', tool(i))
    feed(buffers, 's', b)
    assert.equal(buffers.get('s')!.includes(a), false)
    assert.equal(buffers.get('s')!.length, 64)
  })

  it('CONTEXT_MAX_CANDIDATES: with 256 agents tracked, the next reading resets the candidates and the earlier one is kept', () => {
    // 254 others + x = 255 agents tracked: the second x finds its candidate and replaces it
    const under = new Map<string, AgentEvent[]>()
    for (let i = 0; i < 254; i++) feed(under, 's', reading(`other-${i}`, 10))
    const x1 = reading('x', 10)
    feed(under, 's', x1, reading('x', 20))
    assert.equal(under.get('s')!.includes(x1), false, 'under the cap: replaced')

    // 255 others + x = 256 tracked agents: the next reading finds the map full, forgets it, and keeps the earlier one
    const atCap = new Map<string, AgentEvent[]>()
    for (let i = 0; i < 255; i++) feed(atCap, 's', reading(`other-${i}`, 10))
    const y1 = reading('x', 10)
    feed(atCap, 's', y1, reading('x', 20))
    assert.ok(atCap.get('s')!.includes(y1), 'at the cap: candidates forgotten, the earlier reading is kept')
  })

  it('provenance: replayed, imported and live readings never replace each other', () => {
    for (const [pa, pb] of [[{ replayed: true }, {}], [{}, { replayed: true }], [{ imported: true }, {}], [{}, { imported: true }]] as const) {
      const buffers = new Map<string, AgentEvent[]>()
      const a = reading('main', 10, pa as Partial<AgentEvent>), b = reading('main', 20, pb as Partial<AgentEvent>)
      feed(buffers, 's', a, b)
      assert.deepEqual(buffers.get('s'), [a, b], JSON.stringify([pa, pb]))
    }
    const buffers = new Map<string, AgentEvent[]>()
    const a = reading('main', 10, { replayed: true }), b = reading('main', 20, { replayed: true })
    feed(buffers, 's', a, b)
    assert.deepEqual(buffers.get('s'), [b], 'same provenance: replaced')
  })

  it('isolation: candidates are per session (interleaved sessions, a non-neutral event elsewhere)', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const evicted = createEvictedTally()
    const a = reading('main', 10), b = reading('main', 20), a2 = reading('main', 30)
    appendBounded(buffers, 'one', a, limits, evicted)
    appendBounded(buffers, 'two', b, limits, evicted)
    // a non-neutral event in session two must not end the candidacy of session one
    const spawn = { time: 1, type: 'agent_spawn', payload: { name: 'x' }, sessionId: 'two' } as unknown as AgentEvent
    appendBounded(buffers, 'two', spawn, limits, evicted)
    appendBounded(buffers, 'one', a2, limits, evicted)
    assert.deepEqual(buffers.get('one'), [a2], 'a is replaced in its own session')
    assert.deepEqual(buffers.get('two'), [b, spawn], 'the other session is untouched')
    assert.equal(evicted.bySession.size, 0, 'a replaced reading is not a loss')
  })
})
