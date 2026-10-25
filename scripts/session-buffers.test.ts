import './all-locales'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  createSessionBuffers, appendSessionEvent, releaseSessionBuffer, sessionEventCount, sessionEventsFrom,
  eventsLostSinceSnapshot,
} from '../web/lib/session-buffers'
import type { SimulationEvent } from '../web/lib/agent-types'

const ev = (sessionId: string, time: number, type: string): SimulationEvent =>
  ({ time, type, sessionId, payload: { agent: 'main', tool: 'Read', pad: 'x'.repeat(200) } }) as unknown as SimulationEvent

// #613: a snapshot cached at count N is resumed from N; when the buffer's base went past N (the session was freed
// or trimmed meanwhile) the events between N and the base are gone, and the view must not pretend to continue.
test('eventsLostSinceSnapshot: events between the snapshot and the buffer base, 0 when it can be resumed (#613)', () => {
  assert.equal(eventsLostSinceSnapshot(100, 0), 0)
  assert.equal(eventsLostSinceSnapshot(100, 100), 0, 'base at the snapshot: nothing between')
  assert.equal(eventsLostSinceSnapshot(100, 160), 60)
  assert.equal(eventsLostSinceSnapshot(0, 5), 5)
})

test('session buffers: a snapshot older than a freed session cannot be resumed, the gap is what the base counts (#613)', () => {
  const s = createSessionBuffers()
  for (let i = 0; i < 100; i++) appendSessionEvent(s, 'a', ev('a', i, i === 0 ? 'agent_spawn' : 'tool_call_start'), 'a')
  const snapshotCount = sessionEventCount(s, 'a')
  // The byte cap frees 'a' while another session is being written, then 'a' receives 20 more events
  releaseSessionBuffer(s, 'a')
  for (let i = 100; i < 120; i++) appendSessionEvent(s, 'a', ev('a', i, 'tool_call_start'), 'b')
  const base = sessionEventCount(s, 'a') - sessionEventsFrom(s, 'a', 0).length
  assert.equal(base, 100)
  assert.equal(eventsLostSinceSnapshot(snapshotCount, base), 0, 'a snapshot taken at the release point resumes cleanly')
  assert.equal(eventsLostSinceSnapshot(40, base), 60, 'a snapshot taken earlier lost the events up to the base')
})

// #613: documented in docs/performance.md and reading-the-ui/relay-and-losses.md: what a freed session
// that receives events again holds.
test('session buffers: a freed session that receives events again restarts without its lifecycle events (#613)', () => {
  const s = createSessionBuffers()
  appendSessionEvent(s, 'a', ev('a', 0, 'agent_spawn'), 'a')
  appendSessionEvent(s, 'a', ev('a', 1, 'team_info'), 'a')
  for (let i = 2; i < 10; i++) appendSessionEvent(s, 'a', ev('a', i, 'tool_call_start'), 'a')
  releaseSessionBuffer(s, 'a')
  appendSessionEvent(s, 'a', ev('a', 10, 'tool_call_start'), 'b')
  const held = sessionEventsFrom(s, 'a', 0)
  assert.deepEqual(held.map(e => e.type), ['tool_call_start'])
  assert.equal(sessionEventCount(s, 'a'), 11, 'positions stay absolute')
})
