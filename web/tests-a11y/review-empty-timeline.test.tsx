// Review sur une timeline vide (#383): rien à parcourir, le bouton le dit au lieu d'ouvrir un mode vide.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, renderHook, act } from '@testing-library/react'
import { useReviewControls } from '@/hooks/use-review-controls'
import axe from 'axe-core'

import { ControlBar } from '@/components/agent-visualizer/control-bar'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const noop = () => {}

function bar(eventCount: number, onEnterReview: () => void) {
  return render(
    <ControlBar
      isPlaying={false} speed={1} currentTime={0} totalDuration={0}
      onPlayPause={noop} onRestart={noop} onSpeedChange={noop}
      timelineEvents={[]} eventCount={eventCount} onEnterReview={onEnterReview}
    />,
  )
}

test('0 event: Review is unavailable, says why, and does not enter review', async () => {
  let entered = 0
  const { getByRole, container } = bar(0, () => { entered++ })
  const btn = getByRole('button', { name: /review/i })
  assert.equal(btn.getAttribute('aria-disabled'), 'true')
  fireEvent.click(btn)
  assert.equal(entered, 0)
  const reason = btn.getAttribute('aria-describedby')
  assert.ok(reason, 'the reason is linked to the button')
  assert.match(container.ownerDocument.getElementById(reason!)?.textContent ?? '', /no events to review/i)
  const res = await axe.run(container)
  assert.deepEqual(res.violations.map(v => v.id), [])
})

test('the Space shortcut and the button share the rule: no event, no review, a toast says why', () => {
  const calls: string[] = []
  const toasts: { message: string }[] = []
  const hook = renderHook(() => useReviewControls({
    sim: {
      isPlaying: true, maxTimeReached: 0, play: () => calls.push('play'), pause: () => calls.push('pause'), restart: noop, seekToTime: noop,
      saveSnapshot: (() => ({})) as never, restoreSnapshot: noop, setSpeed: noop,
    },
    bridge: { pendingEvents: [], selectedSessionIdRef: { current: null }, flushSessionEvents: noop } as never,
    isReviewing: false, setIsReviewing: () => calls.push('review'), pushToast: t => { toasts.push(t) },
    seekingRef: { current: false }, zoomToFit: noop, autoPlay: false, eventCount: 0,
  }))
  act(() => { hook.result.current.handlePlayPause() })
  act(() => { hook.result.current.handleEnterReview() })
  assert.deepEqual(calls, [])
  assert.equal(toasts.length, 2)
  assert.match(toasts[0].message, /no events to review/i)
})

test('1 event: Review enters review', () => {
  let entered = 0
  const { getByRole } = bar(1, () => { entered++ })
  const btn = getByRole('button', { name: 'Pause and review history' })
  assert.notEqual(btn.getAttribute('aria-disabled'), 'true')
  fireEvent.click(btn)
  assert.equal(entered, 1)
})
