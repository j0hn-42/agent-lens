// Tool cards are drawn above the agent labels and bubbles: the overlay plan keeps those texts off the
// cards instead of leaving them underneath, unreadable (#378).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { planOverlays, planKey, toolCardRects } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { rectsOverlap, type Rect } from '../web/components/agent-visualizer/canvas/label-placement'
import { lodForZoom } from '../web/components/agent-visualizer/canvas/draw-options'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 300, y: 300, vx: 0, vy: 0, pinned: false, isMain: true,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
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
/** A card centred on the centre of `r` (scale 1, no pan: screen = world) */
const cardOn = (r: Rect): Rect => ({ x: r.x + r.w / 2 - 60, y: r.y + r.h / 2 - 14, w: 120, h: 28 })

test('planOverlays: an agent label is never left under a tool card (#378)', () => {
  const agents = map(agent())
  const free = planOverlays(input(agents)).plan.get(planKey.label('s1:main'))!
  assert.ok(free.rect, 'precondition: the label is placed')
  const card = cardOn(free.rect)
  const p = planOverlays(input(agents, { toolCards: [card] })).plan.get(planKey.label('s1:main'))!
  assert.ok(p.hidden || !rectsOverlap(p.rect!, card), `label ${JSON.stringify(p.rect)} under card ${JSON.stringify(card)}`)
})

test('planOverlays: message bubbles are not left under a tool card, even for the selected agent (#378)', () => {
  const a = agent({ messageBubbles: [{ text: 'hello there', time: 0, role: 'assistant', _cachedW: 200, _cachedH: 60 }] })
  const agents = map(a)
  for (const selectedAgentId of [null, 's1:main']) {
    const free = planOverlays(input(agents, { selectedAgentId })).plan.get(planKey.bubbles('s1:main'))!
    assert.ok(free.rect && !free.hidden && !free.collapsed, 'precondition: the bubbles are drawn in full')
    const card = cardOn(free.rect)
    const p = planOverlays(input(agents, { selectedAgentId, toolCards: [card] })).plan.get(planKey.bubbles('s1:main'))!
    assert.ok(p.hidden || !rectsOverlap(p.rect!, card), `bubbles ${JSON.stringify(p.rect)} under card (selected: ${selectedAgentId})`)
  }
})

test('planOverlays: a label with a free fallback moves aside or shortens instead of being hidden (#378)', () => {
  const agents = map(agent())
  const free = planOverlays(input(agents)).plan.get(planKey.label('s1:main'))!
  const card = cardOn(free.rect!)
  const p = planOverlays(input(agents, { toolCards: [card] })).plan.get(planKey.label('s1:main'))!
  assert.equal(p.hidden, false)
  assert.ok(p.dy !== 0 || p.collapsed, JSON.stringify(p))
  assert.equal(rectsOverlap(p.rect!, card), false)
})

test('planOverlays: bubbles under a card fold into their count chip when the chip spot is free, selected agent included (#378)', () => {
  const agents = map(agent({ messageBubbles: [{ text: 'hello there', time: 0, role: 'assistant', _cachedW: 200, _cachedH: 60 }] }))
  for (const selectedAgentId of [null, 's1:main']) {
    const free = planOverlays(input(agents, { selectedAgentId })).plan.get(planKey.bubbles('s1:main'))!
    // Card over the right part of the stack: the chip, at the stack's top-left corner, stays clear
    const card = { x: free.rect!.x + 60, y: free.rect!.y, w: 120, h: 28 }
    const p = planOverlays(input(agents, { selectedAgentId, toolCards: [card] })).plan.get(planKey.bubbles('s1:main'))!
    assert.equal(p.hidden, false, `selected: ${selectedAgentId}`)
    assert.equal(p.collapsed, true, `selected: ${selectedAgentId}`)
    assert.equal(rectsOverlap(p.rect!, card), false)
  }
})

test('planOverlays: a halo label, drawn above the cards, is not moved by a card under it (#378)', () => {
  const agents = map(agent({ id: 's1:main' }), agent({ id: 's1:sub', isMain: false, parentId: 's1:main', parentKey: 's1:main', x: 380, y: 320 }))
  const before = planOverlays(input(agents))
  const key = [...before.plan.keys()].find(k => k.startsWith('cluster:'))
  assert.ok(key, 'precondition: a halo label is planned')
  const free = before.plan.get(key)!
  const card = cardOn(free.rect!)
  const after = planOverlays(input(agents, { toolCards: [card] }))
  const p = after.plan.get(key)!
  assert.equal(p.dx, free.dx)
  assert.equal(p.dy, free.dy)
  assert.deepEqual(p.rect, free.rect)
  const clusterKey = key.slice('cluster:'.length)
  assert.deepEqual(after.hits.clusterLabels.get(clusterKey), before.hits.clusterLabels.get(clusterKey), 'the click area stays put')
})

test('planOverlays: without tool cards the plan is unchanged (#378)', () => {
  const agents = map(agent({ messageBubbles: [{ text: 'hi', time: 0, role: 'assistant', _cachedW: 200, _cachedH: 60 }] }))
  const a = planOverlays(input(agents)).plan
  const b = planOverlays(input(agents, { toolCards: [] })).plan
  assert.deepEqual([...a.entries()], [...b.entries()])
})

test('toolCardRects: card rectangles centred on the cards, faded cards skipped (#378)', () => {
  const tools = [
    { id: 't1', x: 100, y: 50, opacity: 1 },
    { id: 't2', x: 400, y: 50, opacity: 1 },
    { id: 't3', x: 700, y: 50, opacity: 0 },
  ]
  const rects = toolCardRects(tools, t => (t.id === 't1' ? { w: 80, h: 28 } : { w: 120, h: 40 }))
  assert.deepEqual(rects, [{ x: 60, y: 36, w: 80, h: 28 }, { x: 340, y: 30, w: 120, h: 40 }])
})
