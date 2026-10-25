// The ResizeObserver of the tooltip (#613): when the global constructor changes the observer is replaced, the old one
// is disconnected, and a tooltip it was watching is observed again by the new one (its size is read afresh).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { positionTooltip } from '@/components/agent-visualizer/canvas/tooltip'

const transform = { x: 0, y: 0, scale: 1 }
const target = { type: 'agent', id: 'a' } as never
const scene = { agents: new Map([['a', { id: 'a', x: 300, y: 300, scale: 1 }]]), toolCalls: new Map(), discoveries: [] } as never

function observerClass(log: string[], name: string) {
  return class {
    observe() { log.push(`${name}.observe`) }
    disconnect() { log.push(`${name}.disconnect`) }
    unobserve() {}
  }
}

test('a replaced ResizeObserver is disconnected and the new one watches the tooltip again (#613)', () => {
  const g = globalThis as unknown as { ResizeObserver?: unknown }
  const had = g.ResizeObserver
  const log: string[] = []
  try {
    const el = document.createElement('div')
    let width = 120
    Object.defineProperty(el, 'offsetWidth', { get() { return width } })
    Object.defineProperty(el, 'offsetHeight', { get() { return 50 } })

    g.ResizeObserver = observerClass(log, 'first')
    positionTooltip(el, transform, 800, 600, scene, target)
    assert.deepEqual(log, ['first.observe'])

    width = 200
    g.ResizeObserver = observerClass(log, 'second')
    positionTooltip(el, transform, 800, 600, scene, target)
    assert.ok(log.includes('first.disconnect'), `the old observer is never disconnected: ${log.join(', ')}`)
    assert.ok(log.includes('second.observe'), `the new observer does not watch the tooltip: ${log.join(', ')}`)
    const x = Number(/translate\((-?\d+)px/.exec(el.style.transform)![1])
    assert.ok(Math.abs(x - 200) <= 1, `the size is read afresh for the new observer (x=${x})`)
  } finally {
    g.ResizeObserver = had
  }
})
