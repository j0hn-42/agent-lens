// Viewport culling (#216): the draw passes skip what is outside the visible area. Synthetic data, recording context.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { viewRectFor } from '@/components/agent-visualizer/canvas/view-cull'
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { drawToolCalls } from '@/components/agent-visualizer/canvas/draw-tool-calls'
import { drawEdges } from '@/components/agent-visualizer/canvas/draw-edges'
import { drawParticles, buildEdgeMap } from '@/components/agent-visualizer/canvas/draw-particles'
import { DEFAULT_DRAW_OPTS } from '@/components/agent-visualizer/canvas/draw-options'

/* eslint-disable @typescript-eslint/no-explicit-any */
function recorder() {
  const counter = { n: 0 }
  const ctx: any = new Proxy({ canvas: { width: 1, height: 1, offsetWidth: 1 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => { counter.n++ }
    },
    set(t: any, k: string, v: any) { t[k] = v; return true },
  })
  return { ctx, counter }
}
function agentAt(id: string, x: number, y: number): any {
  return {
    id, agentKey: id, sessionId: 's1', localId: id, displayName: id, name: id, state: 'thinking', parentId: null, parentKey: null,
    tokensUsed: 1000, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 1, timeAlive: 1, x, y, vx: 0, vy: 0, pinned: false, isMain: false, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
  }
}
function toolAt(id: string, agentId: string, x: number, y: number): any {
  return { id, agentId, toolName: 'Read', state: 'running', args: 'a.ts', x, y, startTime: 0, opacity: 1 }
}
const FAR = 9000
const view = viewRectFor({ x: 0, y: 0, scale: 1 }, 800, 600)
const withView = { ...DEFAULT_DRAW_OPTS, view }

test('cull: drawAgents skips agents far outside the viewport and keeps the visible ones', () => {
  const agents = new Map<string, any>([['a', agentAt('a', 400, 300)], ['b', agentAt('b', FAR, FAR)]])
  const all = recorder(); drawAgents(all.ctx, agents, null, null, false, 0, DEFAULT_DRAW_OPTS)
  const ref = recorder(); drawAgents(ref.ctx, new Map([['a', agents.get('a')]]), null, null, false, 0, DEFAULT_DRAW_OPTS)
  const culled = recorder(); drawAgents(culled.ctx, agents, null, null, false, 0, withView)
  assert.ok(all.counter.n > ref.counter.n, 'the far agent costs draw calls without culling')
  assert.equal(culled.counter.n, ref.counter.n, 'with the view, only the visible agent is drawn')
})

test('cull: drawToolCalls skips cards outside the viewport', () => {
  const tools = new Map<string, any>([['t1', toolAt('t1', 'a', 400, 300)], ['t2', toolAt('t2', 'a', FAR, FAR)]])
  const ref = recorder(); drawToolCalls(ref.ctx, new Map([['t1', tools.get('t1')]]), 0, null, DEFAULT_DRAW_OPTS)
  const culled = recorder(); drawToolCalls(culled.ctx, tools, 0, null, withView)
  const all = recorder(); drawToolCalls(all.ctx, tools, 0, null, DEFAULT_DRAW_OPTS)
  assert.ok(all.counter.n > ref.counter.n)
  assert.equal(culled.counter.n, ref.counter.n)
})

const edge = (id: string, from: string, to: string): any => ({ id, from, to, type: 'parent-child' })

test('cull: drawEdges skips an edge entirely outside, keeps one that crosses the viewport', () => {
  const agents = new Map<string, any>([
    ['a', agentAt('a', 100, 100)], ['b', agentAt('b', 300, 300)],
    ['c', agentAt('c', FAR, FAR)], ['d', agentAt('d', FAR + 300, FAR + 200)],
    ['e', agentAt('e', 700, 500)], ['f', agentAt('f', FAR, 500)],
  ])
  const run = (edges: any[], opts: any) => { const r = recorder(); drawEdges(r.ctx, edges, agents, new Map(), new Set(), 0, opts); return r.counter.n }
  const near = edge('e1', 'a', 'b'), far = edge('e2', 'c', 'd'), cross = edge('e3', 'e', 'f')
  assert.ok(run([far], DEFAULT_DRAW_OPTS) > 0)
  assert.equal(run([far], withView), 0)
  assert.ok(run([near], withView) > 0)
  assert.equal(run([near], withView), run([near], DEFAULT_DRAW_OPTS))
  assert.equal(run([cross], withView), run([cross], DEFAULT_DRAW_OPTS))
})

test('cull: drawParticles skips particles outside the viewport', () => {
  const agents = new Map<string, any>([
    ['a', agentAt('a', 100, 100)], ['b', agentAt('b', 300, 300)],
    ['c', agentAt('c', FAR, FAR)], ['d', agentAt('d', FAR + 300, FAR + 200)],
  ])
  const edges: any[] = [edge('e1', 'a', 'b'), edge('e2', 'c', 'd')]
  const mk = (edgeId: string): any => ({ id: `particle-${edgeId}`, edgeId, progress: 0.5, type: 'dispatch', color: '#66ccff', size: 4, label: 'x' })
  const run = (p: any[], opts: any) => { const r = recorder(); drawParticles(r.ctx, p, buildEdgeMap(edges), agents, new Map(), 0, opts); return r.counter.n }
  assert.ok(run([mk('e2')], DEFAULT_DRAW_OPTS) > 0)
  assert.equal(run([mk('e2')], withView), 0)
  assert.ok(run([mk('e1')], withView) > 0)
  assert.equal(run([mk('e1')], withView), run([mk('e1')], DEFAULT_DRAW_OPTS))
})
