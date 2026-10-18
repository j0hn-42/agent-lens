// Tour offered on the first launch (#377): once per browser, never takes the focus, closes with the keyboard.
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, renderHook, act } from '@testing-library/react'
import axe from 'axe-core'

import { TourOffer } from '@/components/agent-visualizer/tour-offer'
import { useTourOffer } from '@/hooks/use-tour-offer'
import { GUIDED_TOUR_BUTTON_ID, CANVAS_CONTROLS_MENU_ID } from '@/components/agent-visualizer/guided-tour-context'
const TOUR_OFFER_STORAGE_KEY = 'agent-lens:tour-offered'

beforeEach(() => { try { window.localStorage.clear() } catch { /* none */ } })
afterEach(() => { cleanup(); document.body.replaceChildren() })

function mount(open: boolean, calls: string[] = []) {
  return render(
    <main id="visualizer-main" tabIndex={-1}>
      <button type="button" id={GUIDED_TOUR_BUTTON_ID}>Tour this session</button>
      <TourOffer open={open} label="Tour this session" onStart={() => calls.push('start')} onDismiss={() => calls.push('dismiss')} />
    </main>,
  )
}

test('the offer is a named region with the tour button and Not now, and does not take the focus', () => {
  const r = mount(true)
  const region = r.getByRole('region', { name: 'New to Agent Lens?' })
  assert.ok(region)
  // Its own name: the tour button of the legend keeps "Tour this session" to itself
  r.getByRole('button', { name: 'Start the tour' })
  r.getByRole('button', { name: 'Tour this session' })
  r.getByRole('button', { name: 'Not now' })
  assert.equal(document.activeElement, document.body)
})

test('the offer text is announced politely, from a live region present before it opens', () => {
  const r = mount(false)
  const status = r.getByRole('status')
  assert.equal(status.textContent, '')
  r.rerender(
    <main id="visualizer-main" tabIndex={-1}>
      <TourOffer open label="Tour this session" onStart={() => {}} onDismiss={() => {}} />
    </main>,
  )
  assert.match(r.getByRole('status').textContent ?? '', /tour/i)
})

test('the buttons start the tour or dismiss the offer', () => {
  const calls: string[] = []
  const r = mount(true, calls)
  fireEvent.click(r.getByRole('button', { name: 'Start the tour' }))
  fireEvent.click(r.getByRole('button', { name: 'Not now' }))
  assert.deepEqual(calls, ['start', 'dismiss'])
})

test('Escape inside the offer dismisses it and the focus goes to the tour button of the legend', () => {
  const calls: string[] = []
  const r = mount(true, calls)
  const notNow = r.getByRole('button', { name: 'Not now' })
  notNow.focus()
  fireEvent.keyDown(notNow, { key: 'Escape' })
  assert.deepEqual(calls, ['dismiss'])
  assert.equal(document.activeElement?.id, GUIDED_TOUR_BUTTON_ID)
})

test('closed by something else while it holds the focus, the offer hands it to the tour button, not to <body>', () => {
  const r = mount(true)
  r.getByRole('button', { name: 'Not now' }).focus()
  r.rerender(
    <main id="visualizer-main" tabIndex={-1}>
      <button type="button" id={GUIDED_TOUR_BUTTON_ID}>Tour this session</button>
      <TourOffer open={false} label="Tour this session" onStart={() => {}} onDismiss={() => {}} />
    </main>,
  )
  assert.equal(document.activeElement?.id, GUIDED_TOUR_BUTTON_ID)
})

test('canvas controls folded (#515): Escape sends the focus to the "Canvas controls" button that holds the tour button', () => {
  const calls: string[] = []
  const r = render(
    <main id="visualizer-main" tabIndex={-1}>
      <button type="button" id={CANVAS_CONTROLS_MENU_ID}>Canvas controls</button>
      <TourOffer open label="Tour this session" onStart={() => {}} onDismiss={() => calls.push('dismiss')} />
    </main>,
  )
  const notNow = r.getByRole('button', { name: 'Not now' })
  notNow.focus()
  fireEvent.keyDown(notNow, { key: 'Escape' })
  assert.deepEqual(calls, ['dismiss'])
  assert.equal(document.activeElement?.id, CANVAS_CONTROLS_MENU_ID)
})

test('the offer has no axe violation', async () => {
  const r = mount(true)
  const results = await axe.run(r.container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })
  assert.deepEqual(results.violations.map(v => v.id), [])
})

// The hook: shown once per browser

const ready = { canStart: true, tourActive: false, guidedDemo: false, immersive: false, presentation: false }

test('the offer opens on the first launch once a tour can start, and is remembered', () => {
  const h = renderHook(p => useTourOffer(p), { initialProps: { ...ready, canStart: false } })
  assert.equal(h.result.current.open, false)
  h.rerender(ready)
  assert.equal(h.result.current.open, true)
  assert.equal(window.localStorage.getItem(TOUR_OFFER_STORAGE_KEY), '1')
  act(() => h.result.current.dismiss())
  assert.equal(h.result.current.open, false)
  h.unmount()
  const again = renderHook(() => useTourOffer(ready))
  assert.equal(again.result.current.open, false)
})

test('starting a tour some other way closes the offer', () => {
  const h = renderHook(p => useTourOffer(p), { initialProps: ready })
  assert.equal(h.result.current.open, true)
  h.rerender({ ...ready, tourActive: true })
  assert.equal(h.result.current.open, false)
})

test('full screen and presentation hide the offer without spending it', () => {
  const h = renderHook(p => useTourOffer(p), { initialProps: { ...ready, presentation: true } })
  assert.equal(h.result.current.open, false)
  assert.equal(window.localStorage.getItem(TOUR_OFFER_STORAGE_KEY), null)
  h.rerender(ready)
  assert.equal(h.result.current.open, true)
  h.rerender({ ...ready, immersive: true })
  assert.equal(h.result.current.open, false)
  h.rerender(ready)
  assert.equal(h.result.current.open, true)
})
