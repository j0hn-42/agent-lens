import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { trimOldest } from '../web/lib/bounded-buffer'
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

test('trimOldest: nothing happens below cap + slack, then one batch brings the buffer to the cap (#659)', () => {
  const buf: number[] = []
  let dropped = 0
  const cap = 1000
  const slackLimit = cap + Math.floor(cap * 0.1)
  for (let i = 0; i < slackLimit; i++) { buf.push(i); dropped += trimOldest(buf, cap) }
  assert.equal(dropped, 0)
  buf.push(slackLimit); dropped += trimOldest(buf, cap)
  assert.equal(buf.length, cap)
  assert.equal(dropped, slackLimit + 1 - cap)
  assert.equal(buf[0], dropped) // the oldest were dropped, order kept
  assert.equal(buf[buf.length - 1], slackLimit)
})

test('trimOldest: the number of moved elements is amortized O(1) per push (#659)', () => {
  const cap = 10_000
  const buf: number[] = []
  let moved = 0
  const N = 200_000
  for (let i = 0; i < N; i++) {
    buf.push(i)
    const d = trimOldest(buf, cap)
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
