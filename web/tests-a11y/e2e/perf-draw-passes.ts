// Draw-pass measurement (#216), not a test: 300 synthetic agents in 10 clusters, zoomed on 1 cluster, with and
// without viewport culling. Counts the paint calls (fill, stroke, text, image, rect) of the real draw passes on a
// recording context and times the JavaScript side (no GPU: the browser numbers come from perf-measure.ts).
//
//   pnpm --dir web exec node --import tsx --import ./tests-a11y/setup.ts tests-a11y/e2e/perf-draw-passes.ts
import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { drawToolCalls } from '@/components/agent-visualizer/canvas/draw-tool-calls'
import { drawEdges, getActiveEdgeIds } from '@/components/agent-visualizer/canvas/draw-edges'
import { drawParticles, buildEdgeMap } from '@/components/agent-visualizer/canvas/draw-particles'
import { DEFAULT_DRAW_OPTS, type DrawOpts } from '@/components/agent-visualizer/canvas/draw-options'
import { viewRectFor } from '@/components/agent-visualizer/canvas/view-cull'

/* eslint-disable @typescript-eslint/no-explicit-any */
;(globalThis as any).Path2D ??= class { addPath() {} }
const PAINT = new Set(['fill', 'stroke', 'fillText', 'strokeText', 'drawImage', 'fillRect', 'strokeRect'])
function recorder() {
  const c = { paint: 0, all: 0 }
  const ctx: any = new Proxy({ canvas: { width: 1, height: 1, offsetWidth: 1 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => { c.all++; if (PAINT.has(k)) c.paint++ }
    },
    set(t: any, k: string, v: any) { t[k] = v; return true },
  })
  return { ctx, c }
}

const CLUSTERS = 10, PER = 30
const agents = new Map<string, any>(), toolCalls = new Map<string, any>(), edges: any[] = [], particles: any[] = []
for (let s = 0; s < CLUSTERS; s++) {
  const a = (s / CLUSTERS) * Math.PI * 2
  const cx = Math.cos(a) * 1800, cy = Math.sin(a) * 1800
  for (let i = 0; i < PER; i++) {
    const id = `s${s}:a${i}`
    const ang = (i / PER) * Math.PI * 2
    agents.set(id, {
      id, agentKey: id, sessionId: `s${s}`, localId: `a${i}`, displayName: `agent ${i}`, name: `agent ${i}`, state: i % 3 ? 'thinking' : 'idle',
      parentId: i === 0 ? null : `s${s}:a0`, parentKey: i === 0 ? null : `s${s}:a0`, tokensUsed: 1000 * i, tokensMax: 200_000,
      contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
      toolCalls: 1, timeAlive: 1, x: i === 0 ? cx : cx + Math.cos(ang) * 260, y: i === 0 ? cy : cy + Math.sin(ang) * 260,
      vx: 0, vy: 0, pinned: false, isMain: i === 0, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
    })
    toolCalls.set(`t${s}:${i}`, { id: `t${s}:${i}`, agentId: id, toolName: 'Read', state: 'running', args: 'src/a.ts', x: agents.get(id).x + 90, y: agents.get(id).y, startTime: 0, opacity: 1 })
    if (i > 0) {
      const e = { id: `e${s}:${i}`, from: `s${s}:a0`, to: id, type: 'parent-child' }
      edges.push(e)
      if (i % 3 === 0) particles.push({ id: `particle-${s}:${i}`, edgeId: e.id, progress: 0.5, type: 'dispatch', color: '#66ccff', size: 4, label: 'go' })
    }
  }
}
const edgeMap = buildEdgeMap(edges)
const active = getActiveEdgeIds(particles)

function frame(opts: DrawOpts) {
  const { ctx, c } = recorder()
  drawEdges(ctx, edges, agents, toolCalls, active, 0, opts)
  drawAgents(ctx, agents, null, null, false, 0, opts)
  drawToolCalls(ctx, toolCalls, 0, null, opts)
  drawParticles(ctx, particles, edgeMap, agents, toolCalls, 0, opts)
  return c
}
function time(opts: DrawOpts): number {
  for (let i = 0; i < 5; i++) frame(opts)
  const runs = 30
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) frame(opts)
  return (performance.now() - t0) / runs
}

const W = 1280, H = 800
const c0 = agents.get('s0:a0')
const zoom = 0.9
const overview = { x: W / 2, y: H / 2, scale: 0.12 }
const zoomed = { x: W / 2 - c0.x * zoom, y: H / 2 - c0.y * zoom, scale: zoom }
console.log(`| scène | agents | passes | appels de dessin / frame | JS des passes (ms) |`)
console.log(`|---|---|---|---|---|`)
for (const [label, t] of [['vue d\'ensemble (zoom 0,12)', overview], ['zoomé sur 1 cluster (zoom 0,9)', zoomed]] as const) {
  const base: DrawOpts = { ...DEFAULT_DRAW_OPTS, zoom: t.scale }
  const culled: DrawOpts = { ...base, view: viewRectFor(t, W, H) }
  console.log(`| ${label}, sans culling | ${agents.size} | agents, outils, arêtes, particules | ${frame(base).paint} | ${time(base).toFixed(2)} |`)
  console.log(`| ${label}, avec culling | ${agents.size} | agents, outils, arêtes, particules | ${frame(culled).paint} | ${time(culled).toFixed(2)} |`)
}
