// #366: what the canvas draws under and above each agent (tool count, cost pill) is a lower bound when the relay could not replay
// events of the agent's session; the qualified text stays inside its box, and the plan reserves the box that is drawn.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { drawAgents } from '@/components/agent-visualizer/canvas/draw-agents'
import { drawCostLabels } from '@/components/agent-visualizer/canvas/draw-cost'
import { planOverlays, planKey, agentLabelBlock } from '@/components/agent-visualizer/canvas/overlay-plan'
import { orchestratorInfo } from '@/components/agent-visualizer/canvas/team-style'
import { estimateTextWidth } from '@/components/agent-visualizer/canvas/edge-bubbles'
import { computeClusters } from '@/components/agent-visualizer/canvas/cluster-model'
import { lodForZoom, type DrawOpts } from '@/components/agent-visualizer/canvas/draw-options'
import { statsLabel } from '@/components/agent-visualizer/canvas/loss-labels'
import { STATS_OVERLAY } from '@/lib/canvas-constants'

/* eslint-disable @typescript-eslint/no-explicit-any */
const statsText = (a: any, l: ReadonlyMap<string, number> | undefined) => statsLabel(a, l).text
const CHAR_W = 6.6
function recordingCtx(texts: string[]): any {
  return new Proxy({ canvas: { width: 1000, height: 700, offsetWidth: 1000 } }, {
    get(t: any, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * CHAR_W })
      if (k === 'fillText') return (s: string) => { texts.push(s) }
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      return () => undefined
    },
    set(t: any, k: string, v: unknown) { t[k] = v; return true },
  })
}

// drawAgents builds Path2D shapes (the brand marks); jsdom has none
;(globalThis as any).Path2D ??= class {}

function agent(over: Record<string, unknown> = {}): any {
  return {
    id: 's1:main', agentKey: 's1:main', sessionId: 's1', localId: 'main', name: 'main', state: 'thinking', parentId: null,
    tokensUsed: 120000, tokensMax: 200000, tokenStatus: 'available', tokensEstimated: false, model: 'claude-sonnet-4',
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    x: 300, y: 300, isMain: true, spawnTime: 0, timeAlive: 62, toolCalls: 13, opacity: 1, scale: 1, messageBubbles: [], ...over,
  }
}
const lossOf = (n: number) => new Map([['s1', n]])

test('statsText: plain without loss, "at least" / "(incomplete)" with loss on the agent\'s own session only', () => {
  assert.equal(statsText(agent(), undefined), '13 tools · 1:02')
  assert.equal(statsText(agent(), lossOf(5)), 'at least 13 tools · 1:02')
  assert.equal(statsText(agent({ toolCalls: 1 }), lossOf(5)), 'at least 1 tool · 1:02')
  assert.equal(statsText(agent({ toolCalls: 0 }), lossOf(5)), 'no tool observed (incomplete)', 'too long with its duration: the duration goes, not the qualifier')
  assert.equal(statsText(agent(), new Map([['other', 9]])), '13 tools · 1:02', 'the loss of another session is not this agent\'s')
  assert.equal(statsText(agent({ sessionId: undefined }), lossOf(5)), '13 tools · 1:02')
})

test('the stats box never overflows: the longest qualified strings fit the box, or lose their duration, never their qualifier', () => {
  const longest = [
    agent({ toolCalls: 0, timeAlive: 12 * 3600 + 34 * 60 + 56 }),
    agent({ toolCalls: 99999, timeAlive: 12 * 3600 + 34 * 60 + 56 }),
    agent({ toolCalls: 13_000_000, timeAlive: 99 * 3600 }),
  ]
  for (const a of longest) {
    const { text, width } = statsLabel(a, lossOf(3))
    assert.ok(width <= STATS_OVERLAY.maxBoxWidth)
    assert.ok(text.length * CHAR_W + 16 <= width, `${text} fits its box`)
    assert.match(text, /^(at least \d+ tools?|no tool observed \(incomplete\))/)
  }
  assert.equal(statsLabel(agent({ timeAlive: 12 * 3600 + 34 * 60 + 56 }), undefined).width, STATS_OVERLAY.boxWidth, 'the usual box is unchanged without loss')
})

test('drawAgents: the tool count under the agent is qualified when its session lost events', () => {
  const opts: DrawOpts = { reducedMotion: true, zoom: 1, showCost: false, showStats: true, replayLost: lossOf(4) }
  const texts: string[] = []
  drawAgents(recordingCtx(texts), new Map([['s1:main', agent()]]), null, null, true, 0, opts)
  assert.ok(texts.includes('at least 13 tools · 1:02'), JSON.stringify(texts))
  const plain: string[] = []
  drawAgents(recordingCtx(plain), new Map([['s1:main', agent()]]), null, null, true, 0, { ...opts, replayLost: undefined })
  assert.ok(plain.includes('13 tools · 1:02'), JSON.stringify(plain))
  assert.ok(!plain.some(t => /at least/.test(t)))
})

test('planOverlays reserves the width of the qualified stats box', () => {
  const agents = new Map<string, any>([['s1:main', agent({ toolCalls: 0, timeAlive: 12 * 3600 + 34 * 60 + 56 })]])
  const input = (replayLost?: ReadonlyMap<string, number>): any => ({
    agents, clusters: computeClusters(agents.values()), edgeBubbles: [],
    transform: { x: 0, y: 0, scale: 1 }, viewport: { w: 1200, h: 800 }, lod: lodForZoom(1),
    showStats: true, showCost: false, showSessionLabels: false,
    selectedAgentId: 's1:main', hoveredAgentId: null, focusedAgentId: null, simTime: 1, isBubbleHeld: () => false, replayLost,
  })
  const plain = planOverlays(input()).plan.get(planKey.stats('s1:main'))!.rect!
  const lossy = planOverlays(input(lossOf(2))).plan.get(planKey.stats('s1:main'))!.rect!
  assert.equal(plain.w, STATS_OVERLAY.boxWidth)
  assert.equal(lossy.w, statsLabel(agents.get('s1:main'), lossOf(2)).width)
  assert.ok(lossy.w > plain.w)
})

test('the cost pill of an agent is a lower bound when its session lost events', () => {
  const opts: DrawOpts = { reducedMotion: true, zoom: 1, showCost: true, showStats: false, replayLost: lossOf(4) }
  const a = agent({ tokensUsed: 5_000_000 })
  const lossy: string[] = []
  drawCostLabels(recordingCtx(lossy), new Map([['s1:main', a]]), new Map(), opts)
  assert.ok(lossy.some(t => /^at least ~\$/.test(t)), JSON.stringify(lossy))
  const plain: string[] = []
  drawCostLabels(recordingCtx(plain), new Map([['s1:main', a]]), new Map(), { ...opts, replayLost: undefined })
  assert.ok(plain.some(t => /^~\$/.test(t)), JSON.stringify(plain))
})

// A context reading is absolute (a lost compaction can lower it): under a loss it is the last one received, marked
// "(incomplete)", never a lower bound ("at least") it cannot prove
test('the token line under the context bar and the ring percentage read "(incomplete)", not "at least", when the agent\'s session lost events', () => {
  const opts: DrawOpts = { reducedMotion: true, zoom: 1, showCost: false, showStats: false, replayLost: lossOf(4) }
  // 190k of 200k: the ring draws its percentage too
  const a = agent({ tokensUsed: 190_000 })
  const lossy: string[] = []
  drawAgents(recordingCtx(lossy), new Map([['s1:main', a]]), null, null, true, 0, opts)
  assert.ok(lossy.includes('190k / 200k tokens (incomplete)'), JSON.stringify(lossy))
  assert.ok(lossy.includes('95% (incomplete)'), JSON.stringify(lossy))
  assert.equal(lossy.some(t => /at least (190k|95%)/.test(t)), false, JSON.stringify(lossy))
  const plain: string[] = []
  drawAgents(recordingCtx(plain), new Map([['s1:main', a]]), null, null, true, 0, { ...opts, replayLost: undefined })
  assert.ok(plain.includes('190k / 200k tokens'), JSON.stringify(plain))
  assert.ok(plain.includes('95%'), JSON.stringify(plain))
  const other: string[] = []
  drawAgents(recordingCtx(other), new Map([['s1:main', a]]), null, null, true, 0, { ...opts, replayLost: new Map([['s9', 3]]) })
  assert.ok(other.includes('190k / 200k tokens'), 'the loss of another session is not this agent\'s')
})

test('the label block reserves the width of the qualified token line', () => {
  const a = agent({ tokensUsed: 190_000, tokensMaxAssumed: true })
  const measure = (t: string) => estimateTextWidth(t, 11)
  const options = { showSession: false, orchestrator: orchestratorInfo(a), details: true }
  const plain = agentLabelBlock(a, 20, measure, options)
  const lossy = agentLabelBlock(a, 20, measure, { ...options, replayLost: lossOf(2) })
  assert.ok(lossy.w > plain.w, `${lossy.w} > ${plain.w}`)
})
