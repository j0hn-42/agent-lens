// #380 (4.1.2): "Toggle stats" and "Toggle grid" carry the real state of the overlay they switch (menuitemcheckbox +
// aria-checked), on the canvas menu and on the agent menu.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { contextMenuItems } from '@/components/agent-visualizer/context-menu-items'

const noop = () => {}
const actions = (showStats: boolean, showGrid: boolean) => ({
  showStats, showGrid, toggleStats: noop, zoomToFit: noop, toggleGrid: noop, clearHistory: noop, reloadSessionEvents: null,
})
const find = (items: ReturnType<typeof contextMenuItems>, label: string) => items.find(i => i.label === label)

test('canvas menu: Toggle stats and Toggle grid expose the current state', () => {
  const on = contextMenuItems(false, actions(true, false))
  assert.equal(find(on, 'Toggle stats')?.checked, true)
  assert.equal(find(on, 'Toggle grid')?.checked, false)
  const off = contextMenuItems(false, actions(false, true))
  assert.equal(find(off, 'Toggle stats')?.checked, false)
  assert.equal(find(off, 'Toggle grid')?.checked, true)
  assert.deepEqual(off.filter(i => i.checked !== undefined).map(i => i.label), ['Toggle stats', 'Toggle grid'], 'only the two toggles carry a state')
})

test('agent menu: Toggle stats exposes the current state', () => {
  assert.equal(find(contextMenuItems(true, actions(true, false)), 'Toggle stats')?.checked, true)
  assert.equal(find(contextMenuItems(true, actions(false, false)), 'Toggle stats')?.checked, false)
})
