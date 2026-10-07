import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  sessionStatusKind, nextTabIndex, scrubberKeyTarget, scrubberTimeFromX, scrubberValueText,
  formatAgentCounts, connectionDisplay, buildAnnouncement, formatMissedEvents,
  emptyStateChecklist, shouldRestoreFocus, toastRemaining, contextMenuPosition, runEscapeHandlers,
} from '../web/lib/chrome-utils'

test('session status: unseen activity beats active, selected tab never shows new activity', () => {
  assert.equal(sessionStatusKind({ status: 'active' }, true, false), 'new-activity')
  assert.equal(sessionStatusKind({ status: 'active' }, true, true), 'active')
  assert.equal(sessionStatusKind({ status: 'completed' }, false, false), 'completed')
})

test('tab arrow navigation wraps and supports Home/End', () => {
  assert.equal(nextTabIndex(2, 'ArrowRight', 3), 0)
  assert.equal(nextTabIndex(0, 'ArrowLeft', 3), 2)
  assert.equal(nextTabIndex(1, 'Home', 3), 0)
  assert.equal(nextTabIndex(1, 'End', 3), 2)
  assert.equal(nextTabIndex(1, 'a', 3), null)
  assert.equal(nextTabIndex(0, 'ArrowRight', 0), null)
})

test('scrubber keyboard steps are clamped', () => {
  assert.equal(scrubberKeyTarget('ArrowRight', false, 5, 100), 6)
  assert.equal(scrubberKeyTarget('ArrowRight', true, 5, 100), 15)
  assert.equal(scrubberKeyTarget('ArrowLeft', false, 0, 100), 0)
  assert.equal(scrubberKeyTarget('End', false, 5, 100), 100)
  assert.equal(scrubberKeyTarget('ArrowRight', true, 95, 100), 100)
  assert.equal(scrubberKeyTarget('x', false, 5, 100), null)
})

test('scrubber pointer position maps to time', () => {
  assert.equal(scrubberTimeFromX(150, 100, 200, 60), 15)
  assert.equal(scrubberTimeFromX(0, 100, 200, 60), 0)
  assert.equal(scrubberTimeFromX(999, 100, 200, 60), 60)
  assert.equal(scrubberTimeFromX(150, 100, 0, 60), 0)
  assert.equal(scrubberValueText(75, 3725), '1:15 of 1:02:05')
})

test('agent counts text', () => {
  assert.equal(formatAgentCounts(2, 3), '5 agents: 2 active - 3 done')
  assert.equal(formatAgentCounts(1, 0), '1 agent: 1 active - 0 done')
})

test('connection badge: DEMO never shows as LIVE, connecting is distinct', () => {
  assert.equal(connectionDisplay('watching', true).label, 'DEMO')
  assert.equal(connectionDisplay('watching', false).label, 'LIVE')
  assert.equal(connectionDisplay('connected', false).label, 'CONNECTED')
  assert.equal(connectionDisplay('connecting', false).label, 'CONNECTING')
  assert.equal(connectionDisplay('disconnected', false).label, 'OFFLINE')
})

test('announcement and missed events', () => {
  const connection = connectionDisplay('watching', false)
  assert.equal(
    buildAnnouncement({ connection, sessionLabel: 'main', isReviewing: true, isEmpty: false }),
    'Connection: live. Session: main. Review mode',
  )
  assert.match(buildAnnouncement({ connection, sessionLabel: null, isReviewing: false, isEmpty: true }), /Waiting for an agent session/)
  assert.equal(formatMissedEvents(0), null)
  assert.equal(formatMissedEvents(1), '1 event missed while reviewing')
  assert.equal(formatMissedEvents(7), '7 events missed while reviewing')
})

test('empty-state checklist reflects connection and sessions', () => {
  const down = emptyStateChecklist({ status: 'disconnected', relayPort: '3001', sessionCount: 0 })
  assert.deepEqual(down.map(i => i.ok), [false, false, false])
  assert.match(down[0].detail ?? '', /:3001/)
  const up = emptyStateChecklist({ status: 'watching', sessionCount: 2 })
  assert.deepEqual(up.map(i => i.ok), [true, true, true])
})

test('focus is restored only from inside the panel or from body', () => {
  const body = {}
  const inside = {}
  const outside = {}
  const panel = { contains: (el: unknown) => el === inside }
  assert.equal(shouldRestoreFocus(inside, panel, body), true)
  assert.equal(shouldRestoreFocus(body, panel, body), true)
  assert.equal(shouldRestoreFocus(null, panel, body), true)
  assert.equal(shouldRestoreFocus(outside, panel, body), false)
})

test('toast remaining time shrinks while running and never goes negative', () => {
  assert.equal(toastRemaining(5000, 1000, 3000), 3000)
  assert.equal(toastRemaining(5000, 1000, 9000), 0)
  assert.equal(toastRemaining(5000, 1000, 500), 5000)
})

test('keyboard context menu falls back to the focused element centre', () => {
  const rect = { left: 100, top: 50, width: 40, height: 20 }
  assert.deepEqual(contextMenuPosition(0, 0, rect), { x: 120, y: 60 })
  assert.deepEqual(contextMenuPosition(0, 0, null), { x: 0, y: 0 })
  assert.deepEqual(contextMenuPosition(7, 9, rect), { x: 7, y: 9 })
})

test('escape handlers run newest first and stop at the first that closes something', () => {
  const calls: string[] = []
  const h = (name: string, result: boolean) => () => { calls.push(name); return result }
  assert.equal(runEscapeHandlers([h('a', true), h('b', false)]), true)
  assert.deepEqual(calls, ['b', 'a'])
  calls.length = 0
  assert.equal(runEscapeHandlers([h('a', false), h('b', false)]), false)
  assert.deepEqual(calls, ['b', 'a'])
  assert.equal(runEscapeHandlers([]), false)
})
