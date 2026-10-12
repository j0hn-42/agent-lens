// #245: with `maskText` the canvas draws no free text (tool arguments and results, message bubbles, discovery cards,
// agent names, session and team labels, link bubbles, particle labels). Numbers, states and tool names stay.
// A recording context captures every string handed to fillText. Synthetic data only.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { drawMessageBubblesWorld } from '@/components/agent-visualizer/canvas/draw-bubbles'
import { drawToolCalls } from '@/components/agent-visualizer/canvas/draw-tool-calls'
import { drawDiscoveries } from '@/components/agent-visualizer/canvas/draw-discoveries'
import { drawEdgeBubbles } from '@/components/agent-visualizer/canvas/draw-links'
import { drawClusterLabels, drawTeamHalos } from '@/components/agent-visualizer/canvas/draw-teams'
import { drawParticles } from '@/components/agent-visualizer/canvas/draw-particles'
import { computeClusters, planOverlays, selectEdgeBubble, setOverlayHits, resolveLinks, lodForZoom } from '@/components/agent-visualizer/canvas/index'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown>): any {
  const id = over.id as string
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id, state: 'thinking', parentId: null, parentKey: null,
    tokensUsed: 100000, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 1, timeAlive: 1, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, opacity: 1, scale: 1,
    messageBubbles: [], ...over,
  }
}

function recorder() {
  const texts: string[] = []
  const ctx: any = new Proxy({ canvas: { width: 1, height: 1, offsetWidth: 1 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'fillText' || k === 'strokeText') return (s: string) => { texts.push(String(s)) }
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  ;(globalThis as any).Path2D = class {}
  return { ctx, texts }
}

const SECRET = 'SECRETWORD'

function scene() {
  const agents = new Map<string, any>([
    ['s1:m', agent({ id: 's1:m', isMain: true, x: 100, y: 100, name: `Fix ${SECRET} in repo`, sessionLabel: `${SECRET}-repo`, workspace: `/home/${SECRET}`, messageBubbles: [{ text: `say ${SECRET}`, time: 0, role: 'assistant' }] })],
    ['s1:c', agent({ id: 's1:c', x: 400, y: 100, parentId: 's1:m', name: `Child ${SECRET}` })],
    ['s2:m', agent({ id: 's2:m', sessionId: 's2', isMain: true, x: 130, y: 120, name: 'Other' })],
  ])
  const toolCalls = new Map<string, any>([
    ['t1', { id: 't1', agentId: 's1:m', toolName: 'Read', state: 'complete', args: `/home/${SECRET}/a.ts`, result: `${SECRET} result`, x: 150, y: 200, startTime: 0, opacity: 1, tokenCost: 42 }],
    ['t2', { id: 't2', agentId: 's1:m', toolName: 'Bash', state: 'error', args: 'ls', errorMessage: `${SECRET} failed`, x: 250, y: 200, startTime: 0, opacity: 1 }],
    ['t3', { id: 't3', agentId: 's1:m', toolName: 'Edit', state: 'running', args: `/home/${SECRET}/b.ts`, x: 350, y: 200, startTime: 0, opacity: 1 }],
  ])
  const discoveries = [{ id: 'd1', agentId: 's1:m', type: 'file', label: `${SECRET}.ts`, content: `line ${SECRET}\nsecond`, x: 200, y: 300, targetX: 200, targetY: 300, opacity: 1, timestamp: 0 }]
  const links = new Map<string, any>([['L1', {
    id: 'L1', from: 's1:m', to: 's1:c', kind: 'spawn', sessionId: 's1', dropped: 0,
    messages: [{ id: 'm1', type: 'dispatch', content: `do ${SECRET}`, timestamp: 1, from: 's1:m', to: 's1:c' }],
  }]])
  const resolved = resolveLinks(links, agents, 2)
  const clusters = computeClusters(agents.values()).map((c: any) => ({ ...c, title: `${SECRET}-cluster`, workspace: `/w/${SECRET}`, projectName: `${SECRET}-proj` }))
  const bubbles = resolved.map(r => selectEdgeBubble(r, agents, 2, false, t => t.length * 6.6)!).filter(Boolean)
  const planned = planOverlays({
    agents, clusters, edgeBubbles: bubbles, transform: { x: 0, y: 0, scale: 1 }, viewport: { w: 1000, h: 700 }, lod: lodForZoom(1),
    showStats: true, showCost: false, showSessionLabels: true, selectedAgentId: null, hoveredAgentId: null, focusedAgentId: null,
    simTime: 2, isBubbleHeld: () => false,
  })
  setOverlayHits(planned.hits)
  const edgeMap = new Map<string, any>([['e1', { id: 'e1', from: 's1:m', to: 's1:c', type: 'parent-child' }]])
  const particles = [{ id: 'p1', edgeId: 'e1', progress: 0.5, type: 'tool_call', color: '#fff', size: 3, trailLength: 2, label: `${SECRET} 12 lines` }]
  const halos = [{ name: `${SECRET}-team`, cx: 100, cy: 100, r: 150, color: '#0ff', memberIds: ['s1:m'], key: 'team' }]
  return { agents, toolCalls, discoveries, clusters, bubbles, planned, edgeMap, particles, halos }
}

function drawAll(maskText: boolean): string[] {
  const { ctx, texts } = recorder()
  const s = scene()
  const opts: any = { reducedMotion: false, zoom: 1, showCost: false, showStats: true, showSessionLabels: true, plan: s.planned.plan, crowded: s.planned.crowded, edgeBubbles: true, maskText }
  drawAgents(ctx, s.agents, null, null, true, 0, opts)
  drawMessageBubblesWorld(ctx, s.agents, 2, opts)
  drawToolCalls(ctx, s.toolCalls, 0, null, opts)
  drawDiscoveries(ctx, s.discoveries as any, s.agents, null, opts)
  drawEdgeBubbles(ctx, s.bubbles, null, null, opts)
  drawClusterLabels(ctx, s.clusters as any, s.planned.plan, null, null, opts)
  drawTeamHalos(ctx, s.halos as any, opts)
  drawParticles(ctx, s.particles as any, s.edgeMap, s.agents, s.toolCalls, 0, opts)
  return texts
}

test('control: without masking the free text is drawn (the assertions below can fail)', () => {
  const texts = drawAll(false)
  assert.ok(texts.some(t => t.includes(SECRET)), 'secret appears when masking is off')
})

test('with maskText no drawn string contains the free text', () => {
  const texts = drawAll(true)
  assert.ok(texts.length > 10, 'something is still drawn')
  const leaked = texts.filter(t => t.includes(SECRET))
  assert.deepEqual(leaked, [])
})

test('with maskText the tool name, the numbers and the states stay readable', () => {
  const texts = drawAll(true).join('\n')
  assert.match(texts, /Read/)
  assert.match(texts, /42 tok/)
  assert.match(texts, /Bash: /)
  assert.match(texts, /•/, 'masked text is drawn as bullets, not left blank')
})
