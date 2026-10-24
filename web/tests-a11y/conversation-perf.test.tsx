// #657: the Conversation panel does not pay for the whole history on every render.
// Rows are memoized, the list windows from 50 rows, scroll events are coalesced per frame, measured heights of gone ids are dropped.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, renderHook, act, cleanup } from '@testing-library/react'

import { TranscriptMessage } from '@/components/agent-visualizer/transcript-message'
import { useVirtualList } from '@/hooks/use-virtual-list'
import { VIRTUALIZE_THRESHOLD, pruneMeasuredHeights } from '@/lib/feed-utils'
import type { ConversationMessage } from '@/hooks/simulation/types'

afterEach(() => { cleanup(); document.body.replaceChildren() })

test('the virtualization threshold is between 40 and 60 rows', () => {
  assert.ok(VIRTUALIZE_THRESHOLD >= 40 && VIRTUALIZE_THRESHOLD <= 60, String(VIRTUALIZE_THRESHOLD))
})

test('TranscriptMessage is memoized', () => {
  assert.equal((TranscriptMessage as unknown as { $$typeof: symbol }).$$typeof, Symbol.for('react.memo'))
})

test('a re-render with identical props keeps the same DOM node', () => {
  const m: ConversationMessage = { id: 'r', type: 'tool_result', timestamp: 0, content: '< \x1b[31mred\x1b[0m', toolName: 'Bash' }
  const v = render(<TranscriptMessage message={m} />)
  const before = v.container.firstElementChild
  v.rerender(<TranscriptMessage message={m} />)
  assert.equal(v.container.firstElementChild, before)
})

test('pruneMeasuredHeights drops the ids that are no longer in the list', () => {
  const heights = new Map([['a', 10], ['b', 20], ['gone', 30]])
  pruneMeasuredHeights(heights, [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual([...heights.keys()], ['a', 'b'])
})

test('scroll events of one frame trigger one render', () => {
  const frames: FrameRequestCallback[] = []
  const g = globalThis as unknown as { requestAnimationFrame: unknown; cancelAnimationFrame: unknown }
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame }
  g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb)
  g.cancelAnimationFrame = () => {}
  try {
    const items = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}` }))
    const el = document.createElement('div')
    document.body.appendChild(el)
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useVirtualList(items, { current: el }, { gap: 4, autoScroll: false })
    })
    const base = renders
    act(() => {
      for (let i = 1; i <= 20; i++) { el.scrollTop = i * 10; result.current.handleScroll() }
    })
    assert.equal(renders, base, 'no render before the frame')
    assert.equal(frames.length, 1, 'one frame requested for 20 events')
    act(() => { frames.splice(0).forEach(cb => cb(0)) })
    assert.equal(renders - base, 1)
  } finally {
    g.requestAnimationFrame = saved.raf
    g.cancelAnimationFrame = saved.caf
  }
})
