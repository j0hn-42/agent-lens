/**
 * #79: a late SSE client must still see working / idle / done of every workflow agent, so the relay
 * replay buffer treats agent_activity like the other lifecycle events (chatter is evicted first).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentEvent } from '../src/protocol'
import { trimKeepingLifecycle } from '../src/relay-guards'

const ev = (type: AgentEvent['type'], name = 'a'): AgentEvent => ({ time: 0, type, payload: { name } })

describe('replay buffer and workflow agent activity', () => {
  it('evicts chatter before agent_activity', () => {
    const buf: AgentEvent[] = [ev('agent_activity', 'x'), ...Array.from({ length: 10 }, () => ev('message')), ev('agent_activity', 'y')]
    trimKeepingLifecycle(buf, 4)
    assert.equal(buf.length, 4)
    assert.deepEqual(buf.filter(e => e.type === 'agent_activity').map(e => e.payload.name), ['x', 'y'])
  })
})
