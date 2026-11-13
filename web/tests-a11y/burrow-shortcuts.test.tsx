// Burrow view: the L shortcut moves the focus to the keyboard list; a right click on an animal opens the agent menu
// without the graph-only items.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'

import { BurrowAgentList, focusBurrowAgentList } from '@/components/agent-visualizer/burrow-agent-list'
import { contextMenuItems, type ContextMenuActions } from '@/components/agent-visualizer/context-menu-items'
import type { BurrowRow } from '@/lib/burrow/burrow-sync'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const rows: BurrowRow[] = [
  { id: 's1:a', name: 'alpha', presence: 'in', room: 'lounge', state: 'idle', stale: false, parentId: null, depth: 0 },
  { id: 's1:b', name: 'beta', presence: 'in', room: 'lounge', state: 'idle', stale: false, parentId: null, depth: 0 },
]

test('focusBurrowAgentList puts the focus on the first button of the list', () => {
  render(<BurrowAgentList label="Burrow agents" rows={rows} selectedAgentId={null} rowLabel={(r) => r.name} onAgentClick={() => {}} onAgentHover={() => {}} />)
  assert.equal(focusBurrowAgentList(), true)
  assert.equal(document.activeElement?.textContent, 'alpha')
})

test('focusBurrowAgentList says so when there is no list (nothing to focus)', () => {
  assert.equal(focusBurrowAgentList(), false)
})

const actions: ContextMenuActions = {
  showStats: false, showGrid: false, toggleStats() {}, zoomToFit() {}, toggleGrid() {}, clearHistory() {}, reloadSessionEvents: null,
  showAgentDetails: () => {},
}

test('the agent menu of the burrow keeps the details and drops the zoom and the stats of the graph', () => {
  const labels = contextMenuItems(true, { ...actions, inBurrow: true }).map(i => i.label)
  assert.equal(labels.length, 1)
  assert.equal(contextMenuItems(true, actions).length, 3, 'the graph keeps its three items')
})
