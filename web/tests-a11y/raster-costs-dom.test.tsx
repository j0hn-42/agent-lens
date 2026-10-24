// DOM side of the raster costs of the canvas (#661): a frame that changes nothing writes nothing to the bubble
// buttons, the tooltip size is not read (reflow) every frame, the mobile media query is made once.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { syncBubbleButtons } from '@/components/agent-visualizer/canvas/edge-bubble-dom'
import { positionTooltip } from '@/components/agent-visualizer/canvas/tooltip'
import { isMobileViewport } from '@/lib/mobile-view'

const spec = (key: string, over: Record<string, unknown> = {}) => ({
  key, linkId: 'L1', messageId: key, label: `label ${key}`, x: 10, y: 20, w: 100, h: 40, collapsed: false, ...over,
})

test('syncBubbleButtons: an unchanged frame writes nothing to the buttons (#661)', () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const specs = [spec('a'), spec('b', { x: 40 })]
  syncBubbleButtons(root, specs)
  const mo = new MutationObserver(() => {})
  mo.observe(root, { attributes: true, subtree: true, childList: true })
  syncBubbleButtons(root, specs)
  assert.equal(mo.takeRecords().length, 0, 'no attribute or style written')
  syncBubbleButtons(root, [spec('a', { x: 11 }), spec('b', { x: 40 })])
  const records = mo.takeRecords()
  assert.ok(records.length > 0 && records.every(r => (r.target as HTMLElement).dataset.key === 'a'), 'only the moved button is written')
  mo.disconnect()
})

test('positionTooltip: the size is read once, then kept by a ResizeObserver (#661)', () => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const had = g.ResizeObserver
  let observed = 0
  g.ResizeObserver = class { observe() { observed++ } disconnect() {} unobserve() {} }
  try {
    const el = document.createElement('div')
    let reads = 0
    Object.defineProperty(el, 'offsetWidth', { get() { reads++; return 120 } })
    Object.defineProperty(el, 'offsetHeight', { get() { reads++; return 50 } })
    const agents = new Map([['a', { id: 'a', x: 300, y: 300, scale: 1 }]]) as never
    const scene = { agents, toolCalls: new Map(), discoveries: [] } as never
    for (let i = 0; i < 30; i++) positionTooltip(el, { x: 0, y: 0, scale: 1 }, 800, 600, scene, { type: 'agent', id: 'a' } as never)
    assert.equal(reads, 2, 'offsetWidth and offsetHeight read once in 30 frames')
    assert.equal(observed, 1)
  } finally {
    g.ResizeObserver = had
  }
})

test('isMobileViewport: the MediaQueryList is made once, matches stays live (#661)', () => {
  const w = window as unknown as { matchMedia?: unknown }
  const had = w.matchMedia
  let calls = 0
  const list = { matches: false }
  w.matchMedia = () => { calls++; return list }
  try {
    for (let i = 0; i < 50; i++) isMobileViewport()
    assert.equal(calls, 1)
    list.matches = true
    assert.equal(isMobileViewport(), true)
    assert.equal(calls, 1)
  } finally {
    w.matchMedia = had
  }
})
