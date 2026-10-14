// Wiring of freshness (#367) in the REAL AgentCanvas: the outline mirror passes the wall clock, so a stale agent is
// announced as its last known state. Dropping `now` from use-canvas-a11y-mirror.ts must fail a test here.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { AgentCanvas } from '@/components/agent-visualizer/canvas'
import { createEmptyState } from '@/hooks/simulation/types'
import type { Agent, Edge } from '@/lib/agent-types'
import { A11Y_SNAPSHOT_MS } from '@/lib/canvas-constants'
import { STALE_AFTER_MS } from '@/lib/canvas-constants'

if (typeof (globalThis as any).Path2D === 'undefined') {
  ;(globalThis as any).Path2D = class { addPath() {} moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} bezierCurveTo() {} quadraticCurveTo() {} }
}

type Call = { name: string; args: unknown[] }
let calls: Call[] = []
const realGetContext = window.HTMLCanvasElement.prototype.getContext

beforeEach(() => {
  calls = []
  const ctx: any = new Proxy({ canvas: { width: 800, height: 600 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return (...args: unknown[]) => { calls.push({ name: k, args }); return undefined }
    },
    set(t: any, k: string, v: unknown) { t[k] = v; calls.push({ name: `set:${k}`, args: [v] }); return true },
  })
  window.HTMLCanvasElement.prototype.getContext = (() => ctx) as never
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  window.HTMLCanvasElement.prototype.getContext = realGetContext
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

const tick = (ms = 60) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
/** The outline is republished by a throttled timer */
const settle = () => tick(A11Y_SNAPSHOT_MS + 150)

function mount(sim: ReturnType<typeof createEmptyState>, props: Record<string, unknown> = {}) {
  const ref = { current: sim }
  const noop = () => {}
  const utils = render(React.createElement(AgentCanvas, {
    simulationRef: ref, selectedAgentId: null, hoveredAgentId: null, showStats: false, showHexGrid: false,
    zoomToFitTrigger: 0, onAgentClick: noop, onAgentHover: noop, onAgentDrag: noop, onContextMenu: noop,
    ...props,
  } as any))
  return utils
}

test('the mounted outline says "last known state" for a stale agent and not for a fresh one', async () => {
  const sim = createEmptyState()
  const now = Date.now()
  sim.agents.set('fresh', agent('fresh', { isMain: true, state: 'thinking', lastEventAt: now, freshnessSource: 'live' }))
  sim.agents.set('old', agent('old', { state: 'thinking', parentKey: 'fresh', parentId: 'fresh', x: 150, lastEventAt: now - STALE_AFTER_MS - 60_000, freshnessSource: 'live' }))
  sim.currentTime = 10
  sim.isPlaying = true
  const { container } = mount(sim)
  await settle()
  const buttons = Array.from(container.querySelectorAll('button[data-graph-node]'))
  const textOf = (name: string) => buttons.find(b => (b.textContent ?? '').startsWith(`${name},`))?.textContent ?? ''
  assert.match(textOf('old'), /last known state: Thinking/)
  assert.doesNotMatch(textOf('fresh'), /last known/)
  assert.match(container.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '', /1 running.*1 last known state/)
})
