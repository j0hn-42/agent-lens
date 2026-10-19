import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildTimelineRows, timelineBlockState, computeTimelineRange, timelineMarkers } from '../web/lib/timeline-rows'
import { formatDuration } from '../web/lib/utils'
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

test('range', () => {
  assert.deepEqual(computeTimelineRange(entries, 20), { minTime: 0, maxTime: 70 })
})

// #378: the header labels of the Timeline were spaced by the time span only (1 s up to 10 s, 2 s up to 20 s,
// 5 s up to 60 s, then 10 s), whatever the width. At 390 px the bar is 236 px wide: a 9.5 s span drew ten "0:0x"
// labels 24.8 px apart, each 26.5 px wide ("0:000:010:02..."), and the last one was cut by the canvas edge.
const LABEL_W = 26.5 // "0:00" in 11px monospace, measured in Chromium
const LABEL_GAP = 6 // smallest space between two labels
const barStart = 104
const labelsOf = (markers: ReturnType<typeof timelineMarkers>) => markers.filter(m => m.labelled)

for (const [canvasWidth, span] of [[340, 9.5], [340, 19.5], [340, 59], [340, 125], [270, 9.5], [270, 59], [270, 600]] as const) {
  test(`timeline markers: labels never touch nor leave the canvas (${canvasWidth} px, ${span} s)`, () => {
    const markers = timelineMarkers(0, span, barStart, canvasWidth - barStart, LABEL_W, canvasWidth)
    const labels = labelsOf(markers)
    assert.ok(labels.length >= 2, `at least two labels give the scale (got ${labels.length})`)
    for (let i = 1; i < labels.length; i++) {
      const gap = labels[i].labelX - labels[i - 1].labelX - LABEL_W
      assert.ok(gap >= LABEL_GAP, `${formatDuration(labels[i - 1].t)} and ${formatDuration(labels[i].t)} are ${gap.toFixed(1)} px apart`)
    }
    for (const m of labels) {
      assert.ok(m.labelX - LABEL_W / 2 >= 0 && m.labelX + LABEL_W / 2 <= canvasWidth, `${formatDuration(m.t)} at ${m.labelX.toFixed(1)} is cut by the edge`)
      // A label moved off its line stays against it: the line is under the label or at its right end
      assert.ok(Math.abs(m.labelX - m.x) <= LABEL_W / 2 + 0.01, `${formatDuration(m.t)} drawn ${(m.labelX - m.x).toFixed(1)} px from its line`)
    }
    for (const m of markers) assert.ok(m.x >= barStart - 0.01 && m.x <= canvasWidth + 0.01, 'marker lines stay on the bar')
  })
}

test('timeline markers: a one-second span still shows both ends, the last one moved inside the edge', () => {
  const markers = timelineMarkers(0, 1, barStart, 236, LABEL_W, 340)
  assert.deepEqual(markers.filter(m => m.labelled).map(m => m.t), [0, 1])
  assert.equal(markers[1].labelX + LABEL_W / 2, 340)
})

test('timeline markers: a wide panel keeps the old steps (1 s up to 10 s, 10 s past one minute)', () => {
  const short = timelineMarkers(0, 10, barStart, 570, LABEL_W, 674)
  assert.deepEqual(short.map(m => m.t), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  const long = timelineMarkers(0, 120, barStart, 570, LABEL_W, 674)
  assert.deepEqual(long.map(m => m.t).slice(0, 3), [0, 10, 20])
})

test('timeline markers: the steps are round durations and start on a multiple of the step', () => {
  const markers = timelineMarkers(7, 400, barStart, 166, LABEL_W, 270)
  const steps = new Set(markers.slice(1).map((m, i) => m.t - markers[i].t))
  assert.equal(steps.size, 1)
  const [step] = steps
  assert.ok([1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].includes(step), `step ${step}`)
  assert.equal(markers[0].t % step, 0)
})
