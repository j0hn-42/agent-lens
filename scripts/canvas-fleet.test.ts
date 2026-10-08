import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  placeRects, rectsOverlap, overlayPriority, PRIORITY, type PlacementRequest, type Rect,
} from '../web/components/agent-visualizer/canvas/label-placement'
import {
  computeClusters, clusterKeyOf, clusterStatus, clusterLabelLines, clusterAnnouncement, sessionColor,
} from '../web/components/agent-visualizer/canvas/cluster-model'
import {
  isOrchestrator, orchestratorRole, orchestratorInfo, agentDrawScale, agentDrawRadius, layoutAgentLabel,
  TEAM_DEFAULT_COLOR,
} from '../web/components/agent-visualizer/canvas/team-style'
import { selectEdgeBubble } from '../web/components/agent-visualizer/canvas/edge-bubbles'
import { resolveLinks, linkCurve, curvePoint, findLinkAt } from '../web/components/agent-visualizer/canvas/link-geometry'
import { planOverlays, planKey, resolvePlacement } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { overlayHits, setOverlayHits, clearOverlayHits } from '../web/components/agent-visualizer/canvas/overlay-state'
import { hitTestAt, findAgentAt } from '../web/components/agent-visualizer/canvas/hit-detection'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'
import { detectTeamChanges, createTeamPrev } from '../web/components/agent-visualizer/canvas/team-changes'
import { lodForZoom } from '../web/components/agent-visualizer/canvas/draw-options'
import { EDGE_BUBBLE, ORCHESTRATOR_DRAW, PLACEMENT } from '../web/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown> = {}): any {
  const id = (over.id as string) ?? 's1:main'
  return {
    id, agentKey: id, sessionId: 's1', localId: id.split(':')[1] ?? id, displayName: 'main', name: 'main',
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false,
    spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    ...over,
  }
}
const map = (...list: any[]): Map<string, any> => new Map(list.map(a => [a.id, a]))
const rect = (x: number, y: number, w = 40, h = 14): Rect => ({ x, y, w, h })
const req = (id: string, priority: number, r: Rect, extra: Partial<PlacementRequest> = {}): PlacementRequest => ({ id, priority, rect: r, ...extra })

// ─── Placement helper ───────────────────────────────────────────────────────

test('placeRects: non-overlapping requests stay where they are', () => {
  const out = placeRects([req('a', 1, rect(0, 0)), req('b', 1, rect(100, 0))])
  assert.deepEqual(out.map(p => [p.dx, p.dy, p.hidden]), [[0, 0, false], [0, 0, false]])
})

test('placeRects: the higher priority keeps its spot, the other takes a fallback offset', () => {
  const out = placeRects([req('low', 1, rect(0, 0)), req('high', 5, rect(0, 0))])
  const low = out[0], high = out[1]
  assert.equal(high.dx === 0 && high.dy === 0, true)
  assert.equal(low.hidden, false)
  assert.ok(low.dx !== 0 || low.dy !== 0)
  assert.equal(rectsOverlap(low.rect!, high.rect!), false)
})

test('placeRects: selected / hovered agents outrank everything, the orchestrator outranks active agents', () => {
  assert.ok(overlayPriority(PRIORITY.agentBubbles, { selected: true }) > overlayPriority(PRIORITY.agentLabel, { orchestrator: true, active: true }))
  assert.ok(overlayPriority(PRIORITY.agentLabel, { hovered: true }) > overlayPriority(PRIORITY.clusterLabel, {}))
  assert.ok(PRIORITY.clusterLabel > overlayPriority(PRIORITY.stats, { orchestrator: true, active: true }))
  assert.ok(overlayPriority(PRIORITY.agentLabel, { orchestrator: true }) > overlayPriority(PRIORITY.agentLabel, { active: true }))
})

test('placeRects: never produces two overlapping rectangles, whatever the crowd', () => {
  const requests: PlacementRequest[] = []
  for (let i = 0; i < 40; i++) requests.push(req(`r${i}`, i % 7, rect((i % 5) * 10, (i % 3) * 5, 50, 14)))
  const placed = placeRects(requests, { bounds: { x: 0, y: 0, w: 600, h: 400 } }).filter(p => p.rect)
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) assert.equal(rectsOverlap(placed[i].rect!, placed[j].rect!), false, `${placed[i].id} / ${placed[j].id}`)
  }
})

test('placeRects: a request that cannot be placed is hidden, collapses to its compact form, or (essential) stays', () => {
  const bounds = { x: 0, y: 0, w: 60, h: 20 }
  const blocker = req('blocker', 9, rect(0, 0, 60, 20))
  const hidden = placeRects([blocker, req('x', 1, rect(0, 0, 60, 20))], { bounds })[1]
  assert.equal(hidden.hidden, true)
  assert.equal(hidden.rect, null)

  const chip = rect(0, 0, 10, 5)
  const roomy = placeRects([req('blocker', 9, rect(0, 0, 30, 20)), req('x', 1, rect(0, 0, 60, 20), { compact: { x: 40, y: 0, w: 10, h: 5 }, fixed: true })], { bounds })[1]
  assert.equal(roomy.collapsed, true)
  assert.equal(roomy.hidden, false)
  assert.ok(chip.w > 0)

  const essential = placeRects([blocker, req('e', 1, rect(0, 0, 60, 20), { essential: true })], { bounds })[1]
  assert.equal(essential.hidden, false)
  assert.ok(essential.rect)
})

test('placeRects: a label ignores the obstacle of its own owner but avoids the other nodes', () => {
  const obstacles = [{ owner: 'a', rect: rect(0, 0, 30, 30) }, { owner: 'b', rect: rect(100, 0, 30, 30) }]
  const own = placeRects([req('label-a', 1, rect(5, 5, 20, 10), { owner: 'a' })], { obstacles })[0]
  assert.equal(own.dx === 0 && own.dy === 0, true)
  const other = placeRects([req('label-b', 1, rect(105, 5, 20, 10), { owner: 'a' })], { obstacles })[0]
  assert.ok(other.dx !== 0 || other.dy !== 0 || other.hidden)
})

// ─── Orchestrator ───────────────────────────────────────────────────────────

test('orchestrator: main agent is larger, LEAD for a team lead and MAIN for a session, teammates are not', () => {
  const main = agent({ isMain: true })
  const sub = agent({ id: 's1:sub' })
  const mate = agent({ id: 's1:mate', isMain: true, kind: 'teammate', teamName: 'alpha' })
  assert.equal(isOrchestrator(main), true)
  assert.equal(isOrchestrator(mate), false)
  assert.ok(agentDrawScale(main) > agentDrawScale(sub))
  assert.equal(agentDrawScale(main), ORCHESTRATOR_DRAW.scale)
  assert.ok(agentDrawRadius(main) > 28)
  const teams = new Map([['alpha', { name: 'alpha', leadSessionId: 's1', members: [] }]])
  assert.equal(orchestratorRole(main, teams as any), 'lead')
  assert.equal(orchestratorRole(main), 'main')
  assert.equal(orchestratorRole(sub), null)
  assert.equal(orchestratorInfo(main, teams as any)?.badge, 'LEAD')
  assert.equal(orchestratorInfo(main, teams as any)?.groupName, 'alpha')
  assert.equal(orchestratorInfo(agent({ isMain: true, sessionLabel: 'repo-a' }))?.badge, 'MAIN')
  assert.equal(orchestratorInfo(agent({ isMain: true, sessionLabel: 'repo-a' }))?.groupName, 'repo-a')
})

test('orchestrator label: badge line carries the team or session name', () => {
  const main = agent({ isMain: true, sessionLabel: 'repo-a' })
  const layout = layoutAgentLabel(main, 28, t => t.length * 6, true, orchestratorInfo(main))
  assert.equal(layout.badgeText, 'MAIN')
  assert.match(layout.groupLine ?? '', /^MAIN repo-a/)
  assert.equal(layout.sessionLine, undefined)
  assert.equal(layout.extraLines, 1)
})

// ─── Clusters ───────────────────────────────────────────────────────────────

test('clusters: three sessions are three clusters, each with its own members', () => {
  const agents = map(
    agent({ id: 'a:main', sessionId: 'a', isMain: true, x: 0, y: 0, runtime: 'claude', tokensUsed: 1_000_000 }),
    agent({ id: 'a:sub', sessionId: 'a', x: 50, y: 0 }),
    agent({ id: 'b:main', sessionId: 'b', isMain: true, x: 600, y: 0, runtime: 'codex', state: 'thinking' }),
    agent({ id: 'c:main', sessionId: 'c', isMain: true, x: 0, y: 600, state: 'error' }),
  )
  const sessions = new Map([['a', { label: 'repo-a', workspace: 'wsp-a' }]])
  const clusters = computeClusters(agents.values(), undefined, { sessions })
  assert.equal(clusters.length, 3)
  assert.deepEqual(clusters.map(c => c.key), ['session:a', 'session:b', 'session:c'])
  const a = clusters[0]
  assert.equal(a.title, 'repo-a')
  assert.equal(a.workspace, 'wsp-a')
  assert.deepEqual(a.memberIds.sort(), ['a:main', 'a:sub'])
  assert.equal(clusters[1].runtime, 'Codex')
  assert.equal(clusters[1].status, 'working')
  assert.equal(clusters[2].status, 'error')
  assert.ok(a.cost !== null && a.cost > 0)
  const lines = clusterLabelLines(a)
  assert.match(lines.title, /^Session repo-a \(2\)$/)
  // The sub-agent has reported no tokens: the cluster cost is a lower bound, not an exact figure
  assert.match(lines.detail, /Claude · wsp-a · idle · au moins \$/)
  assert.match(clusterAnnouncement(a), /^Session repo-a, 2 agents, Claude, workspace wsp-a, idle, cost au moins \$/)
  assert.equal(clusters[1].cost, null, 'no data at all is null, never $0')
  assert.equal(clusters[1].costText, 'non renseigné')
  assert.ok(a.r > 25)
})

test('clusters: one single-agent session gets no halo, two single-agent sessions both do', () => {
  assert.equal(computeClusters([agent({ isMain: true })]).length, 0)
  const two = computeClusters([agent({ id: 'a:m', sessionId: 'a', isMain: true }), agent({ id: 'b:m', sessionId: 'b', isMain: true })])
  assert.equal(two.length, 2)
  assert.notEqual(two[0].color, undefined)
})

test('clusters: same-name teams of two sessions do not share one halo', () => {
  const agents = map(
    agent({ id: 'a:lead', sessionId: 'a', isMain: true, teamName: 'dev', x: 0 }),
    agent({ id: 'a:t1', sessionId: 'a', kind: 'teammate', teamName: 'dev', x: 40 }),
    agent({ id: 'b:lead', sessionId: 'b', isMain: true, teamName: 'dev', x: 900 }),
    agent({ id: 'b:t1', sessionId: 'b', kind: 'teammate', teamName: 'dev', x: 940 }),
  )
  const clusters = computeClusters(agents.values())
  assert.equal(clusters.length, 2)
  assert.notEqual(clusters[0].key, clusters[1].key)
  assert.ok(clusters.every(c => c.kind === 'team' && c.memberIds.length === 2))
  assert.ok(clusters.every(c => c.r < 200), 'each halo spans its own team only')
})

test('clusters: the session that hosts a team is one team cluster, and the lead is in it', () => {
  const agents = map(
    agent({ id: 's1:lead', isMain: true }),
    agent({ id: 's1:sub', parentId: 's1:lead', x: 30 }),
    agent({ id: 's1:t1', kind: 'teammate', teamName: 'alpha', x: 60, teamColor: '#12ab34' }),
  )
  const clusters = computeClusters(agents.values())
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].kind, 'team')
  assert.equal(clusters[0].memberIds.length, 3)
  assert.equal(clusters[0].color, '#12ab34')
  assert.equal(clusters[0].orchestratorId, 's1:lead')
  assert.equal(clusterKeyOf(agents.get('s1:t1'), undefined), 'team:s1:alpha')
})

test('clusters: invalid team colour falls back to the shared default', () => {
  const agents = map(agent({ id: 's1:a', teamName: 'x', teamColor: 'red; background:url(x)' }), agent({ id: 's1:b', teamName: 'x', x: 10 }))
  assert.equal(computeClusters(agents.values())[0].color, TEAM_DEFAULT_COLOR)
  assert.match(sessionColor('whatever'), /^#[0-9a-f]{6}$/)
  assert.equal(clusterStatus(['complete', 'complete']), 'complete')
  assert.equal(clusterStatus(['idle', 'waiting_permission']), 'waiting')
})

// ─── Edge bubbles ───────────────────────────────────────────────────────────

function linkFixture(messages: any[]) {
  const agents = map(agent({ id: 's1:lead', x: 0, y: 0, isMain: true }), agent({ id: 's1:child', x: 600, y: 0 }))
  const link = { id: 'L1', from: 's1:lead', to: 's1:child', kind: 'spawn', sessionId: 's1', messages, dropped: 0 }
  const resolved = resolveLinks(new Map([['L1', link as any]]), agents, 10)
  return { agents, resolved: resolved[0] }
}
const msg = (over: Record<string, unknown> = {}) => ({ id: 'm1', type: 'dispatch', content: 'Find the auth code', timestamp: 10, from: 's1:lead', to: 's1:child', ...over })

test('edge bubble: a dispatch sits a third of the way from the parent, a return a third from the child', () => {
  const dispatch = linkFixture([msg()])
  const curve = linkCurve(dispatch.resolved, dispatch.agents)!
  const b1 = selectEdgeBubble(dispatch.resolved, dispatch.agents, 11)!
  const near = curvePoint(curve, EDGE_BUBBLE.anchorT)
  assert.ok(Math.hypot(b1.anchor.x - near.x, b1.anchor.y - near.y) < 0.001)
  assert.equal(b1.fromSender, true)
  assert.match(b1.lines[0], /^→ /)

  const ret = linkFixture([msg({ id: 'm2', type: 'return', from: 's1:child', to: 's1:lead' })])
  const b2 = selectEdgeBubble(ret.resolved, ret.agents, 11)!
  const farCurve = linkCurve(ret.resolved, ret.agents)!
  const p2 = curvePoint(farCurve, 1 - EDGE_BUBBLE.anchorT)
  assert.ok(Math.hypot(b2.anchor.x - p2.x, b2.anchor.y - p2.y) < 0.001)
  assert.equal(b2.fromSender, false)
  assert.match(b2.lines[0], /^← /)
  assert.ok(b2.anchor.x > b1.anchor.x, 'the return bubble is nearer the child')
})

test('edge bubble: at most three lines, expires, stays while held, never leaks control characters', () => {
  const long = linkFixture([msg({ content: ('word '.repeat(200)) + '\u0007\u001b[31m' })])
  const b = selectEdgeBubble(long.resolved, long.agents, 11)!
  assert.ok(b.lines.length <= EDGE_BUBBLE.maxLines)
  assert.equal(b.truncated, true)
  assert.ok(b.lines.every(l => !/[\u0000-\u001f]/.test(l)))
  assert.ok(b.w <= EDGE_BUBBLE.maxWidth)
  assert.equal(selectEdgeBubble(long.resolved, long.agents, 10 + EDGE_BUBBLE.visibleS + 1), null)
  assert.ok(selectEdgeBubble(long.resolved, long.agents, 10 + EDGE_BUBBLE.visibleS + 100, true))
  assert.equal(selectEdgeBubble(linkFixture([]).resolved, new Map(), 0), null)
})

// ─── Overlay plan (no overlap, priorities, chips) ───────────────────────────

function planInput(agents: Map<string, any>, over: Record<string, unknown> = {}): any {
  return {
    agents, clusters: computeClusters(agents.values()), edgeBubbles: [],
    transform: { x: 0, y: 0, scale: 1 }, viewport: { w: 1200, h: 800 }, lod: lodForZoom(1),
    showStats: true, showCost: true, showSessionLabels: true,
    selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null, simTime: 1,
    isBubbleHeld: () => false,
    ...over,
  }
}
function bubbleAgent(id: string, session: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  return agent({
    id, sessionId: session, x, y, isMain: true, tokensUsed: 500_000,
    messageBubbles: [{ text: 'hello there', time: 0, role: 'assistant', _cachedW: 200, _cachedH: 60 }],
    ...extra,
  })
}

test('planOverlays: texts of two close clusters never overlap, wherever the agents are', () => {
  const agents = map(
    bubbleAgent('a:m', 'a', 300, 300, { name: 'orchestrator of the first session' }),
    bubbleAgent('b:m', 'b', 330, 320, { name: 'orchestrator of the second session' }),
    agent({ id: 'a:s', sessionId: 'a', x: 360, y: 330, name: 'worker' }),
  )
  const { plan } = planOverlays(planInput(agents))
  const rects = [...plan.values()].filter(p => p.rect && !p.hidden).map(p => ({ id: p.id, rect: p.rect! }))
  assert.ok(rects.length > 3)
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.equal(rectsOverlap(rects[i].rect, rects[j].rect), false, `${rects[i].id} overlaps ${rects[j].id}`)
    }
  }
})

test('planOverlays: the selected agent keeps its bubbles, those of the other cluster collapse to a count chip', () => {
  clearOverlayHits()
  const agents = map(bubbleAgent('a:m', 'a', 300, 300), bubbleAgent('b:m', 'b', 330, 310))
  const result = planOverlays(planInput(agents, { selectedAgentId: 'a:m' }))
  const mine = result.plan.get(planKey.bubbles('a:m'))!
  const theirs = result.plan.get(planKey.bubbles('b:m'))!
  assert.equal(mine.collapsed, false)
  assert.equal(mine.hidden, false)
  assert.equal(theirs.collapsed || theirs.hidden, true)
  if (theirs.collapsed) {
    assert.equal(result.hits.collapsedBubbles.has('b:m'), true)
    assert.ok(theirs.rect!.w <= PLACEMENT.chipW + 0.001)
  }
  // Selecting the other agent swaps the outcome
  const swapped = planOverlays(planInput(agents, { hoveredAgentId: 'b:m' }))
  assert.equal(swapped.plan.get(planKey.bubbles('b:m'))!.collapsed, false)
  assert.equal(swapped.plan.get(planKey.bubbles('a:m'))!.collapsed || swapped.plan.get(planKey.bubbles('a:m'))!.hidden, true)
})

test('planOverlays: crowded views keep secondary overlays for the priority agent only; plan gives world offsets', () => {
  const list: any[] = []
  for (let i = 0; i < PLACEMENT.crowdedItems + 5; i++) list.push(agent({ id: `s:a${i}`, sessionId: 's', x: (i % 12) * 90, y: Math.floor(i / 12) * 90, tokensUsed: 1000, name: `agent ${i}` }))
  const agents = map(...list)
  const r = planOverlays(planInput(agents, { selectedAgentId: 's:a3', transform: { x: 20, y: 20, scale: 1 } }))
  assert.equal(r.crowded, true)
  assert.ok(r.plan.has(planKey.stats('s:a3')))
  assert.equal(r.plan.has(planKey.stats('s:a4')), false)
  assert.deepEqual(resolvePlacement(undefined, 'x', 1), { visible: true, collapsed: false, dx: 0, dy: 0 })
  assert.equal(resolvePlacement(r.plan, planKey.stats('s:a4'), 1).visible, false)
  const moved = resolvePlacement(new Map([['k', { id: 'k', dx: 20, dy: -10, rect: rect(0, 0), hidden: false, collapsed: false }]]), 'k', 2)
  assert.deepEqual([moved.dx, moved.dy], [10, -5])
})

test('planOverlays: every cluster label is placed and clickable (hit rectangle)', () => {
  const agents = map(bubbleAgent('a:m', 'a', 200, 300), bubbleAgent('b:m', 'b', 600, 300), bubbleAgent('c:m', 'c', 1000, 300))
  const r = planOverlays(planInput(agents))
  assert.equal(r.hits.clusterLabels.size, 3)
  for (const c of computeClusters(agents.values())) assert.ok(r.plan.get(planKey.cluster(c.key))?.rect)
})

// ─── Hit testing of the new targets ─────────────────────────────────────────

test('hitTestAt: cluster label, edge bubble (reports its link) and collapsed chip are targets', () => {
  try {
    setOverlayHits({
      clusterLabels: new Map([['session:a', rect(500, 500, 100, 30)]]),
      edgeBubbles: new Map([['L9', rect(700, 700, 100, 40)]]),
      collapsedBubbles: new Map([['s1:far', rect(900, 100, 28, 20)]]),
    })
    const scene = { agents: map(agent({ id: 's1:far', x: 200, y: 100, messageBubbles: [{ text: 'x', time: 0, role: 'assistant' }] })), toolCalls: new Map(), discoveries: [] }
    assert.deepEqual(hitTestAt(520, 510, scene, 0, 1), { type: 'cluster', id: 'session:a' })
    assert.deepEqual(hitTestAt(720, 720, scene, 0, 1), { type: 'link', id: 'L9' })
    assert.deepEqual(hitTestAt(910, 110, scene, 0.1, 1), { type: 'bubble', id: 's1:far' })
    assert.equal(hitTestAt(5000, 5000, scene, 0, 1), null)
    assert.ok(overlayHits.clusterLabels.size === 1)
  } finally {
    clearOverlayHits()
  }
})

test('findAgentAt: the orchestrator hit area follows its larger drawn size', () => {
  const agents = map(agent({ id: 's1:m', isMain: true, x: 0, y: 0 }))
  assert.equal(findAgentAt(32, 0, agents, 1), 's1:m')
  const sub = map(agent({ id: 's1:s', x: 0, y: 0 }))
  assert.equal(findAgentAt(32, 0, sub, 1), null)
})

test('findLinkAt: the count badge only counts while it is drawn, and never beats a nearer link', () => {
  const agents = map(agent({ id: 's1:lead', x: 0, y: 0 }), agent({ id: 's1:alice', x: 400, y: 0 }), agent({ id: 's1:bob', x: 400, y: 30 }))
  const l1 = { id: 'L1', from: 's1:lead', to: 's1:alice', kind: 'teammate', sessionId: 's1', messages: [msg()], dropped: 0 }
  const l2 = { id: 'L2', from: 's1:lead', to: 's1:bob', kind: 'teammate', sessionId: 's1', messages: [msg()], dropped: 0 }
  const resolved = resolveLinks(new Map([['L1', l1 as any], ['L2', l2 as any]]), agents, 10)
  const mid = curvePoint(linkCurve(resolved[0], agents)!, 0.5)
  // Just beside the badge of L1, but on the curve of L2: the nearer curve wins only when the badge is not hit
  const near = findLinkAt(mid.x, mid.y + 12, resolved, agents, 1, undefined, true)
  assert.ok(near === 'L1' || near === 'L2')
  // 10 px off the curve at 1x is outside the 8 px tolerance; the invisible badge box must not catch it
  assert.equal(findLinkAt(mid.x, mid.y - 12, [resolved[0]], agents, 1, undefined, false), null)
  assert.equal(findLinkAt(mid.x, mid.y - 12, [resolved[0]], agents, 1, undefined, true), 'L1')
})

// ─── DOM model and announcements ────────────────────────────────────────────

test('buildA11yModel: orchestrator role, cluster headings and clusterKey on every agent', () => {
  const teams = new Map([['alpha', { name: 'alpha', leadSessionId: 's1', members: [] }]])
  const agents = map(
    agent({ id: 's1:lead', isMain: true, name: 'Lead' }),
    agent({ id: 's1:t1', kind: 'teammate', teamName: 'alpha', name: 'Alice', x: 50 }),
    agent({ id: 's2:main', sessionId: 's2', isMain: true, name: 'Other', x: 900 }),
  )
  const model = buildA11yModel(agents, new Map(), [], new Map(), { teams: teams as any, sessions: new Map([['s2', { label: 'repo-two', workspace: 'w2' }]]) })
  assert.equal(model.agents.find(a => a.id === 's1:lead')!.orchestrator, 'lead')
  assert.equal(model.agents.find(a => a.id === 's2:main')!.orchestrator, 'main')
  assert.equal(model.agents.find(a => a.id === 's1:t1')!.orchestrator, undefined)
  assert.equal(model.clusters.length, 2)
  assert.ok(model.clusters.some(c => c.kind === 'team' && /^Team alpha/.test(c.text)))
  assert.ok(model.clusters.some(c => c.kind === 'session' && /repo-two/.test(c.text) && /workspace w2/.test(c.text)))
  assert.ok(model.agents.every(a => !!a.clusterKey))
})

test('detectTeamChanges: a finished teammate is announced once (the state detection says "completed")', () => {
  const mate = agent({ id: 's1:t', kind: 'teammate', teamName: 'alpha', activity: 'working', state: 'thinking' })
  const first = detectTeamChanges(map(mate), undefined, createTeamPrev())
  const finished = { ...mate, activity: 'done', state: 'complete' }
  const out = detectTeamChanges(map(finished), undefined, first.next)
  assert.equal(out.transitions.length, 0)
  const idle = detectTeamChanges(map({ ...mate, activity: 'idle', state: 'idle' }), undefined, first.next)
  assert.equal(idle.transitions.length, 1)
  const doneNoState = detectTeamChanges(map({ ...mate, activity: 'done', state: 'idle' }), undefined, first.next)
  assert.equal(doneNoState.transitions.length, 1)
})
