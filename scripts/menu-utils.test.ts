import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextTrapTarget, unseenCount, clampSeen } from '../web/lib/menu-utils'

test('nextTrapTarget wraps at both ends and otherwise defers to the browser', () => {
  assert.equal(nextTrapTarget(2, 3, false), 'first')
  assert.equal(nextTrapTarget(0, 3, true), 'last')
  assert.equal(nextTrapTarget(1, 3, false), null)
  assert.equal(nextTrapTarget(1, 3, true), null)
})

test('nextTrapTarget handles focus on the container or no focusables', () => {
  assert.equal(nextTrapTarget(-1, 3, false), 'first')
  assert.equal(nextTrapTarget(-1, 3, true), 'last')
  assert.equal(nextTrapTarget(-1, 0, false), 'first')
})

test('unseenCount and clampSeen survive a shrinking conversation', () => {
  assert.equal(unseenCount(10, 4), 6)
  assert.equal(unseenCount(3, 8), 0)
  assert.equal(clampSeen(8, 3), 3)
  assert.equal(clampSeen(2, 3), 2)
  assert.equal(unseenCount(5, clampSeen(8, 3)), 2)
})

import { isFocusInOtherDialog, panelStopPropagationHandlers, stopPropagationHandlers } from '../web/lib/menu-utils'

test('isFocusInOtherDialog: dialog elsewhere owns focus', () => {
  const active = { closest: () => ({}) as unknown as Element }
  assert.equal(isFocusInOtherDialog(active, { contains: () => false }), true)
})

test('isFocusInOtherDialog: dialog inside the panel does not count', () => {
  const active = { closest: () => ({}) as unknown as Element }
  assert.equal(isFocusInOtherDialog(active, { contains: () => true }), false)
})

test('isFocusInOtherDialog: no dialog or no element', () => {
  assert.equal(isFocusInOtherDialog({ closest: () => null }, { contains: () => false }), false)
  assert.equal(isFocusInOtherDialog(null, null), false)
  assert.equal(isFocusInOtherDialog({}, null), false)
})

test('panelStopPropagationHandlers lets mousedown bubble (useClickOutside)', () => {
  assert.equal('onMouseDown' in panelStopPropagationHandlers, false)
  assert.equal('onMouseDown' in stopPropagationHandlers, true)
})
