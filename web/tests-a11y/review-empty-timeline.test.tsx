// Review sur une timeline vide (#383): rien à parcourir, le bouton le dit au lieu d'ouvrir un mode vide.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, renderHook, act } from '@testing-library/react'
import { useReviewControls } from '@/hooks/use-review-controls'
import axe from 'axe-core'
import { setLocaleChoice } from '@/lib/locale'

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

test('0 event: Review is unavailable and says why', async () => {
  const { getByRole, container } = bar(0, noop)
  const btn = getByRole('button', { name: /review/i })
  assert.equal(btn.getAttribute('aria-disabled'), 'true')
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

test('the toast says the same catalog sentence as the reason, in the language of the bar (#613)', () => {
  try {
    for (const [locale, text] of [['en', 'No events to review yet'], ['fr', 'Aucun événement à revoir pour l’instant']] as const) {
      setLocaleChoice(locale)
      const toasts: string[] = []
      const hook = renderHook(() => useReviewControls({
        sim: {
          isPlaying: true, maxTimeReached: 0, play: noop, pause: noop, restart: noop, seekToTime: noop,
          saveSnapshot: (() => ({})) as never, restoreSnapshot: noop, setSpeed: noop,
        },
        bridge: { pendingEvents: [], selectedSessionIdRef: { current: null }, flushSessionEvents: noop } as never,
        isReviewing: false, setIsReviewing: noop, pushToast: t => { toasts.push(t.message) },
        seekingRef: { current: false }, zoomToFit: noop, autoPlay: false, eventCount: 0,
      }))
      act(() => { hook.result.current.handleEnterReview() })
      assert.deepEqual(toasts, [text], locale)
      hook.unmount()
    }
  } finally {
    setLocaleChoice('auto')
  }
})

test('1 event: Review enters review', () => {
  let entered = 0
  const { getByRole } = bar(1, () => { entered++ })
  const btn = getByRole('button', { name: 'Pause and review history' })
  assert.notEqual(btn.getAttribute('aria-disabled'), 'true')
  fireEvent.click(btn)
  assert.equal(entered, 1)
})

test('0 event: a click on the grayed Review button still reaches the handler, which refuses with a toast (#383 review)', () => {
  let entered = 0
  const { getByRole } = bar(0, () => { entered++ })
  fireEvent.click(getByRole('button', { name: 'Pause and review history' }))
  assert.equal(entered, 1, 'the click is not swallowed: the handler says why it refuses')
})

test('in review, Pause still works when a reload emptied the timeline (#383 review)', () => {
  const calls: string[] = []
  const toasts: string[] = []
  const hook = renderHook(() => useReviewControls({
    sim: {
      isPlaying: true, maxTimeReached: 0, play: noop, pause: () => calls.push('pause'), restart: noop, seekToTime: noop,
      saveSnapshot: (() => ({})) as never, restoreSnapshot: noop, setSpeed: noop,
    },
    bridge: { pendingEvents: [], selectedSessionIdRef: { current: null }, flushSessionEvents: noop } as never,
    isReviewing: true, setIsReviewing: noop, pushToast: t => { toasts.push(t.message) },
    seekingRef: { current: false }, zoomToFit: noop, autoPlay: false, eventCount: 0,
  }))
  act(() => { hook.result.current.handlePlayPause() })
  assert.deepEqual(calls, ['pause'])
  assert.ok(!toasts.some(m => /no events/i.test(m)))
})

test('the reason is written in the language of the bar (catalog text, no foreign lang), so a screen reader uses the right voice', () => {
  for (const [locale, name, text] of [['en', 'Pause and review history', 'No events to review yet'], ['fr', 'Revue : mettre en pause et revoir l’historique', 'Aucun événement à revoir pour l’instant']] as const) {
    setLocaleChoice(locale)
    const { getByRole, container } = bar(0, noop)
    const reason = container.ownerDocument.getElementById(getByRole('button', { name }).getAttribute('aria-describedby')!)
    assert.equal(reason?.textContent, text, locale)
    assert.equal(reason?.getAttribute('lang'), null, `${locale}: it inherits the lang of the bar`)
    assert.equal(reason?.closest('[lang]')?.getAttribute('lang'), locale, `${locale}: the bar declares its language`)
    cleanup()
  }
  setLocaleChoice('auto')
})
