import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SHORTCUTS } from '../web/lib/shortcuts'
import { nextMenuIndex, clampMenuPosition } from '../web/lib/menu-nav'
import { getStateLabel } from '../web/lib/state-labels'

test('SHORTCUTS keys are unique and non-empty', () => {
  const keys = SHORTCUTS.map(s => s.key)
  assert.equal(new Set(keys).size, keys.length)
  for (const s of SHORTCUTS) {
    assert.ok(s.display.length > 0)
    assert.ok(s.description.length > 0)
  }
})

test('SHORTCUTS covers the keys handled by the hook', () => {
  const keys = new Set(SHORTCUTS.map(s => s.key))
  for (const k of [' ', 'f', 'F', 't', 'c', 'g', 's', '$', 'm', '1', '2', '3', '4', 'Escape', '?']) {
    assert.ok(keys.has(k), k)
  }
})

test('nextMenuIndex wraps and supports Home/End', () => {
  assert.equal(nextMenuIndex(0, 3, 'ArrowUp'), 2)
  assert.equal(nextMenuIndex(2, 3, 'ArrowDown'), 0)
  assert.equal(nextMenuIndex(1, 3, 'Home'), 0)
  assert.equal(nextMenuIndex(1, 3, 'End'), 2)
  assert.equal(nextMenuIndex(1, 3, 'a'), null)
  assert.equal(nextMenuIndex(0, 0, 'ArrowDown'), null)
})

test('clampMenuPosition keeps the menu in the viewport', () => {
  const vp = { width: 400, height: 300 }
  const size = { width: 160, height: 100 }
  assert.deepEqual(clampMenuPosition({ x: 390, y: 290 }, size, vp), { left: 232, top: 192 })
  assert.deepEqual(clampMenuPosition({ x: -5, y: -5 }, size, vp), { left: 8, top: 8 })
})

test('getStateLabel maps states to readable labels', () => {
  assert.equal(getStateLabel('tool_calling'), 'Calling tool')
  assert.equal(getStateLabel('waiting_permission'), 'Waiting for permission')
  assert.equal(getStateLabel('some_new_state'), 'some new state')
})
