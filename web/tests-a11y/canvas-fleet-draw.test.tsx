// Smoke test: runs every draw function of the fleet overlays (halos, labels, bubbles, edge bubbles) against a recording context.
// Synthetic agents only.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { drawMessageBubblesWorld } from '@/components/agent-visualizer/canvas/draw-bubbles'
import { drawCostLabels } from '@/components/agent-visualizer/canvas/draw-cost'
import { drawLinks, drawEdgeBubbles } from '@/components/agent-visualizer/canvas/draw-links'
import { drawClusterHalos, drawClusterLabels } from '@/components/agent-visualizer/canvas/draw-teams'
import { computeClusters, planOverlays, selectEdgeBubble, setOverlayHits, resolveLinks, lodForZoom } from '@/components/agent-visualizer/canvas/index'

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(over: Record<string, unknown>): any {
  const id = over.id as string
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id, state: 'thinking', parentId: null, parentKey: null,
    tokensUsed: 100000, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 1, timeAlive: 1, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, opacity: 1, scale: 1,
    messageBubbles: [{ text: 'hello world', time: 0, role: 'assistant' }], ...over,
  }
}

test('canvas-fleet draw smoke: the whole draw path runs with a placement plan', () => {
  const calls: string[] = []
  const ctx: any = new Proxy({ canvas: { width: 1, height: 1, offsetWidth: 1 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return (...a: unknown[]) => { calls.push(k + a.length); return undefined }
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  ;(globalThis as any).Path2D = class {}
  ;(globalThis as any).document = { createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) }
  const agents = new Map<string, any>([
    ['s1:m', agent({ id: 's1:m', isMain: true, x: 100, y: 100, sessionLabel: 'repo' })],
    ['s1:c', agent({ id: 's1:c', x: 400, y: 100, parentId: 's1:m' })],
    ['s2:m', agent({ id: 's2:m', sessionId: 's2', isMain: true, x: 130, y: 120 })],
  ])
  const links = new Map<string, any>([['L1', {
    id: 'L1', from: 's1:m', to: 's1:c', kind: 'spawn', sessionId: 's1', dropped: 0,
    messages: [{ id: 'm1', type: 'dispatch', content: 'do it', timestamp: 1, from: 's1:m', to: 's1:c' }],
  }]])
  const resolved = resolveLinks(links, agents, 2)
  const clusters = computeClusters(agents.values())
  const bubbles = resolved.map(r => selectEdgeBubble(r, agents, 2, false, t => t.length * 6.6)!).filter(Boolean)
  const transform = { x: 0, y: 0, scale: 1 }
  const r = planOverlays({
    agents, clusters, edgeBubbles: bubbles, transform, viewport: { w: 1000, h: 700 }, lod: lodForZoom(1),
    showStats: true, showCost: true, showSessionLabels: true, selectedAgentId: 's1:m', hoveredAgentId: null, focusedAgentId: null,
    simTime: 2, isBubbleHeld: () => false,
  })
  setOverlayHits(r.hits)
  const opts: any = { reducedMotion: false, zoom: 1, showCost: true, showStats: true, showSessionLabels: true, plan: r.plan, crowded: r.crowded, edgeBubbles: true }
  drawClusterHalos(ctx, clusters, null, opts)
  drawLinks(ctx, resolved, agents, null, null, 0, opts)
  drawAgents(ctx, agents, 's1:m', null, true, 0, opts)
  drawEdgeBubbles(ctx, bubbles, null, null, opts)
  drawMessageBubblesWorld(ctx, agents, 2, opts)
  drawCostLabels(ctx, agents, new Map(), opts)
  drawClusterLabels(ctx, clusters, r.plan, null, null)
  assert.ok(calls.length > 50)
  assert.ok(calls.some(c => c.startsWith('fillText')))
})
