import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildTimelineRows, timelineAriaLabel, timelineBlockState, computeTimelineRange } from '../web/lib/timeline-rows'
import { SCENE } from '../web/lib/colors'
import type { TimelineEntry } from '../web/lib/agent-types'

const entries: TimelineEntry[] = [
  {
    id: 'a', agentId: 'a', agentName: 'orchestrator-with-a-long-name', startTime: 0, endTime: 30,
    blocks: [
      { id: '1', type: 'idle', startTime: 0, endTime: 5, label: 'Starting', color: SCENE.idle },
      { id: '2', type: 'idle', startTime: 5, endTime: 9, label: 'Permission', color: SCENE.waiting_permission },
      { id: '3', type: 'tool_call', startTime: 9, label: 'Read: x', color: SCENE.tool },
    ],
  },
  {
    id: 'b', agentId: 'b', agentName: 'sub', startTime: 4, endTime: 70,
    blocks: [{ id: '4', type: 'thinking', startTime: 4, endTime: 8, label: 'Thinking...', color: SCENE.error }],
  },
]

test('block state distinguishes permission and error from idle/thinking', () => {
  assert.equal(timelineBlockState(entries[0].blocks[1]), 'waiting_permission')
  assert.equal(timelineBlockState(entries[1].blocks[0]), 'error')
  assert.equal(timelineBlockState(entries[0].blocks[0]), 'idle')
})

test('rows keep full agent names and format times', () => {
  const rows = buildTimelineRows(entries)
  assert.equal(rows.length, 4)
  assert.equal(rows[0].agentName, 'orchestrator-with-a-long-name')
  assert.equal(rows[1].stateLabel, 'Waiting for permission')
  assert.equal(rows[2].end, 'ongoing')
  assert.equal(rows[2].endTime, null)
  assert.equal(rows[0].start, '0:00')
  assert.equal(rows[0].end, '0:05')
})

test('range and aria label', () => {
  assert.deepEqual(computeTimelineRange(entries, 20), { minTime: 0, maxTime: 70 })
  assert.equal(timelineAriaLabel(entries, 20), 'Timeline of 2 agents, from 0:00 to 1:10')
  assert.equal(timelineAriaLabel([entries[1]], 20), 'Timeline of 1 agent, from 0:04 to 1:10')
  assert.equal(timelineAriaLabel([], 0), 'Timeline: no data')
})
