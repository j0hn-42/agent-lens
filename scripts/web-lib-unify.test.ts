// Characterization of the helpers that web/lib exposes twice (#222): tab navigation, focus ring, m:ss time.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTabIndex as chromeNextTabIndex, FOCUS_RING as CHROME_RING } from '../web/lib/chrome-utils'
import { nextTabIndex as feedNextTabIndex, FOCUS_RING as FEED_RING, formatElapsed } from '../web/lib/feed-utils'
import { formatDuration } from '../web/lib/utils'
import { formatLinkTime } from '../web/components/agent-visualizer/canvas/link-panel-model'

test('characterization: chrome nextTabIndex is horizontal only, feed nextTabIndex also handles up/down', () => {
  assert.equal(chromeNextTabIndex(0, 'ArrowLeft', 3), 2)
  assert.equal(chromeNextTabIndex(2, 'ArrowRight', 3), 0)
  assert.equal(chromeNextTabIndex(1, 'Home', 3), 0)
  assert.equal(chromeNextTabIndex(1, 'End', 3), 2)
  assert.equal(chromeNextTabIndex(1, 'ArrowDown', 3), null)
  assert.equal(chromeNextTabIndex(0, 'ArrowRight', 0), null)
  assert.equal(feedNextTabIndex('ArrowLeft', 0, 3), 2)
  assert.equal(feedNextTabIndex('ArrowDown', 2, 3), 0)
  assert.equal(feedNextTabIndex('ArrowUp', 0, 3), 2)
  assert.equal(feedNextTabIndex('Enter', 0, 3), null)
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
