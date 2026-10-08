/**
 * #79: a late SSE client must still see working / idle / done of every workflow agent, without ever
 * losing the agent_spawn / team_info that build the graph. The relay replay buffer keeps only the
 * LATEST agent_activity per agent (replaced in place) and never counts it as a lifecycle event.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { appendBounded, trimKeepingLifecycle, capReplayBatches } from '../src/relay-guards'
import { RELAY_REPLAY_LIFECYCLE_RESERVE } from '../src/constants'

const ev = (type: AgentEvent['type'], name = 'a', extra: Record<string, unknown> = {}): AgentEvent => ({ time: 0, type, payload: { name, ...extra } })

describe('replay buffer and workflow agent activity', () => {
  it('evicts chatter before agent_activity', () => {
    const buf: AgentEvent[] = [ev('agent_activity', 'x'), ...Array.from({ length: 10 }, () => ev('message')), ev('agent_activity', 'y')]
    trimKeepingLifecycle(buf, 4)
    assert.equal(buf.length, 4)
    assert.deepEqual(buf.filter(e => e.type === 'agent_activity').map(e => e.payload.name), ['x', 'y'])
  })

  it('keeps every spawn and team_info, and the latest activity of every agent, after >400 flips and 6000 messages', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const agents = 43
    const flips = 12 // 43 * 12 = 516 activity events > RELAY_REPLAY_LIFECYCLE_RESERVE
    assert.ok(agents * flips > RELAY_REPLAY_LIFECYCLE_RESERVE)
    for (let i = 0; i < agents; i++) appendBounded(buffers, 's1', ev('agent_spawn', `w${i}`))
    appendBounded(buffers, 's1', ev('team_info', 'x', { teamName: 'wf' }))
    for (let f = 0; f < flips; f++) {
      for (let i = 0; i < agents; i++) appendBounded(buffers, 's1', ev('agent_activity', `w${i}`, { activity: f % 2 ? 'working' : 'idle', flip: f }))
    }
    for (let m = 0; m < 6000; m++) appendBounded(buffers, 's1', ev('message', 'main'))
    const buf = buffers.get('s1')!
    assert.equal(buf.filter(e => e.type === 'agent_spawn').length, agents)
    assert.equal(buf.filter(e => e.type === 'team_info').length, 1)
    for (let i = 0; i < agents; i++) {
      const acts = buf.filter(e => e.type === 'agent_activity' && e.payload.name === `w${i}`)
      assert.equal(acts.length, 1, `one activity for w${i}`)
      assert.equal(acts[0].payload.flip, flips - 1, `latest activity for w${i}`)
    }
  })

  it('replaces the activity of an agent in place (after its spawn) and keeps other agents apart', () => {
    const buffers = new Map<string, AgentEvent[]>()
    appendBounded(buffers, 's', ev('agent_spawn', 'a'))
    appendBounded(buffers, 's', ev('agent_activity', 'a', { activity: 'working' }))
    appendBounded(buffers, 's', ev('agent_spawn', 'b'))
    appendBounded(buffers, 's', ev('agent_activity', 'b', { activity: 'working' }))
    appendBounded(buffers, 's', ev('agent_activity', 'a', { activity: 'done' }))
    const buf = buffers.get('s')!
    assert.deepEqual(buf.map(e => `${e.type}:${e.payload.name}:${e.payload.activity ?? ''}`),
      ['agent_spawn:a:', 'agent_activity:a:done', 'agent_spawn:b:', 'agent_activity:b:working'])
  })

  it('does not merge activity of same-named agents of different sessions', () => {
    const buffers = new Map<string, AgentEvent[]>()
    appendBounded(buffers, 's1', ev('agent_activity', 'a', { activity: 'working' }))
    appendBounded(buffers, 's2', ev('agent_activity', 'a', { activity: 'idle' }))
    assert.equal(buffers.get('s1')!.length, 1)
    assert.equal(buffers.get('s2')!.length, 1)
  })

  it('activity never counts toward the lifecycle reserve: 250 agents (spawns + activities > 400) keep every spawn', () => {
    const buffers = new Map<string, AgentEvent[]>()
    const agents = 250
    assert.ok(agents * 2 > RELAY_REPLAY_LIFECYCLE_RESERVE, 'precondition: spawns + activities exceed the reserve')
    for (let i = 0; i < agents; i++) appendBounded(buffers, 's1', ev('agent_spawn', `w${i}`))
    for (let i = 0; i < agents; i++) appendBounded(buffers, 's1', ev('agent_activity', `w${i}`, { activity: 'working' }))
    for (let m = 0; m < 6000; m++) appendBounded(buffers, 's1', ev('message', 'main'))
    const buf = buffers.get('s1')!
    assert.equal(buf.filter(e => e.type === 'agent_spawn').length, agents, 'no spawn evicted by activity events')
  })

  it('capReplayBatches re-adds the latest activity cut off by the per-session cap, in front of the kept tail', () => {
    const events: AgentEvent[] = [
      ev('agent_spawn', 'a'),
      ev('agent_activity', 'a', { activity: 'working' }),
      ...Array.from({ length: 50 }, () => ev('message', 'main')),
    ]
    const [batch] = capReplayBatches([{ type: 'agent-event-batch', events }], { perSession: 10, total: 1000, batchSize: 1000 })
    const types = batch.events.map(e => e.type)
    assert.equal(types.filter(t => t === 'agent_spawn').length, 1, 'cut spawn restored')
    assert.equal(types.filter(t => t === 'agent_activity').length, 1, 'cut activity restored')
    assert.ok(types.indexOf('agent_activity') < types.indexOf('message'), 'restored events come before the kept tail')
  })
})
