// Keyboard wiring tests (issue #43): render the real components and dispatch real key
// events, so removing a handler from the JSX makes a test fail (the pure-function tests in
// keyboard.test.tsx cannot notice that).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { ControlBar } from '@/components/agent-visualizer/control-bar'
import { GlassContextMenu } from '@/components/agent-visualizer/glass-context-menu'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}

function reviewBar(over: Partial<React.ComponentProps<typeof ControlBar>> = {}) {
  return render(
    <ControlBar
      isPlaying={false} speed={1} currentTime={5} totalDuration={10} isReviewing
      onPlayPause={noop} onRestart={noop} onSpeedChange={noop} onResumeLive={noop}
      timelineEvents={[]}
      {...over}
    />,
  )
}

test('review scrubber: arrow, Home and End keys call onSeek through the real handler', () => {
  const seeks: number[] = []
  const { getByRole } = reviewBar({ onSeek: t => seeks.push(t) })
  const slider = getByRole('slider', { name: 'Timeline position' })
  assert.equal(slider.tabIndex, 0, 'scrubber is focusable')
  fireEvent.keyDown(slider, { key: 'ArrowRight' })
  fireEvent.keyDown(slider, { key: 'ArrowLeft' })
  fireEvent.keyDown(slider, { key: 'Home' })
  fireEvent.keyDown(slider, { key: 'End' })
  fireEvent.keyDown(slider, { key: 'a' })
  assert.equal(seeks.length, 4, 'unrelated keys do not seek')
  assert.ok(seeks[0] > 5 && seeks[1] < 5)
  assert.equal(seeks[2], 0)
  assert.equal(seeks[3], 10)
})

test('review play button: click activates it, and the label follows the state', () => {
  let plays = 0
  const { getByRole, rerender } = reviewBar({ onPlayPause: () => { plays++ } })
  fireEvent.click(getByRole('button', { name: 'Play' }))
  assert.equal(plays, 1)
  rerender(
    <ControlBar
      isPlaying speed={1} currentTime={5} totalDuration={10} isReviewing
      onPlayPause={noop} onRestart={noop} onSpeedChange={noop} timelineEvents={[]}
    />,
  )
  getByRole('button', { name: 'Pause' })
})

test('clear history: Escape closes the confirmation and focus returns to the Clear button', async () => {
  const { getByRole, queryByRole } = reviewBar()
  await act(async () => { fireEvent.click(getByRole('button', { name: 'Clear history' })) })
  const group = getByRole('group', { name: 'Confirm clearing history' })
  await act(async () => { fireEvent.keyDown(group, { key: 'Escape' }) })
  assert.equal(queryByRole('group', { name: 'Confirm clearing history' }), null)
  assert.equal(document.activeElement, getByRole('button', { name: 'Clear history' }))
})

test('live/review swap: focus held in the bar moves to the primary control of the new bar (#258)', async () => {
  const props = {
    isPlaying: false, speed: 1, currentTime: 5, totalDuration: 10,
    onPlayPause: noop, onRestart: noop, onSpeedChange: noop, onResumeLive: noop, timelineEvents: [],
  }
  const r = render(<ControlBar {...props} isReviewing />)
  const live = r.container.querySelector<HTMLElement>('[data-primary-control]')
  assert.ok(live, 'the review bar has a primary control')
  await act(async () => { live!.focus() })
  await act(async () => { r.rerender(<ControlBar {...props} isReviewing={false} />) })
  const next = r.container.querySelector<HTMLElement>('[data-primary-control]')
  assert.ok(next, 'the live bar has a primary control')
  assert.equal(document.activeElement, next, 'focus is carried over instead of dropping to <body>')
})

test('clear history: Escape pressed on the focused Confirm button cancels without reaching the global shortcuts (#258)', async () => {
  const { getByRole, queryByRole } = reviewBar()
  await act(async () => { fireEvent.click(getByRole('button', { name: 'Clear history' })) })
  const seen: string[] = []
  const spy = (e: KeyboardEvent) => { seen.push(e.key) }
  window.addEventListener('keydown', spy)
  try {
    await act(async () => { fireEvent.keyDown(getByRole('button', { name: 'Confirm clear' }), { key: 'Escape' }) })
  } finally {
    window.removeEventListener('keydown', spy)
  }
  assert.equal(queryByRole('group', { name: 'Confirm clearing history' }), null)
  assert.equal(document.activeElement, getByRole('button', { name: 'Clear history' }))
  assert.deepEqual(seen, [], 'one Escape closes one layer')
})

// ─── Global shortcuts: real hook, real window listener ──────────────────────

function Harness(props: { calls: string[]; closeResult: boolean; singleKey?: boolean }) {
  const rec = (name: string) => () => { props.calls.push(name) }
  useKeyboardShortcuts({
    togglePlayPause: rec('play'), toggleFilePanel: rec('files'), toggleSessionList: rec('sessions'), toggleConversation: rec('conversation'),
    toggleTimeline: rec('timeline'), toggleHexGrid: rec('hex'), toggleStats: rec('stats'), toggleContext: rec('context'), toggleSystem: rec('system'),
    toggleCostOverlay: rec('cost'), zoomToFit: rec('fit'), toggleFullscreen: rec('fullscreen'), togglePresentation: rec('presentation'),
    closeTopPanel: () => { props.calls.push('closeTop'); return props.closeResult },
    clearSelection: rec('clearSelection'), toggleMute: rec('mute'), setSpeed: () => { props.calls.push('speed') },
    openShortcuts: rec('shortcuts'), undoLast: () => { props.calls.push('undo'); return false },
    singleKeyEnabled: props.singleKey ?? true,
  })
  return <button type="button" onClick={() => props.calls.push('button-click')}>Action</button>
}

test('Space on a focused button does not trigger play/pause; on the page it does', () => {
  const calls: string[] = []
  const { getByRole } = render(<Harness calls={calls} closeResult />)
  fireEvent.keyDown(getByRole('button', { name: 'Action' }), { key: ' ' })
  assert.deepEqual(calls, [], 'button keeps Space for itself')
  fireEvent.keyDown(document.body, { key: ' ' })
  assert.deepEqual(calls, ['play'])
})

test('Escape closes the top panel first and only clears the selection when none is open', () => {
  const calls: string[] = []
  const { rerender } = render(<Harness calls={calls} closeResult />)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  assert.deepEqual(calls, ['closeTop'])
  calls.length = 0
  rerender(<Harness calls={calls} closeResult={false} />)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  assert.deepEqual(calls, ['closeTop', 'clearSelection'])
})

test('Escape from a focused button still closes panels (works after Tab navigation)', () => {
  const calls: string[] = []
  const { getByRole } = render(<Harness calls={calls} closeResult />)
  fireEvent.keyDown(getByRole('button', { name: 'Action' }), { key: 'Escape' })
  assert.deepEqual(calls, ['closeTop'])
})

test('single-key shortcuts, including ?, are inert when disabled, but Escape keeps working (#376)', () => {
  const calls: string[] = []
  render(<Harness calls={calls} closeResult singleKey={false} />)
  fireEvent.keyDown(document.body, { key: 't' })
  fireEvent.keyDown(document.body, { key: 'Escape' })
  fireEvent.keyDown(document.body, { key: '?' })
  assert.deepEqual(calls, ['closeTop'])
})

test('letters work with a button focused (focus returned by Escape), Space still belongs to the button (#376)', () => {
  const calls: string[] = []
  const { getByRole } = render(<Harness calls={calls} closeResult />)
  const button = getByRole('button', { name: 'Action' })
  button.focus()
  fireEvent.keyDown(button, { key: 'y' })
  fireEvent.keyDown(button, { key: 'p' })
  fireEvent.keyDown(button, { key: 'l' })
  fireEvent.keyDown(button, { key: ' ' })
  assert.deepEqual(calls, ['system', 'context', 'sessions'])
})

test('Shift decides between Files and Zoom to fit, not the case of the letter (Caps Lock) (#376)', () => {
  const calls: string[] = []
  render(<Harness calls={calls} closeResult />)
  fireEvent.keyDown(document.body, { key: 'f' })
  fireEvent.keyDown(document.body, { key: 'F', shiftKey: true })
  fireEvent.keyDown(document.body, { key: 'F' })
  fireEvent.keyDown(document.body, { key: 'f', shiftKey: true })
  assert.deepEqual(calls, ['files', 'fit', 'files', 'fit'])
})

test('P toggles the Context panel and S the Stats panel (#124)', () => {
  const calls: string[] = []
  render(<Harness calls={calls} closeResult />)
  fireEvent.keyDown(document.body, { key: 'p' })
  fireEvent.keyDown(document.body, { key: 'S' })
  assert.deepEqual(calls, ['context', 'stats'])
})

test('Y toggles the System panel', () => {
  const calls: string[] = []
  render(<Harness calls={calls} closeResult />)
  fireEvent.keyDown(document.body, { key: 'y' })
  fireEvent.keyDown(document.body, { key: 'Y' })
  assert.deepEqual(calls, ['system', 'system'])
})

test('V toggles presentation mode, and is inert when single-key shortcuts are off (#245)', () => {
  const calls: string[] = []
  const { rerender } = render(<Harness calls={calls} closeResult />)
  fireEvent.keyDown(document.body, { key: 'v' })
  fireEvent.keyDown(document.body, { key: 'V' })
  assert.deepEqual(calls, ['presentation', 'presentation'])
  calls.length = 0
  rerender(<Harness calls={calls} closeResult singleKey={false} />)
  fireEvent.keyDown(document.body, { key: 'v' })
  assert.deepEqual(calls, [])
})

// ─── Context menu ───────────────────────────────────────────────────────────

test('context menu: first item gets focus, arrows move it, Enter activates, Escape closes', () => {
  const log: string[] = []
  const { getAllByRole } = render(
    <GlassContextMenu
      position={{ x: 10, y: 10 }} onClose={() => log.push('close')}
      items={[
        { label: 'Pin', onClick: () => log.push('pin') },
        { label: 'Remove', onClick: () => log.push('remove'), danger: true },
      ]}
    />,
  )
  const items = getAllByRole('menuitem')
  assert.equal(document.activeElement, items[0], 'focus moves into the menu on open')
  fireEvent.keyDown(items[0], { key: 'ArrowDown' })
  assert.equal(document.activeElement, items[1])
  fireEvent.keyDown(items[1], { key: 'ArrowDown' })
  assert.equal(document.activeElement, items[0], 'arrows wrap')
  fireEvent.click(items[1])
  assert.ok(log.includes('remove'))
  fireEvent.keyDown(items[0], { key: 'Escape' })
  assert.ok(log.includes('close'))
})
