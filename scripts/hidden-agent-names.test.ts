// #594: the number of agent names the overlay plan hides. The canvas shows "N names hidden" next to its controls only
// when the plan hid at least one name, so the number must be a fact of the frame drawn: agents whose node is drawn in
// the canvas area (not under the bars, not off screen) and whose name is not drawn. The proof against the real drawing
// (the names drawAgents paints with that plan) is in canvas-label-collisions.test.ts.
import './canvas-recorder'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { lodForZoom } from '../web/components/agent-visualizer/canvas/draw-options'
import { planOverlays, planKey, EMPTY_PLAN } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id,
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 1_000_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 400, y: 300, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], lastEventAt: Date.now(),
    ...over,
  }
}
const map = (...list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))
function input(agents: Map<string, any>, over: Record<string, unknown> = {}): any {
  return {
    agents, clusters: computeClusters(agents.values()), edgeBubbles: [],
    transform: { x: 0, y: 0, scale: 1 }, viewport: { w: 1200, h: 800 }, lod: lodForZoom(1),
    showStats: false, showCost: false, showSessionLabels: false,
    selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 1,
    isBubbleHeld: () => false,
    ...over,
  }
}

test('nothing hidden: one agent alone keeps its name, the count is 0', () => {
  const result = planOverlays(input(map(agent())))
  assert.equal(result.plan.get(planKey.label('s1:main'))?.hidden, false, 'precondition: the label is placed')
  assert.equal(result.hiddenAgentNames, 0)
})

test('the empty plan (no viewport) hides nothing', () => {
  assert.equal(EMPTY_PLAN.hiddenAgentNames, 0)
  assert.equal(planOverlays(input(map(agent()), { viewport: { w: 0, h: 0 } })).hiddenAgentNames, 0)
})

test('agents stacked on one spot: the count equals the labels the plan hides, a one-line label is not counted', () => {
  const agents = map(...Array.from({ length: 6 }, (_, i) => agent({ id: `s1:a${i}`, x: 400 + i * 4, y: 300 })))
  const result = planOverlays(input(agents))
  const labels = [...agents.keys()].map(id => result.plan.get(planKey.label(id))!)
  const hidden = labels.filter(p => p.hidden).length
  assert.ok(hidden >= 1, `precondition: the plan hides labels (${hidden})`)
  assert.equal(result.hiddenAgentNames, hidden)
})

test('under the label zoom no name is drawn: every agent drawn in the canvas area counts', () => {
  const lod = lodForZoom(0.2)
  assert.equal(lod.labels, false, 'precondition: no agent label at 20 %')
  const agents = map(agent({ id: 's1:a' }), agent({ id: 's1:b', x: 600 }), agent({ id: 's1:c', x: 1000 }))
  assert.equal(planOverlays(input(agents, { lod, transform: { x: 0, y: 0, scale: 0.2 } })).hiddenAgentNames, 3)
})

test('an agent off screen or under the bars (outside the safe area) is not counted', () => {
  const lod = lodForZoom(0.2)
  const agents = map(
    agent({ id: 's1:in', x: 2000, y: 2000 }), // at 20 %: (400, 400), in the safe area
    agent({ id: 's1:under-topbar', x: 2000, y: 150 }), // (400, 30): drawn under the top bar
    agent({ id: 's1:edge', x: 6200, y: 2000 }), // (1240, 400): right of the window, within the planner's margin
  )
  const result = planOverlays(input(agents, {
    lod, transform: { x: 0, y: 0, scale: 0.2 }, safeArea: { x: 0, y: 80, w: 1200, h: 620 },
  }))
  assert.equal(result.hiddenAgentNames, 1)
})

test('a hidden (faded out) agent is not counted', () => {
  const lod = lodForZoom(0.2)
  const agents = map(agent({ id: 's1:a' }), agent({ id: 's1:gone', x: 700, opacity: 0 }))
  assert.equal(planOverlays(input(agents, { lod, transform: { x: 0, y: 0, scale: 0.2 } })).hiddenAgentNames, 1)
})
