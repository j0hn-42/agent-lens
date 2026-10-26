// useSessionViewSwap (#613): coming back to a cached session restarts from the buffer only when a trim dropped events
// after the snapshot AND the buffer still holds the lifecycle events; a freed buffer keeps the snapshot.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup } from '@testing-library/react'
import { useSessionViewSwap } from '@/hooks/use-session-view-swap'

afterEach(() => { cleanup(); document.body.replaceChildren() })

interface Fake { count: number; buffered: number; lifecycle: number }

function setup(fake: Fake) {
  const calls: string[] = []
  const flushed: Array<[string, number | undefined]> = []
  const base = {
    flushSessionEvents: (id: string, from?: number) => { calls.push('flush'); flushed.push([id, from]) },
    getSessionEventCount: () => fake.count,
    getBufferedEventCount: () => fake.buffered,
    getBufferedLifecycleCount: () => fake.lifecycle,
    getViewMark: () => fake.count,
    getMemoryDropped: () => 0,
    allViewKey: 'k',
  }
  const props = {
    restart: () => { calls.push('restart') },
    saveSnapshot: () => ({}) as never,
    restoreSnapshot: () => { calls.push('restore') },
    isReviewingRef: { current: false },
    onReviewEnded: () => {},
  }
  const hook = renderHook(
    ({ sel }: { sel: string }) => useSessionViewSwap({ bridge: { ...base, selectedSessionId: sel } as never, ...props }),
    { initialProps: { sel: 'a' } },
  )
  const go = (sel: string) => { calls.length = 0; flushed.length = 0; hook.rerender({ sel }) }
  return { calls, flushed, go }
}

// Visit 'a' (nothing cached), leave for 'b' (a's snapshot is saved at snapshotCount), then come back to 'a'.
function backToA(snapshotCount: number, after: Fake) {
  const fake: Fake = { count: snapshotCount, buffered: snapshotCount, lifecycle: 3 }
  const t = setup(fake)
  t.go('b')
  Object.assign(fake, after)
  t.go('a')
  return t
}

test('no base past the snapshot: the cached view is restored and flushed from its count', () => {
  const t = backToA(100, { count: 130, buffered: 130, lifecycle: 3 })
  assert.deepEqual(t.calls, ['restore', 'flush'])
  assert.deepEqual(t.flushed, [['a', 100]])
})

test('trimmed past the snapshot with lifecycle events kept: restart, flush from the start', () => {
  const t = backToA(100, { count: 400, buffered: 150, lifecycle: 3 })
  assert.deepEqual(t.calls, ['restart', 'flush'])
  assert.deepEqual(t.flushed, [['a', undefined]])
})

test('freed past the snapshot (no lifecycle event left): the snapshot is kept, never an empty canvas', () => {
  const t = backToA(100, { count: 400, buffered: 20, lifecycle: 0 })
  assert.deepEqual(t.calls, ['restore', 'flush'])
  assert.deepEqual(t.flushed, [['a', 100]])
})

test('lifecycle events kept at the head: loss after the snapshot is seen though base <= snapshot count', () => {
  // 10 lifecycle + 4990 calls, snapshot at 5000, then 4995 more events: base 4995 < 5000 yet events 5000.. are gone
  const t = backToA(5000, { count: 9995, buffered: 5000, lifecycle: 10 })
  assert.deepEqual(t.calls, ['restart', 'flush'])
})
