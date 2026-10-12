import { test } from 'node:test'
import assert from 'node:assert/strict'

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
