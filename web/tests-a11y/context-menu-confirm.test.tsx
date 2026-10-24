// Sensitive context-menu items (#374): an item with `confirmLabel` needs a second activation, like the
// "Clear history" button of the control bar. The first one arms it (label changes, menu stays open, announced),
// the second runs it; Escape closes the menu without running anything.
import { test, afterEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { GlassContextMenu } from '@/components/agent-visualizer/glass-context-menu'

afterEach(() => { cleanup(); document.body.replaceChildren(); mock.timers.reset() })

const setup = () => {
  const log: string[] = []
  const v = render(
    <GlassContextMenu
      position={{ x: 10, y: 10 }}
      onClose={() => log.push('close')}
      items={[
        { label: 'Zoom', onClick: () => log.push('zoom') },
        { label: '⟲  Clear history', confirmLabel: 'Confirm clear history', onClick: () => log.push('clear') },
      ]}
    />,
  )
  return { v, log }
}

test('a plain item runs and closes at once', () => {
  const { v, log } = setup()
  fireEvent.click(v.getByRole('menuitem', { name: 'Zoom' }))
  assert.deepEqual(log, ['zoom', 'close'])
})

test('a confirm item: first activation arms it, nothing runs, the menu stays open and the focus stays put', async () => {
  const { v, log } = setup()
  // The menu ignores a second activation for 400 ms of Date.now(): a controlled clock, since on a loaded machine the real time
  // between the two clicks can exceed 400 ms and the guard would expire before the "double click" (#440)
  mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 })
  const item = v.getByRole('menuitem', { name: /Clear history/ })
  act(() => { item.focus() })
  await act(async () => { fireEvent.click(item) })
  assert.deepEqual(log, [], 'no action, no close')
  const armed = v.getByRole('menuitem', { name: 'Confirm clear history' })
  assert.equal(document.activeElement, armed)
  assert.match(v.getByRole('status').textContent ?? '', /Confirm clear history/)
  await act(async () => { fireEvent.click(armed) })
  assert.deepEqual(log, [], 'a second click right after arming (double click) is ignored')
  mock.timers.tick(450)
  await act(async () => { fireEvent.click(armed) })
  assert.deepEqual(log, ['clear', 'close'])
})

test('moving to another item disarms the confirmation', async () => {
  const { v, log } = setup()
  const item = v.getByRole('menuitem', { name: /Clear history/ })
  act(() => { item.focus() })
  await act(async () => { fireEvent.click(item) })
  act(() => { v.getByRole('menuitem', { name: 'Zoom' }).focus() })
  assert.ok(v.getByRole('menuitem', { name: /Clear history/ }), 'back to the plain label')
  assert.deepEqual(log, [])
})
