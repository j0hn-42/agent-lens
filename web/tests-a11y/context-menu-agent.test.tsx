// #377 (discoverability): the agent context menu offered only "Toggle stats". It now also opens the agent's
// details and zooms to fit, with the menu's keyboard roving (glass-context-menu) unchanged.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'

import { contextMenuItems } from '@/components/agent-visualizer/context-menu-items'
import { GlassContextMenu } from '@/components/agent-visualizer/glass-context-menu'
import { SelectionOverlays } from '@/components/agent-visualizer/selection-overlays'

const noop = () => {}
const base = { showStats: false, showGrid: false, toggleStats: noop, zoomToFit: noop, toggleGrid: noop, clearHistory: noop, reloadSessionEvents: null }

test('agent menu: Show details, Zoom to fit, then Toggle stats', () => {
  const items = contextMenuItems(true, { ...base, showAgentDetails: noop })
  assert.deepEqual(items.map(i => i.label), ['Show details', 'Zoom to fit', 'Toggle stats'])
})

test('agent menu: Show details runs the given action, and is absent without one', () => {
  let opened = 0
  const items = contextMenuItems(true, { ...base, showAgentDetails: () => { opened++ } })
  items.find(i => i.label === 'Show details')!.onClick()
  assert.equal(opened, 1)
  assert.equal(contextMenuItems(true, { ...base, showAgentDetails: null }).some(i => i.label === 'Show details'), false)
})

test('agent menu: the canvas menu does not gain Show details', () => {
  assert.equal(contextMenuItems(false, { ...base, showAgentDetails: noop }).some(i => i.label === 'Show details'), false)
})

/** SelectionOverlays with the agent menu of `a1` open, recording what its items call */
function renderAgentMenu() {
  const calls: string[] = []
  const props = {
    selection: { contextMenu: { x: 10, y: 10, agentId: 'a1' }, setContextMenu: noop, handleAgentClick: (id: string | null) => calls.push(`select:${id}`) },
    inspector: { selectedAgent: null, selectedGone: false, goneName: null, delegation: [], toolWhy: null },
    agents: new Map(), links: new Map(), droppedMessages: new Map(),
    health: { byAgent: new Map(), bySession: new Map() },
    bridge: { relayOrigin: null, launch: null, eventLoss: null },
    selectedLinkId: null, onCloseLink: noop, onEscapeFromCard: noop,
    menuActions: { ...base, zoomToFit: () => calls.push('zoom') },
  } as unknown as React.ComponentProps<typeof SelectionOverlays>
  return { calls, view: render(<SelectionOverlays {...props} />) }
}

test('agent menu in the overlays: Show details selects the right-clicked agent', () => {
  const { calls, view } = renderAgentMenu()
  try {
    fireEvent.click(view.getByRole('menuitem', { name: 'Show details' }))
    assert.deepEqual(calls, ['select:a1'])
  } finally {
    cleanup()
  }
})

test('agent menu in the overlays: Zoom to fit selects the right-clicked agent, then frames it', () => {
  // The fit scope is the selected agent (computeFitTransform); right-clicking does not select, so another
  // agent may be selected when the menu opens: the item selects its own agent first (#377).
  const { calls, view } = renderAgentMenu()
  try {
    fireEvent.click(view.getByRole('menuitem', { name: 'Zoom to fit' }))
    assert.deepEqual(calls, ['select:a1', 'zoom'])
  } finally {
    cleanup()
  }
})

test('agent menu renders named menu items; ArrowDown moves from Show details to Zoom to fit', () => {
  let opened = 0
  const v = render(
    <GlassContextMenu position={{ x: 10, y: 10 }} items={contextMenuItems(true, { ...base, showAgentDetails: () => { opened++ } })} onClose={noop} />,
  )
  try {
    const details = v.getByRole('menuitem', { name: 'Show details' })
    assert.equal(document.activeElement, details, 'the first item takes focus on open')
    fireEvent.keyDown(details, { key: 'ArrowDown' })
    assert.equal(document.activeElement, v.getByRole('menuitem', { name: 'Zoom to fit' }))
    fireEvent.click(details)
    assert.equal(opened, 1)
    assert.ok(v.getByRole('menuitemcheckbox', { name: 'Toggle stats' }))
  } finally {
    cleanup()
  }
})
