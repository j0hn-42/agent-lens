import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeFitBounds, fitToView, fitInsets } from '../web/components/agent-visualizer/canvas/camera-fit'
import { planOverlays } from '../web/components/agent-visualizer/canvas/overlay-plan'
import { computeClusters } from '../web/components/agent-visualizer/canvas/cluster-model'
import { lodForZoom } from '../web/components/agent-visualizer/canvas/draw-options'

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeFleet(sessions: number, perSession: number): Map<string, any> {
  const agents = new Map<string, any>()
  for (let s = 0; s < sessions; s++) {
    const a = (s / sessions) * Math.PI * 2
    const cx = Math.cos(a) * 1400
    const cy = Math.sin(a) * 1400
    for (let i = 0; i < perSession; i++) {
      const id = `s${s}:a${i}`
      agents.set(id, {
        id, agentKey: id, sessionId: `s${s}`, name: i === 0 ? 'main' : `sub-${i}`, state: i % 2 ? 'thinking' : 'idle',
        parentId: i === 0 ? null : `s${s}:a0`, tokensUsed: 1000 * i, tokensMax: 200_000,
        contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
        x: cx + (i - 3) * 60, y: cy + (i % 3) * 50, vx: 0, vy: 0, isMain: i === 0, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
      })
    }
  }
  return agents
}

// Micro-benchmark: one frame of the camera / overlay work in the All view with 17 clusters must stay
// far below the 16 ms budget. The bound is deliberately generous (CI machines are noisy).
test('All view with 17 clusters: per-frame fit + cluster + overlay planning stays cheap', () => {
  const agents = makeFleet(17, 6)
  const VP = { width: 2118, height: 1273 }
  const insets = fitInsets({ top: 68, bottom: 73, left: 0, right: 0 }, true)
  const frame = () => {
    const clusters = computeClusters(agents.values())
    const bounds = computeFitBounds({ agents: agents.values(), clusters, simTime: 0 })
    const t = fitToView(bounds, VP, insets)!
    planOverlays({
      agents, clusters, edgeBubbles: [], transform: t, viewport: { w: VP.width, h: VP.height },
      safeArea: { x: 0, y: 68, w: VP.width, h: VP.height - 141 }, lod: lodForZoom(t.scale),
      showStats: true, showCost: true, showSessionLabels: true, selectedAgentId: null, hoveredAgentId: null,
      focusedAgentId: null, simTime: 0, isBubbleHeld: () => false,
    })
    return clusters.length
  }
  assert.equal(frame(), 17)
  for (let i = 0; i < 20; i++) frame() // warm-up
  const N = 200
  const t0 = performance.now()
  for (let i = 0; i < N; i++) frame()
  const perFrame = (performance.now() - t0) / N
  console.log(`  camera/overlay frame cost: ${perFrame.toFixed(3)} ms`)
  assert.ok(perFrame < 8, `per-frame cost ${perFrame.toFixed(2)} ms exceeds 8 ms`)
})
