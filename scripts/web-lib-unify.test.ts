// Characterization of the helpers that web/lib exposes twice (#222): tab navigation, focus ring, m:ss time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOCUS_RING as CHROME_RING } from '../web/lib/chrome-utils'
import { nextTabIndex } from '../web/lib/tab-nav'
import { FOCUS_RING as FEED_RING, formatElapsed } from '../web/lib/feed-utils'
import { formatDuration } from '../web/lib/utils'
import { buildLinkPanelModel } from '../web/components/agent-visualizer/canvas/link-panel-model'

function linkTimeText(seconds: number): string {
  const link: any = {
    id: 'L1', from: 's1:lead', to: 's1:alice', kind: 'teammate', sessionId: 's1', dropped: 0,
    messages: [{ id: 'm1', type: 'message', content: 'hello', timestamp: seconds }],
  }
  return buildLinkPanelModel(link, new Map()).entries[0].timeText
}

test('nextTabIndex: one signature (current, key, count, orientation), horizontal by default', () => {
  assert.equal(nextTabIndex(0, 'ArrowLeft', 3), 2)
  assert.equal(nextTabIndex(2, 'ArrowRight', 3), 0)
  assert.equal(nextTabIndex(1, 'Home', 3), 0)
  assert.equal(nextTabIndex(1, 'End', 3), 2)
  assert.equal(nextTabIndex(1, 'ArrowDown', 3), null)
  assert.equal(nextTabIndex(1, 'a', 3), null)
  assert.equal(nextTabIndex(0, 'ArrowRight', 0), null)
  assert.equal(nextTabIndex(0, 'Home', 0, 'both'), null)
})

test("nextTabIndex: 'both' orientation also handles Up/Down and wraps", () => {
  assert.equal(nextTabIndex(2, 'ArrowDown', 3, 'both'), 0)
  assert.equal(nextTabIndex(0, 'ArrowUp', 3, 'both'), 2)
  assert.equal(nextTabIndex(0, 'ArrowLeft', 3, 'both'), 2)
  assert.equal(nextTabIndex(0, 'Enter', 3, 'both'), null)
})

test('characterization: the two focus rings differ by offset and token', () => {
  assert.match(CHROME_RING, /outline-offset-2/)
  assert.match(CHROME_RING, /var\(--lens-focus\)/)
  assert.match(FEED_RING, /outline-offset-\[-2px\]/)
  assert.match(FEED_RING, /var\(--lens-focus-ring\)/)
})

test('simulation time: 59 s, 3599 s and 3600 s read the same in the control bar, the conversation and the Link panel', () => {
  for (const [seconds, text] of [[59, '0:59'], [3599, '59:59'], [3600, '1:00:00'], [4500, '1:15:00']] as const) {
    assert.equal(formatDuration(seconds), text, `formatDuration(${seconds})`)
    assert.equal(formatElapsed(seconds).label, text, `formatElapsed(${seconds})`)
    assert.equal(linkTimeText(seconds), text, `link panel at ${seconds}`)
  }
})

test('formatElapsed keeps its ISO duration and clamps bad input like formatDuration', () => {
  assert.deepEqual(formatElapsed(75.4), { label: '1:15', iso: 'PT75.4S' })
  assert.equal(formatElapsed(-3).label, '0:00')
  assert.equal(formatElapsed(NaN).iso, 'PT0.0S')
})
