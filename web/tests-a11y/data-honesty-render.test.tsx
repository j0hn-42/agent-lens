// #50: the canvas context bar / percentage and the cost panel qualify their figures ("at least", "estimated"),
// and #49: the configurable expiry delay really reaches the simulation hook.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, act, cleanup } from '@testing-library/react'

import { drawContextComposition, drawContextRing } from '@/components/agent-visualizer/canvas/draw-agents'
import { drawCostSummaryPanel } from '@/components/agent-visualizer/canvas/draw-cost'
import { useAgentSimulation } from '@/hooks/use-agent-simulation'
import { toolExpiryConfig, setToolExpiryS, TOOL_EXPIRY_S } from '@/lib/canvas-constants'
import type { SimulationEvent } from '@/lib/agent-types'

/* eslint-disable @typescript-eslint/no-explicit-any */
function recordingCtx(texts: string[]): any {
  return new Proxy({ canvas: { width: 1000, height: 700, offsetWidth: 1000 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 6.6 })
      if (k === 'fillText') return (s: string) => { texts.push(s) }
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
}

function agent(over: Record<string, unknown>): any {
  return {
    id: 'a', agentKey: 'a', sessionId: 's1', localId: 'a', name: 'main', state: 'thinking', parentId: null,
    tokensUsed: 120000, tokensMax: 200000, model: 'claude-sonnet-4',
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    x: 0, y: 0, isMain: true, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], ...over,
  }
}

test('the context bar and the percentage say "at least" / "estimated" like the session list does', () => {
  const texts: string[] = []
  const ctx = recordingCtx(texts)
  const a = agent({ tokenStatus: 'partial', tokensEstimated: true, tokensUsed: 180000 })
  drawContextComposition(ctx, a, 20)
  drawContextRing(ctx, a, 20, 0, true, true)
  assert.ok(texts.some(t => /^at least 180k estimated \/ 200k tokens$/.test(t)), `bar label qualified, got ${JSON.stringify(texts)}`)
  assert.ok(texts.some(t => /^at least 90% estimated$/.test(t)), `percentage qualified, got ${JSON.stringify(texts)}`)

  const exact: string[] = []
  drawContextComposition(recordingCtx(exact), agent({ tokenStatus: 'available', tokensEstimated: false, tokensUsed: 180000 }), 20)
  assert.ok(exact.includes('180k / 200k tokens'), 'an exact figure stays plain')
})

test('the cost panel qualifies per-agent rows and BY TOOL rows', () => {
  const texts: string[] = []
  const agents = new Map<string, any>([['a', agent({ tokenStatus: 'partial', tokensEstimated: true })]])
  const toolCalls = new Map<string, any>([['t', { id: 't', agentId: 'a', toolName: 'Read', state: 'complete', tokenCost: 5000, tokenSource: 'estimated' }]])
  drawCostSummaryPanel(recordingCtx(texts), agents, toolCalls)
  const costs = texts.filter(t => t.includes('$'))
  assert.ok(costs.length >= 3, `header, agent row and tool row show a cost, got ${JSON.stringify(costs)}`)
  for (const c of costs) assert.match(c, /estimated/, `${c} is badged`)
  assert.ok(texts.some(t => /^at least \$/.test(t)), 'the agent row is a lower bound')
})

test('the cost panel lists a partial agent as a lower bound and never lists an unavailable one as 0', () => {
  const texts: string[] = []
  const agents = new Map<string, any>([
    ['p', agent({ id: 'p', name: 'partial-one', tokenStatus: 'partial', tokensUsed: 40000 })],
    ['u', agent({ id: 'u', name: 'unknown-one', tokenStatus: 'unavailable', tokensUsed: 0, isMain: false })],
  ])
  drawCostSummaryPanel(recordingCtx(texts), agents, new Map())
  assert.ok(texts.some(t => t.includes('partial-one')), 'partial agent has a row')
  assert.ok(!texts.some(t => t.includes('unknown-one')), 'unavailable agent has no row')
  assert.ok(!texts.some(t => /\$0\.00/.test(t)), `no invented zero, got ${JSON.stringify(texts)}`)
  assert.ok(texts.some(t => /^at least \$/.test(t)), 'the header is a lower bound because an agent has no data')
})

// ─── Expiry delay wiring ────────────────────────────────────────────────────

const T0 = 1_700_000_000_000
const FRAME_MS = 20
const realRaf = globalThis.requestAnimationFrame
const realCaf = globalThis.cancelAnimationFrame
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: T0 })
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => { act(() => { cb(Date.now()) }) }, FRAME_MS) as unknown as number
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)
})
afterEach(() => {
  cleanup()
  mock.timers.reset()
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCaf
  toolExpiryConfig.seconds = TOOL_EXPIRY_S
  try { window.localStorage.clear() } catch { /* none */ }
})

test('the configured expiry delay is the one the hook uses when it seeks', () => {
  const events: SimulationEvent[] = [
    { time: 0, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { time: 1, type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Bash', args: 'sleep', toolUseId: 'toolu_1' } },
  ]
  const view = renderHook(() => useAgentSimulation({ useMockData: false, externalEvents: events, onExternalEventsConsumed: () => {} }))
  act(() => { view.result.current.play() })
  for (let i = 0; i < 5; i++) act(() => { mock.timers.tick(FRAME_MS) })

  const stateAt = (t: number) => {
    act(() => { view.result.current.seekToTime(t) })
    return Array.from(view.result.current.frameRef.current.toolCalls.values())[0]?.state
  }
  assert.equal(stateAt(20), 'running', 'default delay: still running after 20 s')
  act(() => { setToolExpiryS(60) })
  assert.equal(toolExpiryConfig.seconds, 60)
  assert.equal(stateAt(100), 'expired', 'a 60 s setting expires the call at 100 s')
  act(() => { setToolExpiryS(1800) })
  assert.equal(stateAt(100), 'running', 'a 30 min setting keeps it running')
})
