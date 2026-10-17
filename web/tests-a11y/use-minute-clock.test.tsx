// #467: the clock behind the age and the expiry of the quota ticks once a minute, only when asked, not while hidden.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React, { act } from 'react'
import { render, cleanup } from '@testing-library/react'

import { useMinuteClock } from '@/hooks/use-minute-clock'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

function Probe({ enabled }: { enabled: boolean }) {
  return <output data-testid="now">{useMinuteClock(enabled)}</output>
}

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

/** Replace the interval functions with a recorder: no real waiting, and the number of live timers can be counted */
function fakeIntervals() {
  const live = new Map<number, () => void>()
  let next = 1
  globalThis.setInterval = ((fn: () => void) => { live.set(next, fn); return next++ }) as unknown as typeof setInterval
  globalThis.clearInterval = ((id: number) => { live.delete(id) }) as unknown as typeof clearInterval
  return {
    live,
    restore: () => { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval },
  }
}

test('enabled: one minute-interval, cleared on unmount; the value advances on each tick', async () => {
  const timers = fakeIntervals()
  try {
    const view = render(<Probe enabled />)
    assert.equal(timers.live.size, 1)
    const before = Number(view.getByTestId('now').textContent)
    await new Promise(r => setTimeout(r, 5))
    await act(async () => { for (const tick of timers.live.values()) tick() })
    assert.ok(Number(view.getByTestId('now').textContent) > before, 'the clock moved')
    view.unmount()
    assert.equal(timers.live.size, 0, 'the interval is cleared')
  } finally {
    timers.restore()
  }
})

test('disabled: no timer at all', () => {
  const timers = fakeIntervals()
  try {
    render(<Probe enabled={false} />)
    assert.equal(timers.live.size, 0)
  } finally {
    timers.restore()
  }
})

test('paused while the document is hidden, resumed (with a fresh value) when it is shown again', async () => {
  const timers = fakeIntervals()
  try {
    render(<Probe enabled />)
    assert.equal(timers.live.size, 1)
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')) })
    assert.equal(timers.live.size, 0, 'no timer while hidden')
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    await act(async () => { document.dispatchEvent(new window.Event('visibilitychange')) })
    assert.equal(timers.live.size, 1, 'one timer again, never two')
  } finally {
    timers.restore()
  }
})

test('toggling enabled off stops the timer', () => {
  const timers = fakeIntervals()
  try {
    const view = render(<Probe enabled />)
    assert.equal(timers.live.size, 1)
    view.rerender(<Probe enabled={false} />)
    assert.equal(timers.live.size, 0)
  } finally {
    timers.restore()
  }
})
