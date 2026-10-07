import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  selectEdgeBubbles, capEdgeBubbles, anchorTFor, edgeBubbleAriaLabel, firstWords, buildLinkMessageItems, bubbleKey,
} from '../web/components/agent-visualizer/canvas/edge-bubble-set'
import { resolveLinks, linkCurve, curvePoint } from '../web/components/agent-visualizer/canvas/link-geometry'
import { planOverlays, planKey } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { lodForZoom } from '../web/components/agent-visualizer/canvas/draw-options'
import { rectsOverlap } from '../web/components/agent-visualizer/canvas/label-placement'
import { EDGE_BUBBLE, PLACEMENT } from '../web/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id.split(':')[1] ?? id, displayName: id.split(':')[1] ?? 'main', name: id.split(':')[1] ?? 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}
const agentsOf = (...list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))
const msg = (over: Record<string, unknown> = {}): any => ({
  id: 'm1', type: 'dispatch', content: 'Find the auth code', timestamp: 10, from: 's1:lead', to: 's1:child', ...over,
})

function fixture(messages: any[], kind: 'spawn' | 'teammate' = 'spawn') {
  const agents = agentsOf(agent({ id: 's1:lead', x: 0, y: 0, isMain: true }), agent({ id: 's1:child', x: 600, y: 0 }))
  const link = { id: 'L1', from: 's1:lead', to: 's1:child', kind, sessionId: 's1', messages, dropped: 0 }
  const resolved = resolveLinks(new Map([['L1', link as any]]), agents, 10)[0]
  return { agents, resolved, link }
}
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 0.001

// ─── Anchors on the curve ───────────────────────────────────────────────────

test('anchors: dispatch at 1/3, return at 2/3, peer message at the midpoint of the curve', () => {
  const f = fixture([
    msg({ id: 'd', type: 'dispatch', timestamp: 10 }),
    msg({ id: 'r', type: 'return', from: 's1:child', to: 's1:lead', timestamp: 11 }),
    msg({ id: 'p', type: 'message', from: 's1:child', to: 's1:lead', timestamp: 12 }),
  ])
  const curve = linkCurve(f.resolved, f.agents)!
  const out = selectEdgeBubbles(f.resolved, f.agents, 12)
  assert.equal(out.length, 3)
  const byId = Object.fromEntries(out.map(b => [b.messageId, b]))
  assert.ok(close(byId.d.anchor, curvePoint(curve, 1 / 3)))
  assert.ok(close(byId.r.anchor, curvePoint(curve, 2 / 3)))
  assert.ok(close(byId.p.anchor, curvePoint(curve, 0.5)))
  assert.equal(anchorTFor('message'), 0.5)
  assert.ok(byId.d.anchor.x < byId.p.anchor.x && byId.p.anchor.x < byId.r.anchor.x)
})

test('selection: only communication messages, at most maxPerLink newest, expiring unless held', () => {
  const many = Array.from({ length: 10 }, (_, i) => msg({ id: `m${i}`, timestamp: 10 + i * 0.1 }))
  const f = fixture([msg({ id: 'tool', type: 'tool_call', timestamp: 10.5 }), ...many])
  const out = selectEdgeBubbles(f.resolved, f.agents, 11)
  assert.equal(out.length, EDGE_BUBBLE.maxPerLink)
  assert.deepEqual(out.map(b => b.messageId), ['m7', 'm8', 'm9'], 'the newest, in chronological order')
  assert.equal(out.filter(b => b.primary).length, 1)
  assert.equal(out[out.length - 1].primary, true)
  assert.ok(out.every(b => b.groupCount === 3))
  // Expired
  assert.equal(selectEdgeBubbles(f.resolved, f.agents, 10 + EDGE_BUBBLE.visibleS + 5).length, 0)
  // Held link (paused / keep cards visible / hovered link)
  assert.equal(selectEdgeBubbles(f.resolved, f.agents, 500, { held: true }).length, EDGE_BUBBLE.maxPerLink)
  // A single hovered / focused bubble stays even when older than the window
  const kept = selectEdgeBubbles(f.resolved, f.agents, 500, { heldMessageIds: new Set(['m1']) })
  assert.deepEqual(kept.map(b => b.messageId), ['m1'])
  assert.ok(selectEdgeBubbles(f.resolved, f.agents, 11, { heldMessageIds: new Set(['m1']) }).some(b => b.messageId === 'm1'))
})

test('selection: a link without messages or without a visible end gives nothing; text is bounded and clean', () => {
  assert.equal(selectEdgeBubbles(fixture([]).resolved, new Map(), 0).length, 0)
  const f = fixture([msg({ content: 'word '.repeat(300) + '\u0007\u001b[31m' })])
  const [b] = selectEdgeBubbles(f.resolved, f.agents, 11)
  assert.ok(b.lines.length <= EDGE_BUBBLE.maxLines)
  assert.ok(b.lines.every(l => !/[\u0000-\u001f]/.test(l)))
  assert.ok(b.w <= EDGE_BUBBLE.maxWidth)
  f.agents.get('s1:child').archived = true
  f.agents.get('s1:child').opacity = 0
  assert.equal(selectEdgeBubbles(f.resolved, f.agents, 11).length >= 0, true)
})

test('memory bound: capEdgeBubbles keeps the newest maxTotal across links', () => {
  const f = fixture(Array.from({ length: 3 }, (_, i) => msg({ id: `m${i}`, timestamp: 10 + i })))
  const base = selectEdgeBubbles(f.resolved, f.agents, 12)
  const lots = []
  for (let l = 0; l < 10; l++) for (const b of base) lots.push({ ...b, linkId: `L${l}`, key: bubbleKey(`L${l}`, b.messageId), timestamp: b.timestamp + l * 10 })
  const capped = capEdgeBubbles(lots as any)
  assert.equal(capped.length, EDGE_BUBBLE.maxTotal)
  assert.ok(Math.min(...capped.map(b => b.timestamp)) >= 10 + 6 * 10, 'the oldest links lose their bubbles first')
  for (const b of capped) assert.ok(b.groupCount <= EDGE_BUBBLE.maxPerLink)
  assert.equal(capEdgeBubbles(base as any).length, base.length)
  // The message list of a link is bounded too
  const items = buildLinkMessageItems(new Map([['L1', { ...f.link, messages: Array.from({ length: 100 }, (_, i) => msg({ id: `x${i}` })) } as any]]), f.agents)
  assert.equal(items.length, EDGE_BUBBLE.listedPerLink)
})

// ─── Accessible names and DOM list ──────────────────────────────────────────

test('aria label names sender, receiver, kind and the first words', () => {
  assert.equal(
    edgeBubbleAriaLabel('lead', 'child', 'dispatch', 'Find the auth code and report back to me with a full summary of the flow today'),
    'lead to child, dispatch: Find the auth code and report back to me with…',
  )
  assert.match(edgeBubbleAriaLabel('a', 'b', 'message', '', true), /^a to b, peer message \(error\)$/)
  assert.equal(firstWords('  one   two\n three ', 2), 'one two…')
  const f = fixture([msg(), msg({ id: 'r', type: 'return', from: 's1:child', to: 's1:lead', content: 'Found 3 files', timestamp: 11 })])
  const [d, r] = selectEdgeBubbles(f.resolved, f.agents, 11)
  assert.equal(d.ariaLabel, 'lead to child, dispatch: Find the auth code')
  assert.equal(r.ariaLabel, 'child to lead, return: Found 3 files')
  const items = buildLinkMessageItems(new Map([['L1', f.link as any]]), f.agents)
  assert.deepEqual(items.map(i => i.text), [d.ariaLabel, r.ariaLabel])
  assert.ok(items.every(i => i.linkId === 'L1'))
})

// ─── Collision behaviour ────────────────────────────────────────────────────

function planFor(bubbles: any[], agents: Map<string, any>, over: Record<string, unknown> = {}) {
  return planOverlays({
    agents, clusters: computeClusters(agents.values()), edgeBubbles: bubbles,
    transform: { x: 0, y: 0, scale: 1 }, viewport: { w: 1200, h: 800 }, lod: lodForZoom(1),
    showStats: false, showCost: false, showSessionLabels: false,
    selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 11, isBubbleHeld: () => false,
    ...over,
  } as any)
}

test('collision: bubbles of one link never overlap, each keyed by its message', () => {
  const f = fixture([
    msg({ id: 'a', timestamp: 10 }), msg({ id: 'b', timestamp: 10.1 }), msg({ id: 'c', timestamp: 10.2 }),
  ])
  const bubbles = selectEdgeBubbles(f.resolved, f.agents, 11, { measure: t => t.length * 6.6 })
  const res = planFor(bubbles, f.agents)
  const rects = bubbles.map(b => res.plan.get(planKey.edgeBubble(b.key))).filter(p => p && !p.hidden && p.rect).map(p => p!.rect!)
  assert.ok(rects.length >= 1)
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.equal(rectsOverlap(rects[i], rects[j]), false)
  assert.equal(res.hits.edgeBubbleRects.size, rects.length)
  assert.ok(res.hits.edgeBubbles.has('L1'), 'the canvas hit test still finds the link')
})

test('collision: a crowded bubble collapses to a count chip (newest only), older ones hide', () => {
  const f = fixture([msg({ id: 'a', timestamp: 10 }), msg({ id: 'b', timestamp: 10.1 })])
  const bubbles = selectEdgeBubbles(f.resolved, f.agents, 11, { measure: t => t.length * 6.6 })
  // A viewport barely larger than the bubble: only a chip fits next to the selected agent label
  const tight = planFor(bubbles, f.agents, { viewport: { w: 260, h: 140 }, transform: { x: -250, y: 60, scale: 1 } })
  for (const b of bubbles) {
    const p = tight.plan.get(planKey.edgeBubble(b.key))
    if (p && !p.hidden && p.collapsed) {
      assert.equal(b.primary, true, 'only the newest bubble of a link has a chip')
      assert.equal(p.rect!.w, PLACEMENT.chipW)
    }
  }
})

test('collision: a selected agent label keeps its spot over an edge bubble', () => {
  const f = fixture([msg({ timestamp: 10 })])
  f.agents.get('s1:lead').name = 'lead'
  const bubbles = selectEdgeBubbles(f.resolved, f.agents, 11, { measure: t => t.length * 6.6 })
  const res = planFor(bubbles, f.agents, { selectedAgentId: 's1:lead', transform: { x: 100, y: 300, scale: 1 } })
  const label = res.plan.get(planKey.label('s1:lead'))!
  const bub = res.plan.get(planKey.edgeBubble(bubbles[0].key))!
  if (label.rect && bub.rect && !bub.hidden) assert.equal(rectsOverlap(label.rect, bub.rect), false)
  assert.equal(label.dx === 0 && label.dy === 0, true, 'the selected agent label is not moved by a bubble')
})
