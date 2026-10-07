// AgentCanvas integration of the edge bubbles (issue #41): the DOM button layer is wired to the draw loop,
// hovered / focused bubbles are held through selection, a click reaches onLinkClick, and the halo model
// takes the sessions prop. jsdom: the 2D context is a no-op, so only the DOM side is observable.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { AgentCanvas } from '@/components/agent-visualizer/canvas'
import { createEmptyState } from '@/hooks/simulation/types'
import type { Agent } from '@/lib/agent-types'

// jsdom has no Path2D; the 2D context is a no-op, so an inert stand-in is enough
if (typeof (globalThis as any).Path2D === 'undefined') {
  ;(globalThis as any).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} bezierCurveTo() {} quadraticCurveTo() {} }
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function agent(id: string, over: Record<string, unknown> = {}): Agent {
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id, parentKey: null, parentId: null,
    state: 'idle', tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], runtime: 'claude',
    ...over,
  } as unknown as Agent
}

function makeSim(simTime: number) {
  const sim = createEmptyState()
  const lead = agent('lead', { isMain: true, x: -150, y: 0 })
  const child = agent('child', { x: 150, y: 0, parentKey: 'lead', parentId: 'lead' })
  sim.agents.set('lead', lead)
  sim.agents.set('child', child)
  sim.links.set('L1', {
    id: 'L1', from: 'lead', to: 'child', kind: 'spawn', sessionId: 's1', dropped: 0,
    messages: [{ id: 'm1', type: 'dispatch', content: 'Find the auth code', timestamp: simTime, from: 'lead', to: 'child' }],
  } as any)
  sim.currentTime = simTime
  sim.isPlaying = true
  return sim
}

const tick = (ms = 60) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

function mount(sim: ReturnType<typeof makeSim>, props: Record<string, unknown> = {}) {
  const ref = { current: sim }
  const noop = () => {}
  const utils = render(React.createElement(AgentCanvas, {
    simulationRef: ref, selectedAgentId: null, hoveredAgentId: null, showStats: false, showHexGrid: false,
    zoomToFitTrigger: 0, onAgentClick: noop, onAgentHover: noop, onAgentDrag: noop, onContextMenu: noop,
    ...props,
  } as any))
  const layer = utils.container.querySelector('[data-edge-bubble-layer]') as HTMLElement
  return { ...utils, layer, buttons: () => Array.from(layer.querySelectorAll<HTMLButtonElement>('button[data-edge-bubble]')) }
}

test('the draw loop fills the bubble layer with a named button per live bubble; click calls onLinkClick', async () => {
  const clicked: string[] = []
  const { buttons, layer } = mount(makeSim(10), { onLinkClick: (id: string) => clicked.push(id) })
  assert.ok(layer, 'the layer is rendered')
  await tick()
  const [b] = buttons()
  assert.ok(b, 'a button exists for the dispatch bubble')
  assert.equal(b.getAttribute('aria-label'), 'lead to child, dispatch: Find the auth code')
  fireEvent.click(b)
  assert.deepEqual(clicked, ['L1'])
})

test('a focused bubble is held through selection: it outlives its expiry and goes away on blur', async () => {
  const sim = makeSim(10)
  const { buttons } = mount(sim)
  await tick()
  const [b] = buttons()
  assert.ok(b)
  b.focus()
  assert.equal(document.activeElement, b)
  sim.currentTime = 10 + 100 // far past EDGE_BUBBLE.visibleS
  await tick()
  assert.equal(buttons().length, 1, 'held by focus')
  assert.equal(buttons()[0], b, 'the very same button keeps its focus')
  assert.equal(b.dataset.unplaced, undefined, 'still placed by the planner, not just parked to keep focus')
  assert.equal(b.style.opacity, '')
  assert.equal(document.activeElement, b)
  b.blur()
  await tick()
  assert.equal(buttons().length, 0, 'released on blur, the expired bubble disappears')
})

test('a hovered bubble is held too, and removing it clears the hold', async () => {
  const sim = makeSim(10)
  const { buttons } = mount(sim)
  await tick()
  const [b] = buttons()
  fireEvent.pointerOver(b)
  sim.currentTime = 200
  await tick()
  assert.equal(buttons().length, 1, 'held by hover')
  fireEvent.pointerOut(b)
  await tick()
  assert.equal(buttons().length, 0)
})

test('an expired bubble that nobody holds has no button', async () => {
  const { buttons } = mount(makeSim(10))
  await tick()
  assert.equal(buttons().length, 1)
  const sim = makeSim(10)
  sim.currentTime = 500
  const second = mount(sim)
  await tick()
  assert.equal(second.buttons().length, 0)
})

test('wheel over a bubble reaches the canvas handler (not swallowed by the button)', async () => {
  const { buttons, container } = mount(makeSim(10))
  await tick()
  const canvas = container.querySelector('canvas') as HTMLCanvasElement
  const seen: number[] = []
  canvas.addEventListener('wheel', e => seen.push((e as WheelEvent).deltaY))
  const [b] = buttons()
  b.dispatchEvent(new window.WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }))
  assert.deepEqual(seen, [40])
})

test('the sessions prop labels the halos in the outline (session label, not the raw id)', async () => {
  const sim = makeSim(10)
  sim.agents.set('other', agent('other', { sessionId: 's2', isMain: true, x: 900, y: 0 }))
  const sessions = new Map([['s1', { label: 'payments-api', workspace: 'payments', runtime: 'claude' as const }]])
  const { container } = mount(sim, { sessions })
  await tick(400)
  const text = container.textContent ?? ''
  assert.match(text, /payments-api/)
  assert.doesNotMatch(text, /Session s1 \(/)
})

/**
 * A pointer event with the semantics a real browser gives it. A pointermove during a drag has
 * button -1 and buttons 1 (a MouseEvent with button 0 hides the defect this guards).
 */
function realPointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number): Event {
  const down = type === 'pointerdown'
  const up = type === 'pointerup'
  const init = {
    clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
    button: down || up ? 0 : -1, buttons: up ? 0 : 1,
  }
  const PE = (window as any).PointerEvent as typeof MouseEvent | undefined
  if (PE) return new PE(type, { ...init, pointerId: 7, pointerType: 'mouse', isPrimary: true } as any)
  const ev = new window.MouseEvent(type, init)
  Object.defineProperty(ev, 'pointerId', { value: 7 })
  Object.defineProperty(ev, 'pointerType', { value: 'mouse' })
  Object.defineProperty(ev, 'isPrimary', { value: true })
  return ev
}
const tx = (b: HTMLElement) => {
  const m = /translate\((-?\d+)px, (-?\d+)px\)/.exec(b.style.transform)
  assert.ok(m, `button has a translate transform, got "${b.style.transform}"`)
  return { x: Number(m![1]), y: Number(m![2]) }
}

test('dragging from a bubble pans the camera through the real canvas pointer handler', async () => {
  const sim = makeSim(10)
  sim.isPlaying = false
  const linkClicks: string[] = []
  const { buttons } = mount(sim, { onLinkClick: (id: string) => linkClicks.push(id) })
  await tick()
  const [b] = buttons()
  assert.ok(b)
  await tick(300)
  const before = tx(buttons()[0])
  // Press on the bubble's centre: it sits on the link, and a pan carries the link with the pointer, so the
  // release lands on the link again (the pointerup must not read that as a click on it)
  const c = { x: before.x + parseInt(b.style.width, 10) / 2, y: before.y + parseInt(b.style.height, 10) / 2 }
  // One act() per event, and a frame between them like a browser: the move handler reads the isDragging state.
  // The release comes after the measure: a released pan keeps flying (inertia) and would blur the numbers.
  const send = (ev: Event) => act(() => { b.dispatchEvent(ev) })
  await send(realPointer('pointerdown', c.x, c.y))
  await send(realPointer('pointermove', c.x + 30, c.y + 20))
  await tick(20)
  await send(realPointer('pointermove', c.x + 60, c.y + 40))
  await tick(60)
  const after = tx(buttons()[0])
  await send(realPointer('pointerup', c.x + 60, c.y + 40))
  assert.deepEqual(linkClicks, [], 'a pan that ends on the link does not open it')
  assert.deepEqual({ dx: after.x - before.x, dy: after.y - before.y }, { dx: 60, dy: 40 }, 'the camera followed the drag')
})

test('a short press on a bubble does not pan', async () => {
  const sim = makeSim(10)
  sim.isPlaying = false
  const { buttons } = mount(sim)
  await tick()
  const [b] = buttons()
  await tick(300)
  const before = tx(buttons()[0])
  act(() => {
    b.dispatchEvent(realPointer('pointerdown', 100, 100))
    b.dispatchEvent(realPointer('pointermove', 102, 101))
    b.dispatchEvent(realPointer('pointerup', 102, 101))
  })
  await tick()
  assert.deepEqual(tx(buttons()[0]), before)
})
