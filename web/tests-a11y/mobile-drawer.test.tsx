// #476 (mobile view, #241 PR 4): below 768 px an open panel is a modal drawer. Focus moves into it, Tab stays
// in it, Escape closes it and the focus goes back to what opened it. 768 px and wider nothing changes.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import axe from 'axe-core'
import { SlidingPanel, CloseButton } from '@/components/agent-visualizer/shared-ui'
import { MOBILE_QUERY, nextTrapTarget } from '@/lib/mobile-view'
import { shouldHandleShortcut } from '@/hooks/use-keyboard-shortcuts'
import { setMobileView } from './mobile-media'

afterEach(() => {
  setMobileView(false)
  cleanup()
  document.body.replaceChildren()
})

const frames = () => act(async () => { await new Promise(r => setTimeout(r, 80)) })

function Drawer({ visible, onClose = () => {}, label }: { visible: boolean; onClose?: () => void; label?: string }) {
  return (
    <SlidingPanel visible={visible} position={{ top: 0, right: 0 }} zIndex={1} labelledBy={label ? undefined : 'drawer-title'} label={label}>
      <h2 id="drawer-title">Files</h2>
      <CloseButton onClick={onClose} />
      <button type="button">Middle</button>
      <button type="button">Last</button>
    </SlidingPanel>
  )
}

test('the breakpoint is 768 px: the query matches 767 px wide and not 768', () => {
  assert.equal(MOBILE_QUERY, '(max-width: 767.98px)')
})

test('768 px and wider: an open panel stays a plain region (no dialog, no trap)', () => {
  const view = render(<Drawer visible />)
  assert.equal(view.queryByRole('dialog'), null)
  const last = view.getByRole('button', { name: 'Last' })
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement, last, 'Tab is left to the browser')
})

test('under 768 px: an open panel is a dialog named by its heading', async () => {
  setMobileView(true)
  const view = render(<Drawer visible />)
  const dialog = view.getByRole('dialog')
  // Not modal: the permission cards and the truncation notice stay drawn above it and reachable (#410, #453)
  assert.equal(dialog.getAttribute('aria-modal'), null)
  assert.equal(dialog.getAttribute('aria-labelledby'), 'drawer-title')
  assert.ok(dialog.hasAttribute('data-mobile-drawer'))
  const results = await axe.run(view.container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })
  assert.deepEqual(results.violations.map(v => v.id), [])
})

test('under 768 px: a panel without a heading id is named by its label', () => {
  setMobileView(true)
  const view = render(<Drawer visible label="Files" />)
  assert.equal(view.getByRole('dialog', { name: 'Files' }).getAttribute('aria-labelledby'), null)
})

test('under 768 px: a closed panel is not a dialog', () => {
  setMobileView(true)
  const view = render(<Drawer visible={false} />)
  assert.equal(view.queryByRole('dialog'), null)
})

test('under 768 px: Tab from the last control wraps to the first, Shift+Tab from the first to the last', () => {
  setMobileView(true)
  const view = render(<Drawer visible />)
  const close = view.getByRole('button', { name: 'Close' })
  const last = view.getByRole('button', { name: 'Last' })
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement, close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement, last)
})

test('under 768 px: a roving-tabindex row (tabindex -1) after the last Tab stop does not open a gap in the trap', () => {
  setMobileView(true)
  const view = render(
    <SlidingPanel visible position={{ top: 0 }} zIndex={1} label="Sessions">
      <CloseButton onClick={() => {}} />
      <button type="button">Row 1</button>
      <button type="button" tabIndex={-1}>Row 2</button>
    </SlidingPanel>,
  )
  const row1 = view.getByRole('button', { name: 'Row 1' })
  row1.focus()
  fireEvent.keyDown(row1, { key: 'Tab' })
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Close' }))
})

test('under 768 px: Tab in the middle is left to the browser', () => {
  setMobileView(true)
  const view = render(<Drawer visible />)
  const middle = view.getByRole('button', { name: 'Middle' })
  middle.focus()
  const ev = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  middle.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, false)
  assert.equal(document.activeElement, middle)
})

test('under 768 px: Escape closes the drawer once; the global shortcuts leave it alone (it is a dialog)', () => {
  setMobileView(true)
  let closed = 0
  const view = render(<Drawer visible onClose={() => { closed++ }} />)
  const middle = view.getByRole('button', { name: 'Middle' })
  fireEvent.keyDown(middle, { key: 'Escape' })
  assert.equal(closed, 1)
  // The global handler (close the newest panel, then clear the selection) skips keys from inside a dialog
  assert.equal(shouldHandleShortcut({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, target: middle }, true), false)
})

test('under 768 px: an Escape a control inside already handled does not also close the drawer', () => {
  setMobileView(true)
  let closed = 0
  const view = render(
    <SlidingPanel visible position={{ top: 0 }} zIndex={1} label="Menu">
      <CloseButton onClick={() => { closed++ }} />
      <button type="button" onKeyDown={e => { if (e.key === 'Escape') e.stopPropagation() }}>Menu item</button>
    </SlidingPanel>,
  )
  fireEvent.keyDown(view.getByRole('button', { name: 'Menu item' }), { key: 'Escape' })
  assert.equal(closed, 0)
})

test('under 768 px: Escape in a text field is left to the field', () => {
  setMobileView(true)
  let closed = 0
  const view = render(
    <SlidingPanel visible position={{ top: 0 }} zIndex={1} label="Search">
      <CloseButton onClick={() => { closed++ }} />
      <input aria-label="Filter" />
    </SlidingPanel>,
  )
  fireEvent.keyDown(view.getByRole('textbox', { name: 'Filter' }), { key: 'Escape' })
  assert.equal(closed, 0)
})

test('under 768 px: opening moves the focus into the drawer, closing gives it back to the trigger', async () => {
  setMobileView(true)
  const trigger = document.createElement('button')
  trigger.textContent = 'Files'
  document.body.appendChild(trigger)
  trigger.focus()
  const view = render(<Drawer visible={false} />)
  view.rerender(<Drawer visible />)
  await frames()
  assert.equal(document.activeElement, view.getByRole('button', { name: 'Close' }))
  view.rerender(<Drawer visible={false} />)
  assert.equal(document.activeElement, trigger)
})

test('under 768 px: the drawer keeps its reduced-motion opt-out', () => {
  setMobileView(true)
  const view = render(<Drawer visible />)
  assert.match(view.getByRole('dialog').className, /motion-reduce:transition-none/)
})

test('nextTrapTarget: wraps only at the ends of a segment, never with nothing to focus', () => {
  const items = ['a', 'b', 'c']
  assert.equal(nextTrapTarget([items], 'c', false), 'a')
  assert.equal(nextTrapTarget([items], 'a', true), 'c')
  assert.equal(nextTrapTarget([items], 'b', false), null)
  assert.equal(nextTrapTarget([items], 'b', true), null)
  // Focus on the container itself (or outside): Tab goes to the first, Shift+Tab to the last
  assert.equal(nextTrapTarget([items], null, false), 'a')
  assert.equal(nextTrapTarget([items], null, true), 'c')
  assert.equal(nextTrapTarget([[]], null, false), null)
  // Two surfaces (permission cards, then the drawer): their ends join, empty ones are skipped
  assert.equal(nextTrapTarget([['p'], [], items], 'p', false), 'a')
  assert.equal(nextTrapTarget([['p'], [], items], 'a', true), 'p')
  assert.equal(nextTrapTarget([['p'], items], 'c', false), 'p')
  assert.equal(nextTrapTarget([['p'], items], 'p', true), 'c')
})

test('under 768 px: Tab cycles through the drawer and the permission cards and truncation notice drawn above it', () => {
  setMobileView(true)
  const view = render(
    <>
      <div data-permission-requests=""><button type="button">Allow</button></div>
      <div data-truncation-banner=""><button type="button">Details</button></div>
      <button type="button">Top bar button</button>
      <Drawer visible />
    </>,
  )
  const allow = view.getByRole('button', { name: 'Allow' })
  const details = view.getByRole('button', { name: 'Details' })
  const close = view.getByRole('button', { name: 'Close' })
  const last = view.getByRole('button', { name: 'Last' })
  last.focus()
  fireEvent.keyDown(last, { key: 'Tab' })
  assert.equal(document.activeElement?.textContent, allow.textContent, 'from the last control of the drawer to the permission cards')
  fireEvent.keyDown(allow, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement?.textContent, last.textContent, 'and back')
  details.focus()
  fireEvent.keyDown(details, { key: 'Tab' })
  assert.equal(document.activeElement?.textContent, close.textContent, 'from the notice into the drawer, skipping the top bar')
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  assert.equal(document.activeElement?.textContent, details.textContent)
})
