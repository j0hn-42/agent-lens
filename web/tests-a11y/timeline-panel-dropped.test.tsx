// Timeline panel with trimmed blocks and many rows (#659, #613): the counter, the table caption, and the rows drawn.
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { TimelinePanel } from '@/components/agent-visualizer/timeline-panel'
import { olderBlocksText } from '@/lib/timeline-text'
import type { TimelineEntry } from '@/lib/agent-types'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function entry(i: number, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id: `e${i}`, agentId: `a${i}`, agentName: `agent-${i}`, startTime: i,
    blocks: [{ id: `b${i}`, type: 'thinking', startTime: i, endTime: i + 1, label: 'Thinking', color: '#66ccff' } as never],
    ...over,
  }
}

const entries = (n: number, over: (i: number) => Partial<TimelineEntry> = () => ({})) =>
  new Map(Array.from({ length: n }, (_, i) => [`a${i}`, entry(i, over(i))] as const))

/** Names written by the label of each row in the last draw of the canvas */
function recordLabels(): { last: () => string[]; restore: () => void } {
  const proto = window.HTMLCanvasElement.prototype as unknown as { getContext: unknown }
  const had = proto.getContext
  let drawn: string[] = []
  const ctx = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'clearRect') return () => { drawn = [] }
      if (prop === 'fillText') return (text: string) => { drawn.push(String(text)) }
      if (prop === 'measureText') return () => ({ width: 0 })
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => {}
    },
    set: () => true,
  })
  proto.getContext = () => ctx
  return { last: () => drawn.filter(t => t.startsWith('agent-')), restore: () => { proto.getContext = had } }
}

test('trimmed blocks: the counter is shown and the table caption carries it (#613)', async () => {
  const view = render(<TimelinePanel visible timelineEntries={entries(3, i => (i === 0 ? { droppedBlocks: 4 } : { droppedBlocks: 3 }))} currentTime={5} onClose={() => {}} />)
  const text = olderBlocksText('en', 10)
  assert.equal(text, '10 older blocks not shown')
  assert.ok(view.getByText(text), 'the counter is on screen')
  await act(async () => { fireEvent.click(view.getByRole('button', { name: 'Table view' })) })
  const caption = view.getByRole('table').querySelector('caption')!
  assert.ok(caption.textContent?.includes(text), `the caption of the table says the blocks it does not list: "${caption.textContent}"`)
})

test('no trimmed block: nothing is added to the caption or the counter (#613)', () => {
  const view = render(<TimelinePanel visible timelineEntries={entries(3)} currentTime={5} onClose={() => {}} />)
  assert.equal(view.queryByText(/older block/), null)
  assert.ok(!view.getByRole('img').getAttribute('aria-label')?.includes('older block'))
})

test('only the rows in view are drawn, and a scroll draws the new range (#659, #613)', async () => {
  const rec = recordLabels()
  try {
    const view = render(<TimelinePanel visible timelineEntries={entries(100)} currentTime={120} onClose={() => {}} />)
    const first = rec.last()
    assert.ok(first.includes('agent-0'), 'the first rows are drawn')
    assert.ok(!first.includes('agent-60') && !first.includes('agent-99'), `rows out of view are not drawn: ${first.length} drawn`)
    assert.ok(first.length < 30, `${first.length} rows drawn out of 100`)

    const el = view.getByRole('group', { name: 'Timeline scroll area' }) as HTMLElement
    Object.defineProperty(el, 'scrollTop', { configurable: true, value: 22 + 24 * 60 })
    await act(async () => { fireEvent.scroll(el) })
    const after = rec.last()
    assert.ok(after.includes('agent-60'), `the rows now in view are drawn: ${after.join(',')}`)
    assert.ok(!after.includes('agent-0') && !after.includes('agent-99'), 'the rows left behind and the ones far below are not')
    assert.ok(after.length < 30)
  } finally {
    rec.restore()
  }
})
