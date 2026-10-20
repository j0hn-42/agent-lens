// #613 (WCAG 3.1.2 and 2.5.3): the presentation badge and the "No events to review yet" toast are translated, so they
// declare the language of the interface; the badge's accessible name contains its visible text.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'
import { PresentationBadge } from '@/components/agent-visualizer/presentation-subtitle'
import { ToastRegion } from '@/components/agent-visualizer/toast-region'
import { useReviewControls } from '@/hooks/use-review-controls'
import { useToasts } from '@/hooks/use-toasts'
import { setLocaleChoice } from '@/lib/locale'
import { MESSAGES } from '@/lib/messages'

afterEach(() => { cleanup(); document.body.replaceChildren(); setLocaleChoice('auto') })

const noop = () => {}

function Review({ onReady }: { onReady: (refuse: () => void) => void }) {
  const toasts = useToasts()
  const sim = {
    isPlaying: true, maxTimeReached: 0, play: noop, pause: noop, restart: noop, setSpeed: noop, seekToTime: noop,
    saveSnapshot: noop, restoreSnapshot: noop,
  }
  const review = useReviewControls({
    sim, bridge: { pendingEvents: [], selectedSessionIdRef: { current: null }, flushSessionEvents: noop }, isReviewing: false, setIsReviewing: noop, pushToast: toasts.push,
    seekingRef: { current: false }, zoomToFit: noop, autoPlay: false, eventCount: 0,
  } as unknown as Parameters<typeof useReviewControls>[0])
  onReady((review as unknown as { handleEnterReview: () => void }).handleEnterReview)
  return <ToastRegion toasts={toasts.toasts} onAction={toasts.runAction} onDismiss={toasts.dismiss} onPause={toasts.setPaused} />
}

for (const locale of ['fr', 'en'] as const) {
  test(`badge: text, name and tooltip declare ${locale}, the name contains the visible text`, () => {
    setLocaleChoice(locale)
    const m = MESSAGES[locale]
    const r = render(<PresentationBadge onStop={noop} />)
    const button = r.getByRole('button', { name: new RegExp(m['presentation.badge'].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    assert.equal(button.textContent, m['presentation.badge'])
    assert.equal(button.getAttribute('lang'), locale, 'the button (text, name and title) carries the language')
    const name = button.getAttribute('aria-label') ?? button.textContent ?? ''
    assert.ok(name.includes(m['presentation.badge']), '2.5.3: the name contains the visible label')
  })

  test(`toast "No events to review yet" declares ${locale} and does not take focus`, () => {
    setLocaleChoice(locale)
    let enter: () => void = noop
    const r = render(<Review onReady={fn => { enter = fn }} />)
    const before = document.activeElement
    act(() => { enter() })
    const text = r.getByText(MESSAGES[locale]['bar.review.empty'])
    assert.equal(text.closest('[lang]')?.getAttribute('lang'), locale)
    assert.ok(text.closest('[role="status"]'), 'announced by the live region')
    assert.equal(r.container.querySelectorAll('[role="status"]').length, 1, 'no second live region')
    assert.equal(document.activeElement, before, 'focus does not move')
  })
}
