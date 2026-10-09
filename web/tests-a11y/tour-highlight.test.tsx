import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup } from '@testing-library/react'
import { ringRect, TourHighlight, AGENT_RING_RADIUS } from '@/components/agent-visualizer/tour-highlight'
import { TourBridgeContext } from '@/components/agent-visualizer/guided-tour-context'

afterEach(() => { cleanup(); document.body.replaceChildren() })

const toScreen = (x: number, y: number) => ({ x: x * 2 + 10, y: y * 2 + 20 })

test('an agent target is ringed around its screen position', () => {
  const agents = new Map([['k', { name: 'api-dev', x: 5, y: 7 }]])
  const r = ringRect({ kind: 'agent', name: 'api-dev' }, agents, toScreen, () => null)
  assert.deepEqual(r, { left: 20 - AGENT_RING_RADIUS, top: 34 - AGENT_RING_RADIUS, width: AGENT_RING_RADIUS * 2, height: AGENT_RING_RADIUS * 2 })
})

test('a missing agent, a missing element or no conversion gives no ring', () => {
  assert.equal(ringRect({ kind: 'agent', name: 'ghost' }, new Map(), toScreen, () => null), null)
  assert.equal(ringRect({ kind: 'agent', name: 'a' }, new Map([['k', { name: 'a', x: 0, y: 0 }]]), null, () => null), null)
  assert.equal(ringRect({ kind: 'dom', id: 'nope' }, new Map(), toScreen, () => null), null)
  assert.equal(ringRect({ kind: 'none' }, new Map(), toScreen, () => null), null)
})

test('a DOM target is ringed around its bounding box', () => {
  const el = { getBoundingClientRect: () => ({ left: 3, top: 4, width: 50, height: 20 }) } as unknown as Element
  assert.deepEqual(ringRect({ kind: 'dom', id: 'x' }, new Map(), toScreen, () => el), { left: 3, top: 4, width: 50, height: 20 })
})

test('the ring is decorative: hidden from assistive technology and not clickable', () => {
  const el = document.createElement('div'); el.setAttribute('data-tour-target', 'box'); document.body.appendChild(el)
  el.getBoundingClientRect = () => ({ left: 1, top: 1, width: 10, height: 10, right: 11, bottom: 11, x: 1, y: 1, toJSON() {} }) as DOMRect
  const view = render(
    <TourBridgeContext.Provider value={{ legendOpen: false, canvasToScreenRef: { current: null } }}>
      <TourHighlight target={{ kind: 'dom', id: 'box' }} getAgents={() => new Map()} />
    </TourBridgeContext.Provider>,
  )
  const ring = view.container.querySelector('[data-tour-ring]')
  assert.ok(ring)
  assert.equal(ring!.getAttribute('aria-hidden'), 'true')
  assert.match(ring!.getAttribute('class') ?? '', /pointer-events-none/)
})
