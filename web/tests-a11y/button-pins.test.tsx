// #508: pins the repeated buttons (canvas controls, motion layers, guided tour card, control bar, permission
// requests) before they move to the shared Button, so the refactor changes neither their accessible names, roles,
// states, classes (focus ring, target size) nor their theme-token colours. The golden file is the fingerprint of
// every button as rendered before the refactor; regenerate it only on purpose: UPDATE_BUTTON_PINS=1.
import { test, afterEach, before } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { vscodeBridge } from '@/lib/vscode-bridge'
import { setLocaleChoice } from '@/lib/locale'
import { DEFAULT_CALM_LAYERS, toggleCalmLayer } from '@/lib/motion-layers'
import { GUIDED_STEPS } from '@/lib/guided-steps'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { MotionLayerControls } from '@/components/agent-visualizer/motion-layer-controls'
import { GuidedTourCard } from '@/components/agent-visualizer/guided-tour-card'
import { ControlBar } from '@/components/agent-visualizer/control-bar'
import { PermissionRequests } from '@/components/agent-visualizer/permission-requests'

const GOLDEN = new URL('./fixtures/button-pins.json', import.meta.url)
const noop = () => {}
const found: Record<string, unknown[]> = {}

before(() => { setLocaleChoice('en') })
afterEach(() => { cleanup(); document.body.replaceChildren() })

/** Everything a user (or a screen reader) can tell about a button, in a stable, order-independent form. */
function fingerprint(root: HTMLElement) {
  return [...root.querySelectorAll('button')].map(b => ({
    name: b.getAttribute('aria-label') ?? (b.textContent ?? '').trim(),
    type: b.getAttribute('type'),
    disabled: b.disabled,
    ariaPressed: b.getAttribute('aria-pressed'),
    ariaDisabled: b.getAttribute('aria-disabled'),
    ariaExpanded: b.getAttribute('aria-expanded'),
    classes: [...b.classList].sort(),
    style: b.getAttribute('style'),
  }))
}
function record(key: string, root: HTMLElement) {
  const prints = fingerprint(root)
  assert.ok(prints.length > 0, `${key} renders buttons`)
  found[key] = prints
  for (const p of prints) {
    assert.equal(p.type, 'button', `${key}: ${p.name} is type=button`)
    assert.ok(p.name.length > 0, `${key}: a button has an accessible name`)
    assert.ok(p.classes.some(c => c.startsWith('focus-visible:outline')), `${key}: ${p.name} has a visible focus ring`)
    assert.ok(p.classes.includes('min-h-6') && p.classes.includes('min-w-6'), `${key}: ${p.name} keeps the 24px minimum target`)
  }
}

test('motion layer toggles: free, pressed, locked', () => {
  const free = render(<MotionLayerControls locale="en" calm={DEFAULT_CALM_LAYERS} lock={null} onToggle={noop} />)
  record('motion/free', free.container)
  cleanup()
  const pressed = render(<MotionLayerControls locale="en" calm={toggleCalmLayer(DEFAULT_CALM_LAYERS, 'agents')} lock={null} onToggle={noop} />)
  record('motion/pressed', pressed.container)
  cleanup()
  const locked = render(<MotionLayerControls locale="fr" calm={DEFAULT_CALM_LAYERS} lock="system" onToggle={noop} />)
  record('motion/locked', locked.container)
})

test('guided tour card: first, middle and last step', () => {
  for (const [key, index] of [['tour/first', 0], ['tour/middle', 1], ['tour/last', GUIDED_STEPS.length - 1]] as const) {
    const view = render(<GuidedTourCard steps={GUIDED_STEPS} index={index} onNext={noop} onPrev={noop} onGoTo={noop} onExit={noop} />)
    record(key, view.container)
    cleanup()
  }
})

test('canvas controls: closed and with the View panel open', () => {
  const props: React.ComponentProps<typeof CanvasControls> = {
    teams: [] as unknown as React.ComponentProps<typeof CanvasControls>['teams'],
    zoomBy: noop, doZoomToFit: noop, animationsPaused: false, pausedBySystem: false, locale: 'en',
    calmLayers: DEFAULT_CALM_LAYERS, onToggleCalmLayer: noop, neverHide: true, toolExpiryS: 300,
    onToggleAnimationsPaused: noop, onToggleNeverHide: noop, onChangeToolExpiry: noop,
  }
  const view = render(<CanvasControls {...props} />)
  record('canvas/closed', view.container)
  fireEvent.click(view.getByRole('button', { name: 'View' }))
  record('canvas/view-open', view.container)
  cleanup()
  const frozen = render(<CanvasControls {...props} animationsPaused pausedBySystem />)
  fireEvent.click(frozen.getByRole('button', { name: 'View' }))
  record('canvas/view-frozen', frozen.container)
  cleanup()
  const names = render(<CanvasControls {...props} hiddenNames={{ shown: true, count: 8 }} onShowAgentList={noop} agentListKey="L" />)
  record('canvas/hidden-names', names.container)
})

test('control bar: live, review, armed clear', () => {
  const base = { isPlaying: false, speed: 2, currentTime: 3, totalDuration: 10, onPlayPause: noop, onRestart: noop, onSpeedChange: noop, onResumeLive: noop, onEnterReview: noop, timelineEvents: [] as never[] }
  const live = render(<ControlBar {...base} eventCount={0} />)
  record('bar/live-empty', live.container)
  cleanup()
  const withEvents = render(<ControlBar {...base} eventCount={5} isPlaying />)
  record('bar/live', withEvents.container)
  cleanup()
  const playing = render(<ControlBar {...base} isReviewing isPlaying eventCount={5} />)
  record('bar/review-playing', playing.container)
  cleanup()
  const review = render(<ControlBar {...base} isReviewing eventCount={5} />)
  record('bar/review', review.container)
  fireEvent.click(review.getByRole('button', { name: /Clear/ }))
  record('bar/clear-armed', review.container)
})

test('permission requests: pending, sending, sent', async () => {
  vscodeBridge!.configureWebviewApi(noop)
  const post = (data: unknown) => act(() => { vscodeBridge!.dispatch(data) })
  const NONCE = '0123456789abcdef0123456789abcdef'
  const view = render(<PermissionRequests sessionLabel={() => 'fix login'} />)
  await post({ type: 'permission-request', request: {
    sessionId: 'sess-1', toolUseId: 'toolu_01', nonce: NONCE, toolName: 'Bash', inputPreview: '{"command":"npm test"}',
    inputTruncated: false, inputSha256: 'a'.repeat(64), requestedAt: 0, expiresAt: Date.now() + 600_000,
  } })
  record('permission/pending', view.container)
  fireEvent.click(view.getByRole('button', { name: /^Approve/ }))
  record('permission/sending', view.container)
  await post({ type: 'permission-closed', nonce: NONCE, sessionId: 'sess-1', toolUseId: 'toolu_01', outcome: 'sent' })
  await post({ type: 'permission-result', nonce: NONCE, ok: true })
  record('permission/sent', view.container)
})

test('every button still renders as it did before the shared Button', () => {
  if (process.env.UPDATE_BUTTON_PINS) {
    fs.writeFileSync(GOLDEN, JSON.stringify(found, null, 2) + '\n')
    return
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))
  assert.deepEqual(Object.keys(found).sort(), Object.keys(golden).sort())
  for (const key of Object.keys(golden)) assert.deepEqual(found[key], golden[key], key)
})
