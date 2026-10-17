// #476 (mobile view): below 768 px the controls around the canvas are at least 44x44 px, and pinch / drag on the
// canvas have button equivalents (WCAG 2.5.1). jsdom has no layout: the 44 px classes are checked here, the drawn
// sizes in tests-a11y/e2e/mobile-view.e2e.ts (375x667).
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { CanvasControls } from '@/components/agent-visualizer/canvas-controls'
import { ControlBar } from '@/components/agent-visualizer/control-bar'
import { CloseButton } from '@/components/agent-visualizer/shared-ui'
import { DEFAULT_CALM_LAYERS } from '@/lib/motion-layers'
import { CAMERA } from '@/lib/canvas-constants'
import { TOUCH_TARGET } from '@/lib/mobile-view'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const noop = () => {}

function assertTargets(root: ParentNode, selector: string, where: string) {
  const controls = Array.from(root.querySelectorAll(selector))
  assert.ok(controls.length > 0, `${where}: controls found`)
  for (const el of controls) {
    for (const cls of TOUCH_TARGET.split(' ')) {
      assert.ok(el.classList.contains(cls), `${where}: "${el.getAttribute('aria-label') || el.textContent?.trim()}" lacks ${cls}`)
    }
  }
}

function canvasControls(calls: string[]) {
  return render(
    <CanvasControls
      teams={[] as unknown as React.ComponentProps<typeof CanvasControls>['teams']}
      zoomBy={f => calls.push(`zoom:${f}`)} doZoomToFit={() => calls.push('fit')}
      animationsPaused={false} pausedBySystem={false} locale="en" calmLayers={DEFAULT_CALM_LAYERS} onToggleCalmLayer={noop}
      neverHide={false} toolExpiryS={300} onToggleAnimationsPaused={noop} onToggleNeverHide={noop} onChangeToolExpiry={noop}
    />,
  )
}

test('pinch and drag have button equivalents: zoom in, zoom out and fit (recentre), each 44 px under 768 px', () => {
  const calls: string[] = []
  const view = canvasControls(calls)
  const zoom = view.getByRole('group', { name: 'Zoom' })
  for (const name of ['Zoom in', 'Zoom out', 'Fit to view']) fireEvent.click(view.getByRole('button', { name }))
  assert.deepEqual(calls, [`zoom:${CAMERA.keyboardZoomStep}`, `zoom:${1 / CAMERA.keyboardZoomStep}`, 'fit'])
  assertTargets(zoom, 'button', 'zoom block')
})

test('the View button, its settings and the legend toggle are 44 px under 768 px', () => {
  const view = canvasControls([])
  fireEvent.click(view.getByRole('button', { name: 'View' }))
  assertTargets(view.container, 'button, label', 'canvas controls')
})

test('the playback bar (live and review): every button and the position slider are 44 px under 768 px', () => {
  const props = {
    isPlaying: false, speed: 1, currentTime: 3, totalDuration: 10, onPlayPause: noop, onRestart: noop,
    onSpeedChange: noop, onResumeLive: noop, onEnterReview: noop, timelineEvents: [],
  }
  const live = render(<ControlBar {...props} />)
  assertTargets(live.container, 'button, [role="slider"]', 'live bar')
  cleanup()
  const review = render(<ControlBar {...props} isReviewing />)
  assertTargets(review.container, 'button, [role="slider"]', 'review bar')
  fireEvent.click(review.getByRole('button', { name: 'Clear history' }))
  assertTargets(review.container, 'button', 'clear confirmation')
})

test('the Close button of a panel (drawer) is 44 px under 768 px', () => {
  const view = render(<CloseButton onClick={noop} />)
  assertTargets(view.container, 'button', 'close button')
})
