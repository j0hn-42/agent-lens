// Smoke test: the MCP-specific draw paths (tool card badge/orbit, dotted particle, agent rim, sonar effect)
// run against a recording context, in normal and reduced-motion modes, and draw the MCP cyan.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { drawToolCalls } from '@/components/agent-visualizer/canvas/draw-tool-calls'
import { drawParticles, buildEdgeMap } from '@/components/agent-visualizer/canvas/draw-particles'
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { drawEffects } from '@/components/agent-visualizer/canvas/draw-effects'
import { SCENE } from '@/lib/colors'

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeCtx() {
  const calls: string[] = []
  const strokes: unknown[] = []
  const texts: string[] = []
  const ctx: any = new Proxy({ canvas: { width: 1, height: 1, offsetWidth: 1 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      if (k === 'stroke') return () => { strokes.push(t.strokeStyle); calls.push('stroke') }
      if (k === 'fillText') return (s: string) => { texts.push(s); calls.push('fillText') }
      return (...a: unknown[]) => { calls.push(k + a.length); return undefined }
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
  ;(globalThis as any).Path2D = class {}
  ;(globalThis as any).document = { createElement: () => ({ getContext: () => ctx, width: 0, height: 0 }) }
  return { ctx, strokes, texts }
}

const baseAgent: any = {
  id: 's1:m', agentKey: 's1:m', sessionId: 's1', localId: 'm', displayName: 'm', name: 'm', state: 'tool_calling',
  currentTool: 'mcp__stripe__refund', parentId: null, parentKey: null, tokensUsed: 1000, tokensMax: 200000,
  contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
  toolCalls: 1, timeAlive: 1, x: 100, y: 100, vx: 0, vy: 0, pinned: false, isMain: true, spawnTime: 0, opacity: 1, scale: 1,
  messageBubbles: [],
}

const mcpTool: any = {
  id: 't1', agentId: 's1:m', toolName: 'mcp__stripe__refund', mcp: { server: 'stripe', tool: 'refund' },
  state: 'running', args: 'id: 1', x: 200, y: 160, startTime: 0, opacity: 1,
}

for (const reducedMotion of [false, true]) {
  test(`MCP draw paths run and use the MCP cyan (reducedMotion=${reducedMotion})`, () => {
    const { ctx, strokes, texts } = makeCtx()
    const opts: any = { reducedMotion, zoom: 1, showCost: false, showStats: false, showSessionLabels: false, crowded: false, edgeBubbles: false }
    const agents = new Map<string, any>([['s1:m', baseAgent]])
    const toolCalls = new Map<string, any>([['t1', mcpTool]])
    const edges = [{ id: 'edge-t1', from: 's1:m', to: 't1', type: 'tool', opacity: 1 }] as any[]
    const particles = [{ id: 'p-tc-1-t1', edgeId: 'edge-t1', progress: 0.5, type: 'tool_call', color: SCENE.mcp, size: 4, trailLength: 0.15, mcp: true, label: 'x' }] as any[]

    drawAgents(ctx, agents, null, null, false, 1.5, opts)
    drawToolCalls(ctx, toolCalls, 1.5, null, opts)
    drawParticles(ctx, particles, buildEdgeMap(edges), agents, toolCalls, 1.5, opts)
    drawEffects(ctx, [{ type: 'mcp', x: 200, y: 160, color: SCENE.mcp, age: 0.3, duration: 0.9 }])

    assert.ok(strokes.includes(SCENE.mcp), 'agent rim or sonar ring is stroked in MCP cyan')
    assert.ok(texts.some(t => t.includes('MCP') && t.includes('stripe')), 'server badge text is drawn')
  })
}

test('native tools draw no MCP badge', () => {
  const { ctx, texts } = makeCtx()
  const opts: any = { reducedMotion: false, zoom: 1, showCost: false, showStats: false, showSessionLabels: false, crowded: false, edgeBubbles: false }
  const native = { ...mcpTool, toolName: 'Read', mcp: undefined }
  drawToolCalls(ctx, new Map([['t1', native]]), 1, null, opts)
  assert.ok(!texts.some(t => t.includes('MCP')))
})
