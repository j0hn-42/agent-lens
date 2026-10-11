// Command palette (#243): the dialog is driven with real key events, so removing a handler makes a test fail.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { CommandPalette } from '@/components/agent-visualizer/command-palette'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import { buildPaletteItems, type PaletteSource } from '@/lib/command-palette'
import type { SessionInfo } from '@/lib/bridge-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const calls: string[] = []
beforeEach(() => { calls.length = 0 })
const rec = (name: string) => () => { calls.push(name) }

const sessions: SessionInfo[] = [
  { id: 's1', label: 'payments-api', status: 'active', startTime: 0, lastActivityTime: 1, runtime: 'claude', branch: 'feat/refund' },
  { id: 's2', label: 'web-app', status: 'completed', startTime: 0, lastActivityTime: 1 },
]

function items() {
  const src: PaletteSource = {
    singleKeyEnabled: true, selectedSessionId: 's1', sessions,
    agents: [{ id: 's1:main', name: 'main-agent', sessionId: 's1', sessionLabel: 'payments-api', isMain: true }],
    actions: {
      togglePlayPause: rec('play'), zoomToFit: rec('fit'), toggleFullscreen: rec('fullscreen'), toggleHexGrid: rec('grid'),
      toggleMute: rec('mute'), openShortcuts: rec('shortcuts'), openSettings: rec('settings'),
    },
    togglePanel: p => { calls.push(`panel:${p}`) },
    selectSession: id => { calls.push(`session:${id}`) },
    selectAgent: id => { calls.push(`agent:${id}`) },
  }
  return buildPaletteItems(src)
}

function Host({ startOpen = true }: { startOpen?: boolean }) {
  const [open, setOpen] = React.useState(startOpen)
  return (
    <>
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>Trigger</button>
      <CommandPalette open={open} onClose={() => setOpen(false)} items={items()} />
    </>
  )
}

const input = (r: ReturnType<typeof render>) => r.getByRole('combobox')
const activeOption = (r: ReturnType<typeof render>) => {
  const id = input(r).getAttribute('aria-activedescendant')
  assert.ok(id, 'aria-activedescendant is set')
  return document.getElementById(id)!
}

test('closed: renders nothing', () => {
  const r = render(<Host startOpen={false} />)
  assert.equal(r.queryByRole('dialog'), null)
})

test('open: a named modal dialog whose search field has focus and a name', () => {
  const r = render(<Host />)
  const dialog = r.getByRole('dialog', { name: 'Command palette' })
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  const field = input(r)
  assert.equal(document.activeElement, field)
  assert.ok(field.getAttribute('aria-label') || document.querySelector(`label[for="${field.id}"]`), 'search field is named')
  assert.equal(field.getAttribute('aria-expanded'), 'true')
  assert.equal(field.getAttribute('aria-controls'), r.getByRole('listbox').id)
})

test('options are grouped, each option has a name, one is active', () => {
  const r = render(<Host />)
  const groups = r.getAllByRole('group').map(g => g.getAttribute('aria-label') ?? g.getAttribute('aria-labelledby'))
  assert.ok(groups.length >= 4)
  for (const name of ['Actions', 'Panels', 'Sessions', 'Agents']) r.getByRole('group', { name })
  const options = r.getAllByRole('option')
  assert.ok(options.length > 10)
  assert.equal(options.filter(o => o.getAttribute('aria-selected') === 'true').length, 1)
  assert.equal(activeOption(r), options[0])
})

test('typing filters, announces the count, and an empty result says so', async () => {
  const r = render(<Host />)
  await act(async () => { fireEvent.change(input(r), { target: { value: 'payments' } }) })
  const names = r.getAllByRole('option').map(o => o.textContent ?? '')
  assert.ok(names.length >= 2)
  assert.ok(names.every(n => /payments/i.test(n)))
  assert.match(r.getByRole('status').textContent ?? '', /^\d+ results?$/)
  await act(async () => { fireEvent.change(input(r), { target: { value: 'zzzz' } }) })
  assert.equal(r.queryAllByRole('option').length, 0)
  assert.equal(r.getByRole('status').textContent, 'No matching commands')
  assert.equal(input(r).getAttribute('aria-activedescendant'), null)
})

test('ArrowDown and ArrowUp move the active option and wrap; focus stays in the field', async () => {
  const r = render(<Host />)
  const options = r.getAllByRole('option')
  await act(async () => { fireEvent.keyDown(input(r), { key: 'ArrowDown' }) })
  assert.equal(activeOption(r), options[1])
  await act(async () => { fireEvent.keyDown(input(r), { key: 'ArrowUp' }) })
  await act(async () => { fireEvent.keyDown(input(r), { key: 'ArrowUp' }) })
  assert.equal(activeOption(r), options[options.length - 1], 'wraps to the last option')
  assert.equal(document.activeElement, input(r))
})

test('Enter runs the active option and closes the palette', async () => {
  const r = render(<Host />)
  await act(async () => { fireEvent.change(input(r), { target: { value: 'files panel' } }) })
  await act(async () => { fireEvent.keyDown(input(r), { key: 'Enter' }) })
  assert.deepEqual(calls, ['panel:files'])
  assert.equal(r.queryByRole('dialog'), null)
})

test('Enter on a session option jumps to that session', async () => {
  const r = render(<Host />)
  await act(async () => { fireEvent.change(input(r), { target: { value: 'web-app' } }) })
  await act(async () => { fireEvent.keyDown(input(r), { key: 'Enter' }) })
  assert.deepEqual(calls, ['session:s2'])
})

test('clicking an option runs it', async () => {
  const r = render(<Host />)
  await act(async () => { fireEvent.click(r.getByRole('option', { name: /main-agent/ })) })
  assert.deepEqual(calls, ['agent:s1:main'])
  assert.equal(r.queryByRole('dialog'), null)
})

test('Enter with no result does nothing and keeps the palette open', async () => {
  const r = render(<Host />)
  await act(async () => { fireEvent.change(input(r), { target: { value: 'zzzz' } }) })
  await act(async () => { fireEvent.keyDown(input(r), { key: 'Enter' }) })
  assert.deepEqual(calls, [])
  r.getByRole('dialog')
})

test('Escape closes it and returns focus to the element that opened it', async () => {
  const r = render(<Host startOpen={false} />)
  const trigger = r.getByTestId('trigger')
  trigger.focus()
  await act(async () => { fireEvent.click(trigger) })
  await act(async () => { fireEvent.keyDown(input(r), { key: 'Escape' }) })
  assert.equal(r.queryByRole('dialog'), null)
  assert.equal(document.activeElement, trigger)
})

test('Escape is consumed: it does not reach the global handler that closes panels', async () => {
  const seen: string[] = []
  const listener = (e: KeyboardEvent) => { seen.push(e.key) }
  window.addEventListener('keydown', listener)
  try {
    const r = render(<Host />)
    await act(async () => { fireEvent.keyDown(input(r), { key: 'Escape' }) })
  } finally {
    window.removeEventListener('keydown', listener)
  }
  assert.deepEqual(seen, [])
})

test('running a command that does not move focus restores the previous focus', async () => {
  const r = render(<Host startOpen={false} />)
  const trigger = r.getByTestId('trigger')
  trigger.focus()
  await act(async () => { fireEvent.click(trigger) })
  await act(async () => { fireEvent.change(input(r), { target: { value: 'play' } }) })
  await act(async () => { fireEvent.keyDown(input(r), { key: 'Enter' }) })
  assert.deepEqual(calls, ['play'])
  assert.equal(document.activeElement, trigger)
})

test('running a command that moves focus itself leaves it alone', async () => {
  const r = render(<Host startOpen={false} />)
  const trigger = r.getByTestId('trigger')
  trigger.focus()
  await act(async () => { fireEvent.click(trigger) })
  await act(async () => { fireEvent.change(input(r), { target: { value: 'files panel' } }) })
  await act(async () => { fireEvent.keyDown(input(r), { key: 'Enter' }) })
  assert.notEqual(document.activeElement, trigger)
})

test('Tab does not leave the dialog', async () => {
  const r = render(<Host />)
  const prevented = !fireEvent.keyDown(input(r), { key: 'Tab' })
  assert.equal(prevented, true)
  assert.equal(document.activeElement, input(r))
})

test('Ctrl+K inside the palette closes it', async () => {
  const r = render(<Host />)
  await act(async () => { fireEvent.keyDown(input(r), { key: 'k', ctrlKey: true }) })
  assert.equal(r.queryByRole('dialog'), null)
})

test('the shortcut of an option is shown to sighted users and announced', () => {
  const r = render(<Host />)
  const files = r.getByRole('option', { name: /Toggle Files panel/ })
  assert.match(files.textContent ?? '', /F$/)
  assert.match(files.getAttribute('aria-keyshortcuts') ?? '', /F/)
})

test('detail text comes from the session list only: no live state is claimed', () => {
  const r = render(<Host />)
  const finished = r.getByRole('option', { name: /web-app/ })
  assert.match(finished.textContent ?? '', /finished/)
  const current = r.getByRole('option', { name: /payments-api/ })
  assert.match(current.textContent ?? '', /feat\/refund/)
  assert.doesNotMatch(current.textContent ?? '', /running|working|active|live/i)
})

// Global shortcut: real hook, real window listener

function ShortcutHost({ singleKey }: { singleKey: boolean }) {
  const noop = () => {}
  useKeyboardShortcuts({
    togglePlayPause: noop, toggleFilePanel: noop, toggleSessionList: noop, toggleConversation: noop,
    toggleTimeline: noop, toggleHexGrid: noop, toggleStats: noop, toggleContext: noop,
    toggleCostOverlay: noop, zoomToFit: noop, toggleFullscreen: noop, closeTopPanel: () => false,
    clearSelection: noop, toggleMute: noop, setSpeed: noop, openShortcuts: noop, undoLast: () => false,
    openPalette: rec('palette'), singleKeyEnabled: singleKey,
  })
  return <input aria-label="Some field" />
}

test('Ctrl+K and Cmd+K call openPalette and stop the browser default, whatever the single-key preference', () => {
  render(<ShortcutHost singleKey={false} />)
  const ctrl = new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(ctrl)
  const meta = new window.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
  document.body.dispatchEvent(meta)
  assert.deepEqual(calls, ['palette', 'palette'])
  assert.equal(ctrl.defaultPrevented, true)
  assert.equal(meta.defaultPrevented, true)
})

test('plain K and Ctrl+Shift+K do not open the palette', () => {
  render(<ShortcutHost singleKey />)
  fireEvent.keyDown(document.body, { key: 'k' })
  fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true, shiftKey: true })
  assert.deepEqual(calls, [])
})

test('Ctrl+K works while typing in a text field', () => {
  const r = render(<ShortcutHost singleKey />)
  fireEvent.keyDown(r.getByRole('textbox', { name: 'Some field' }), { key: 'k', ctrlKey: true })
  assert.deepEqual(calls, ['palette'])
})
