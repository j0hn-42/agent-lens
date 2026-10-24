import './all-locales' // #662: both languages are loaded before the tests
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { pushBounded, estimateEventBytes } from '../web/lib/bounded-buffer'
import {
  createSessionBuffers, appendSessionEvent, sessionEventCount, sessionEventsFrom, releaseSessionBuffer, clearSessionBuffers, type SessionBuffers,
} from '../web/lib/session-buffers'
import type { SimulationEvent } from '../web/lib/agent-types'
import { processEvent, pushTimelineBlock, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState } from '../web/hooks/simulation/types'
import { visibleRowRange } from '../web/lib/timeline-rows'
import { olderBlocksText, totalDroppedBlocks } from '../web/lib/timeline-text'
import { SCENE } from '../web/lib/colors'
import type { TimelineEntry } from '../web/lib/agent-types'

/** Cap per agent, as documented (2 000). */
const MAX_TIMELINE_BLOCKS = 2000

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }), getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 }, skipForceSync: true,
}

const NO_BYTE_CAP = Number.MAX_SAFE_INTEGER

test('pushBounded: nothing happens below cap + slack, then one batch brings the buffer to the cap (#659)', () => {
  const buf: number[][] = []
  let dropped = 0
  const cap = 1000
  const slackLimit = cap + Math.floor(cap * 0.1)
  for (let i = 0; i < slackLimit; i++) dropped += pushBounded(buf, [i], cap, NO_BYTE_CAP)
  assert.equal(dropped, 0)
  dropped += pushBounded(buf, [slackLimit], cap, NO_BYTE_CAP)
  assert.equal(buf.length, cap)
  assert.equal(dropped, slackLimit + 1 - cap)
  assert.equal(buf[0][0], dropped) // the oldest were dropped, order kept
  assert.equal(buf[buf.length - 1][0], slackLimit)
})

test('pushBounded: the number of moved elements is amortized O(1) per push (#659)', () => {
  const cap = 10_000
  const buf: number[][] = []
  let moved = 0
  const N = 200_000
  for (let i = 0; i < N; i++) {
    const d = pushBounded(buf, [i], cap, NO_BYTE_CAP)
    if (d > 0) moved += buf.length // splice moves the remaining elements once
  }
  assert.ok(buf.length <= cap + cap * 0.1)
  assert.ok(moved / N < 15, `moved per push: ${moved / N}`) // the old per-push splice moved ~cap (10 000) per push
})

test('pushTimelineBlock caps the blocks of an agent and counts what it dropped (#659)', () => {
  let entry: TimelineEntry = { id: 't', agentId: 'a', agentName: 'a', startTime: 0, blocks: [] }
  const total = MAX_TIMELINE_BLOCKS * 3
  for (let i = 0; i < total; i++) entry = pushTimelineBlock(entry, i, { type: 'tool_call', label: `Read: f${i}`, color: SCENE.tool }, ctx)
  assert.ok(entry.blocks.length <= MAX_TIMELINE_BLOCKS)
  assert.ok(entry.blocks.length > 0)
  assert.equal(entry.blocks.length + (entry.droppedBlocks ?? 0), total, 'nothing is lost silently: kept + dropped = pushed')
  assert.equal(entry.blocks[entry.blocks.length - 1].label, `Read: f${total - 1}`)
})

test('pushTimelineBlock leaves a short timeline untouched, with no counter (#659)', () => {
  let entry: TimelineEntry = { id: 't', agentId: 'a', agentName: 'a', startTime: 0, blocks: [] }
  for (let i = 0; i < 10; i++) entry = pushTimelineBlock(entry, i, { type: 'idle', label: 'x', color: SCENE.idle }, ctx)
  assert.equal(entry.blocks.length, 10)
  assert.equal(entry.droppedBlocks, undefined)
})

test('tool calls through processEvent stay capped and counted (#659)', () => {
  let state = createEmptyState()
  state = processEvent({ time: 1, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } }, { ...state, currentTime: 1 }, ctx)
  const n = MAX_TIMELINE_BLOCKS + 300
  for (let i = 0; i < n; i++) {
    const t = 2 + i
    state = processEvent({ time: t, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Read', args: `f${i}`, toolUseId: `u${i}` } }, { ...state, currentTime: t }, ctx)
    state = processEvent({ time: t + 0.5, type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Read', result: 'ok', toolUseId: `u${i}` } }, { ...state, currentTime: t + 0.5 }, ctx)
  }
  const entry = [...state.timelineEntries.values()][0]
  assert.ok(entry.blocks.length <= MAX_TIMELINE_BLOCKS)
  assert.ok((entry.droppedBlocks ?? 0) > 0)
  assert.equal(totalDroppedBlocks(state.timelineEntries.values()), entry.droppedBlocks)
})

test('visibleRowRange returns only the rows in view, with an overscan (#659)', () => {
  assert.deepEqual(visibleRowRange(0, 300, 1000, 22, 24, 0), { first: 0, last: 12 })
  const mid = visibleRowRange(24 * 500 + 22, 300, 1000, 22, 24, 2)
  assert.ok(mid.first >= 497 && mid.first <= 500)
  assert.ok(mid.last - mid.first <= 12 + 8)
  assert.deepEqual(visibleRowRange(0, 300, 3, 22, 24, 2), { first: 0, last: 2 })
  assert.deepEqual(visibleRowRange(0, 300, 0, 22, 24, 2), { first: 0, last: -1 })
})

test('olderBlocksText: singular and plural, in both languages (#659)', () => {
  assert.equal(olderBlocksText('fr', 1), '1 bloc plus ancien non affiché')
  assert.equal(olderBlocksText('fr', 1500), `${new Intl.NumberFormat('fr').format(1500)} blocs plus anciens non affichés`)
  assert.equal(olderBlocksText('en', 1), '1 older block not shown')
  assert.equal(olderBlocksText('en', 1500), '1,500 older blocks not shown')
})

// ─── Byte caps (#659): full buffers retained 314 MB with real payloads, measured (docs/performance.md) ──

const heldBytes = (s: SessionBuffers) => s.totalBytes

const big = (sessionId: string, time: number, chars: number, type = 'message'): SimulationEvent =>
  ({ time, type: type as SimulationEvent['type'], payload: { agent: 'main', content: 'x'.repeat(chars) }, sessionId })

test('estimateEventBytes follows the serialized size of the event (#659)', () => {
  const small = estimateEventBytes(big('a', 0, 10))
  const large = estimateEventBytes(big('a', 0, 10_010))
  assert.ok(large - small >= 10_000 && large - small <= 10_100, `${small} -> ${large}`)
})

test('pushBounded: a byte cap trims the oldest in one batch and counts every dropped event (#659)', () => {
  const buf: SimulationEvent[] = []
  const capBytes = 100_000
  let dropped = 0
  const n = 400
  for (let i = 0; i < n; i++) dropped += pushBounded(buf, big('a', i, 1000), 1_000_000, capBytes)
  const held = buf.reduce((a, e) => a + estimateEventBytes(e), 0)
  assert.ok(held <= capBytes * 1.1, `bytes ${held}`)
  assert.ok(buf.length < n)
  assert.equal(buf.length + dropped, n, 'kept + dropped = pushed: the base counter sees every drop')
  assert.equal(buf[0].time, dropped, 'the oldest went first')
  assert.equal(buf[buf.length - 1].time, n - 1)
  // The count cap still applies
  const b2: number[][] = []
  let d2 = 0
  for (let i = 0; i < 2000; i++) d2 += pushBounded(b2, [i], 1000, NO_BYTE_CAP)
  assert.ok(b2.length <= 1100)
  assert.equal(b2.length + d2, 2000)
})

test('pushBounded: one event larger than the cap is kept (the newest is never dropped) (#659)', () => {
  const buf: SimulationEvent[] = []
  pushBounded(buf, big('a', 0, 10), 100, 1000)
  const d = pushBounded(buf, big('a', 1, 5000), 100, 1000)
  assert.equal(d, 1)
  assert.deepEqual(buf.map(e => e.time), [1])
})

test('session buffers: the byte cap frees the least recently written sessions, their count kept (#659)', () => {
  const s = createSessionBuffers()
  const capBytes = 200_000
  for (let k = 0; k < 10; k++) {
    for (let i = 0; i < 50; i++) appendSessionEvent(s, `s${k}`, big(`s${k}`, i, 1000), 's0', 5000, 50, capBytes)
  }
  assert.ok(heldBytes(s) <= capBytes, `bytes ${heldBytes(s)}`)
  assert.ok(s.events.has('s0'), 'the protected session is kept')
  assert.ok(s.events.has('s9'), 'the session being written is kept')
  assert.ok(!s.events.has('s1'), 'the least recently written went first')
  for (let k = 0; k < 10; k++) assert.equal(sessionEventCount(s, `s${k}`), 50, `s${k}: positions stay absolute, nothing lost silently`)
  // Release and clear give the bytes back
  const before = heldBytes(s)
  releaseSessionBuffer(s, 's9')
  assert.ok(heldBytes(s) < before)
  clearSessionBuffers(s)
  assert.equal(heldBytes(s), 0)
})

test('session buffers: one session above the byte cap drops its oldest events, counted in its base (#659)', () => {
  const s = createSessionBuffers()
  const capBytes = 100_000
  appendSessionEvent(s, 'a', big('a', 0, 10, 'agent_spawn'), 'a', 5000, 50, capBytes)
  for (let i = 1; i < 300; i++) appendSessionEvent(s, 'a', big('a', i, 1000), 'a', 5000, 50, capBytes)
  assert.ok(heldBytes(s) <= capBytes, `bytes ${heldBytes(s)}`)
  const kept = sessionEventsFrom(s, 'a', 0)
  assert.ok(kept.length < 300)
  assert.equal(sessionEventCount(s, 'a'), 300, 'dropped events are counted in the base')
  assert.equal(kept[0].type, 'agent_spawn', 'the lifecycle event survives the byte trim')
  assert.equal(kept[kept.length - 1].time, 299)
})

test('session buffers: the count trim gives its bytes back (#659)', () => {
  const s = createSessionBuffers()
  for (let i = 0; i < 30; i++) appendSessionEvent(s, 'a', big('a', i, 1000), null, 10, 50, 1e9)
  const one = estimateEventBytes(big('a', 0, 1000))
  assert.ok(Math.abs(heldBytes(s) - 10 * one) <= 20, `${heldBytes(s)} vs ${10 * one}`)
})
