// #371 (WCAG 2.2.1): a toast that carries an action (Undo) is never evicted by newer toasts and never expires
// by itself; it goes away when the action runs or the user dismisses it. Plain toasts keep the bounded queue.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { useToasts } from '@/hooks/use-toasts'

beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'Date'] }) })
afterEach(() => { cleanup(); mock.timers.reset(); document.body.replaceChildren() })

test('three closed sessions in a row keep all three Undo toasts and expire none', () => {
  const { result } = renderHook(() => useToasts())
  const expired: number[] = []
  act(() => {
    for (let i = 1; i <= 4; i++) {
      result.current.push({ message: `closed ${i}`, actionLabel: 'Undo', onAction: () => {}, onExpire: () => expired.push(i), durationMs: 5000 })
    }
  })
  assert.equal(result.current.toasts.length, 4, 'no eviction, even past the queue bound')
  assert.deepEqual(expired, [])
})

test('an action toast survives its nominal duration', () => {
  const { result } = renderHook(() => useToasts())
  let expired = 0
  act(() => { result.current.push({ message: 'closed', actionLabel: 'Undo', onAction: () => {}, onExpire: () => { expired++ }, durationMs: 5000 }) })
  act(() => { mock.timers.tick(10 * 60_000) })
  assert.equal(result.current.toasts.length, 1)
  assert.equal(expired, 0)
})

test('dismissing an action toast still runs onExpire; using its action does not', () => {
  const { result } = renderHook(() => useToasts())
  let expired = 0
  let acted = 0
  act(() => {
    result.current.push({ message: 'a', actionLabel: 'Undo', onAction: () => { acted++ }, onExpire: () => { expired++ } })
    result.current.push({ message: 'b', actionLabel: 'Undo', onAction: () => { acted++ }, onExpire: () => { expired++ } })
  })
  act(() => { result.current.dismiss(result.current.toasts[0].id) })
  assert.equal(expired, 1)
  act(() => { result.current.runAction(result.current.toasts[0].id) })
  assert.equal(acted, 1)
  assert.equal(expired, 1)
  assert.equal(result.current.toasts.length, 0)
})

test('plain toasts still expire and are evicted oldest first, sparing action toasts', () => {
  const { result } = renderHook(() => useToasts())
  act(() => {
    result.current.push({ message: 'undo me', actionLabel: 'Undo', onAction: () => {} })
    for (let i = 1; i <= 4; i++) result.current.push({ message: `plain ${i}` })
  })
  const messages = result.current.toasts.map(t => t.message)
  assert.ok(messages.includes('undo me'))
  assert.equal(result.current.toasts.length, 3)
  assert.deepEqual(messages, ['undo me', 'plain 3', 'plain 4'])
  act(() => { mock.timers.tick(6000) })
  assert.deepEqual(result.current.toasts.map(t => t.message), ['undo me'])
})
