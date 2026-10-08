// AgentCanvas wiring, mounted for real with a recording 2D context and the keyboard / outline:
//  - automatic branch collapse (#55): the outline hides the descendants of a collapsed branch, the
//    'Expand branch' button and the Right / Left keys toggle it
//  - unverified edges (#54) are drawn dashed, verified ones solid
//  - the delegation path of the selected agent and the session links of the 'All' view are drawn
// The pure models are tested elsewhere; here the canvas must actually call them.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, afterEach, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'

import { AgentCanvas } from '@/components/agent-visualizer/canvas'
import { createEmptyState } from '@/hooks/simulation/types'
import type { Agent, Edge } from '@/lib/agent-types'
import { A11Y_SNAPSHOT_MS } from '@/lib/canvas-constants'
import { badgeRect, badgeSizeText } from '@/components/agent-visualizer/canvas/branch-collapse'

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

/** lead (root) > mid > leaf1, leaf2: everything idle, so `mid` collapses by default */
function branchSim() {
  const sim = createEmptyState()
  sim.agents.set('lead', agent('lead', { isMain: true, x: -200, y: 0 }))
  sim.agents.set('mid', agent('mid', { x: 0, y: 0, parentKey: 'lead', parentId: 'lead' }))
  sim.agents.set('leaf1', agent('leaf1', { x: 150, y: -60, parentKey: 'mid', parentId: 'mid' }))
  sim.agents.set('leaf2', agent('leaf2', { x: 150, y: 60, parentKey: 'mid', parentId: 'mid' }))
  sim.currentTime = 10
  sim.isPlaying = true
  return sim
}

const outlineButton = (container: HTMLElement, text: RegExp) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b => text.test(b.textContent ?? ''))
const graphSurface = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="img"][tabindex="0"]')!

test('a collapsed branch hides its descendants from the outline; the Expand button brings them back', async () => {
  const { container } = mount(branchSim())
  await tick()
  assert.ok(outlineButton(container, /^mid,/), 'the branch node itself stays')
  assert.equal(outlineButton(container, /^leaf1,/), undefined, 'descendants of the collapsed branch are removed from the scene')
  assert.equal(outlineButton(container, /^leaf2,/), undefined)
  const expand = outlineButton(container, /^Branch of mid$/)
  assert.ok(expand, 'the toggle names the branch it expands')
  assert.equal(expand!.getAttribute('aria-expanded'), 'false')

  fireEvent.click(expand!)
  await settle()
  assert.ok(outlineButton(container, /^leaf1,/) && outlineButton(container, /^leaf2,/), 'descendants are back')
  const collapse = outlineButton(container, /^Branch of mid$/)
  assert.ok(collapse, 'the same button now collapses')
  assert.equal(collapse!.getAttribute('aria-expanded'), 'true')

  fireEvent.click(collapse!)
  await settle()
  assert.equal(outlineButton(container, /^leaf1,/), undefined, 'folded again')
})

test('Right on the focused collapsed agent expands it, Left folds it again (tree keys)', async () => {
  const { container } = mount(branchSim())
  await tick()
  const midButton = outlineButton(container, /^mid,/)!
  fireEvent.focus(midButton) // the outline focus becomes the canvas focused node
  await tick(20)
  const surface = graphSurface(container)
  assert.ok(surface)
  fireEvent.keyDown(surface, { key: 'ArrowRight' })
  await settle()
  assert.ok(outlineButton(container, /^leaf1,/), 'Right opened the branch')
  fireEvent.keyDown(surface, { key: 'ArrowLeft' })
  await settle()
  assert.equal(outlineButton(container, /^leaf1,/), undefined, 'Left folded it')
})

test('collapsed branches draw their badge on the canvas; an open one does not', async () => {
  const { container } = mount(branchSim())
  await tick()
  const badgeText = () => calls.filter(c => c.name === 'fillText' && /^\+\d+$/.test(String(c.args[0]))).map(c => c.args[0])
  assert.ok(badgeText().includes('+2'), `the badge shows the hidden agents, got ${JSON.stringify(badgeText())}`)
  fireEvent.click(outlineButton(container, /^Branch of mid$/)!)
  await settle()
  calls.length = 0
  await tick()
  assert.deepEqual(badgeText(), [], 'no badge once the branch is open')
})

test('a mouse click on the badge of a collapsed branch toggles it (onToggleBranch from the canvas hit test)', async () => {
  const { container } = mount(branchSim())
  await tick()
  assert.equal(outlineButton(container, /^leaf1,/), undefined, 'precondition: folded')
  const mid = branchSim().agents.get('mid')!
  const r = badgeRect(mid, badgeSizeText({ kind: 'count', text: '+2' }))
  // The camera transform is read back from the last frame: the first translate/scale after its setTransform
  const frameStart = calls.map(c => c.name).lastIndexOf('setTransform')
  const t = calls.slice(frameStart).findIndex(c => c.name === 'translate')
  const cam = { x: calls[frameStart + t].args[0] as number, y: calls[frameStart + t].args[1] as number, scale: calls[frameStart + t + 1].args[0] as number }
  assert.equal(calls[frameStart + t + 1].name, 'scale', 'the camera transform is a translate followed by a scale')
  const x = cam.x + (r.x + r.w / 2) * cam.scale
  const y = cam.y + (r.y + r.h / 2) * cam.scale
  const canvas = container.querySelector('canvas')!
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0 })
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0 })
  await settle()
  assert.ok(outlineButton(container, /^leaf1,/) && outlineButton(container, /^leaf2,/), 'the click on the badge opened the branch')
})

function edgeSim(verified: boolean | undefined) {
  const sim = createEmptyState()
  sim.agents.set('lead', agent('lead', { isMain: true, state: 'thinking', x: -150, y: 0 }))
  sim.agents.set('child', agent('child', { state: 'thinking', x: 150, y: 0, parentKey: 'lead', parentId: 'lead' }))
  const edge: Edge = { id: 'e1', from: 'lead', to: 'child', type: 'parent-child', opacity: 1, ...(verified === undefined ? {} : { verified }) }
  sim.edges = [edge]
  sim.currentTime = 10
  sim.isPlaying = true
  return sim
}
const dashes = () => calls.filter(c => c.name === 'setLineDash').map(c => JSON.stringify(c.args[0]))

test('an unverified parent-child edge is drawn dashed by the canvas', async () => {
  mount(edgeSim(false))
  await tick()
  assert.ok(dashes().includes('[7,6]'), `dash pattern of unverified edges, got ${[...new Set(dashes())].join(' ')}`)
})

test('an edge with no verdict is not proven either: dashed', async () => {
  mount(edgeSim(undefined))
  await tick()
  assert.ok(dashes().includes('[7,6]'))
})

test('a verified edge is a solid beam: no unverified dash', async () => {
  mount(edgeSim(true))
  await tick()
  assert.ok(calls.some(c => c.name === 'fill'), 'the canvas drew')
  assert.ok(!dashes().includes('[7,6]'), 'no dashed line for a verified edge')
})

test('the delegation path of the selected agent is drawn; nothing is drawn without a selection', async () => {
  const pathDrawn = () => calls.some(c => c.name === 'set:shadowBlur' && c.args[0] === 8)
  const { unmount } = mount(edgeSim(true))
  await tick()
  assert.equal(pathDrawn(), false, 'no selection, no path')
  unmount()

  calls.length = 0
  mount(edgeSim(true), { selectedAgentId: 'child' })
  await tick()
  assert.ok(pathDrawn(), 'the path from the orchestrator to the selected agent is stroked')
})

test('session links between two session halos are drawn dashed in the All view', async () => {
  const sim = createEmptyState()
  sim.agents.set('s1:m', agent('s1:m', { sessionId: 's1', isMain: true, state: 'thinking', x: -600, y: 0 }))
  sim.agents.set('s2:m', agent('s2:m', { sessionId: 's2', isMain: true, state: 'thinking', x: 600, y: 0 }))
  sim.currentTime = 10
  sim.isPlaying = true
  const count = (kind: 'task' | 'worktree' | null) => {
    const wanted = kind === 'task' ? 0.4 : 1.6
    return calls.filter(c => c.name === 'setLineDash' && Array.isArray(c.args[0]) && (c.args[0] as number[]).length === 2
      && Math.round(((c.args[0] as number[])[0] / (c.args[0] as number[])[1]) * 10) / 10 === wanted).length
  }

  mount(sim, { sessionLinks: [] })
  await tick()
  const baseline = { task: count('task'), worktree: count('worktree') }
  cleanup()

  calls.length = 0
  mount(sim, { sessionLinks: [{ parentId: 's1', childId: 's2', kind: 'task' }] })
  await tick()
  assert.ok(count('task') > baseline.task, 'a task link is drawn with the dotted 2:5 pattern')
  cleanup()

  calls.length = 0
  mount(sim, { sessionLinks: [{ parentId: 's1', childId: 's2', kind: 'worktree' }] })
  await tick()
  assert.ok(count('worktree') > baseline.worktree, 'a worktree link is drawn with the dashed 8:5 pattern')
})
