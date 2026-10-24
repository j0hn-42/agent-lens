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

test('syncBubbleButtons: a focused bubble that is no longer placed is not rewritten every frame (#613)', () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  syncBubbleButtons(root, [spec('a'), spec('b', { x: 40 })])
  const a = root.querySelector('[data-key="a"]') as HTMLButtonElement
  a.focus()
  assert.equal(document.activeElement, a)
  syncBubbleButtons(root, [spec('b', { x: 40 })])
  assert.equal(a.dataset.unplaced, 'true')
  assert.equal(a.getAttribute('aria-hidden'), 'true')
  assert.equal(a.tabIndex, -1)
  const mo = new MutationObserver(() => {})
  mo.observe(root, { attributes: true, subtree: true, childList: true })
  for (let i = 0; i < 5; i++) syncBubbleButtons(root, [spec('b', { x: 40 })])
  assert.equal(mo.takeRecords().length, 0, 'nothing written for the unplaced focused button')
  // placed again: the button is usable again
  syncBubbleButtons(root, [spec('a'), spec('b', { x: 40 })])
  assert.equal(a.dataset.unplaced, undefined)
  assert.equal(a.hasAttribute('aria-hidden'), false)
  assert.equal(a.tabIndex, 0)
  mo.disconnect()
  root.remove()
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

test('positionTooltip: a new size from the ResizeObserver repositions the tooltip before the next frame (#613)', () => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const had = g.ResizeObserver
  const holder: { deliver?: (entries: Array<{ target: Element }>) => void } = {}
  g.ResizeObserver = class {
    constructor(cb: (entries: Array<{ target: Element }>) => void) { holder.deliver = cb }
    observe() {} disconnect() {} unobserve() {}
  }
  try {
    const el = document.createElement('div')
    let width = 120
    Object.defineProperty(el, 'offsetWidth', { get() { return width } })
    Object.defineProperty(el, 'offsetHeight', { get() { return 50 } })
    const agents = new Map([['a', { id: 'a', x: 300, y: 300, scale: 1 }]]) as never
    const scene = { agents, toolCalls: new Map(), discoveries: [] } as never
    positionTooltip(el, { x: 0, y: 0, scale: 1 }, 800, 600, scene, { type: 'agent', id: 'a' } as never)
    const before = el.style.transform
    // the content changed: the tooltip is wider, the observer delivers the new size after layout
    width = 300
    assert.ok(holder.deliver, 'a ResizeObserver was made')
    holder.deliver!([{ target: el }])
    assert.notEqual(el.style.transform, before, 'repositioned by the observer callback, not one frame later')
    const x = Number(/translate\((-?\d+)px/.exec(el.style.transform)![1])
    assert.ok(Math.abs(x - 150) <= 1, `centered on the node with the new width (x=${x})`)
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
