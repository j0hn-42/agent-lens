// WCAG 1.4.13: the canvas tooltip (hover or focus) can be dismissed with Escape without moving the pointer or focus (#380)
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { AgentCanvas } from '@/components/agent-visualizer/canvas'
import { createEmptyState } from '@/hooks/simulation/types'

if (typeof (globalThis as any).Path2D === 'undefined') {
  ;(globalThis as any).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} bezierCurveTo() {} quadraticCurveTo() {} }
}
const realGetContext = window.HTMLCanvasElement.prototype.getContext
beforeEach(() => {
  const ctx: any = new Proxy({ canvas: { width: 800, height: 600 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
})

const tick = (ms = 80) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

test('Escape hides the hover tooltip; hovering another agent shows it again', async () => {
  const sim = createEmptyState()
  for (const id of ['a', 'b']) {
    sim.agents.set(id, { id, agentKey: id, sessionId: 's', localId: id, displayName: id, name: id, parentKey: null, parentId: null,
      state: 'idle', tokensUsed: 0, tokensMax: 200_000, contextBreakdown: {}, toolCalls: 0, timeAlive: 0,
      x: id === 'a' ? 0 : 200, y: 0, vx: 0, vy: 0, pinned: false, isMain: id === 'a', spawnTime: 0, opacity: 1, scale: 1,
      messageBubbles: [], runtime: 'claude' } as any)
  }
  sim.currentTime = 10
  const ref = { current: sim }
  const noop = () => {}
  const props = (hovered: string | null) => ({
    simulationRef: ref, selectedAgentId: null, hoveredAgentId: hovered, showStats: false, showHexGrid: false,
    zoomToFitTrigger: 0, onAgentClick: noop, onAgentHover: noop, onAgentDrag: noop, onContextMenu: noop,
  } as any)
  const { container, rerender } = render(React.createElement(AgentCanvas, props('a')))
  const tip = () => container.querySelector<HTMLElement>('[data-sensitive][aria-hidden="true"].pointer-events-none')!
  await tick()
  assert.equal(tip().style.visibility, 'visible', 'hover shows the tooltip')
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await tick()
  assert.equal(tip().style.visibility, 'hidden', 'Escape dismisses it')
  rerender(React.createElement(AgentCanvas, props('b')))
  await tick()
  assert.equal(tip().style.visibility, 'visible', 'another target shows its tooltip')
})
