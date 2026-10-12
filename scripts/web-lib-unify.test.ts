// Characterization of the helpers that web/lib exposes twice (#222): tab navigation, focus ring, m:ss time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOCUS_RING as CHROME_RING } from '../web/lib/chrome-utils'
import { nextTabIndex } from '../web/lib/tab-nav'
import { FOCUS_RING as FEED_RING, formatElapsed } from '../web/lib/feed-utils'
import { formatDuration } from '../web/lib/utils'
import { formatLinkTime } from '../web/components/agent-visualizer/canvas/link-panel-model'

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

test('characterization: formatDuration shows hours, the two other formatters never do', () => {
  assert.equal(formatDuration(59), '0:59')
  assert.equal(formatDuration(3599), '59:59')
  assert.equal(formatDuration(3600), '1:00:00')
  assert.equal(formatElapsed(59).label, '0:59')
  assert.equal(formatElapsed(3599).label, '59:59')
  assert.equal(formatElapsed(3600).label, '60:00')
  assert.equal(formatLinkTime(59), '0:59')
  assert.equal(formatLinkTime(3599), '59:59')
  assert.equal(formatLinkTime(3600), '60:00')
})
