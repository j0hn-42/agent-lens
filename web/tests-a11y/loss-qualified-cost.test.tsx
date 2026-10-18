// #366: the token and cost totals (Cost panel on the canvas, spoken totals of the top bar) are lower bounds when the relay could not replay events.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { drawCostSummaryPanel } from '@/components/agent-visualizer/canvas/draw-cost'
import { replayLostForAgents, usageUnderLoss } from '@/lib/event-loss'
import { topBarContextText } from '@/lib/chrome-utils'
import type { UsageTotal } from '@/lib/usage'

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

function agent(id: string, sessionId: string): any {
  return {
    id, agentKey: id, sessionId, localId: id, name: id, state: 'thinking', parentId: null,
    tokensUsed: 120000, tokensMax: 200000, model: 'claude-sonnet-4', tokenStatus: 'available', tokensEstimated: false,
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    x: 0, y: 0, isMain: true, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [],
  }
}
const exact: UsageTotal = { value: 120000, status: 'available', estimated: false }

test('usageUnderLoss: a complete figure becomes a lower bound, nothing else changes', () => {
  assert.deepEqual(usageUnderLoss(exact, 3), { value: 120000, status: 'partial', estimated: false })
  assert.equal(usageUnderLoss(exact, 0), exact)
  const none: UsageTotal = { value: null, status: 'unavailable', estimated: false }
  assert.equal(usageUnderLoss(none, 3), none)
  const est: UsageTotal = { value: 5, status: 'available', estimated: true }
  assert.deepEqual(usageUnderLoss(est, 1), { value: 5, status: 'partial', estimated: true })
})

test('replayLostForAgents: sessions the agents belong to, each once, never the whole tally', () => {
  const lost = new Map([['s1', 4], ['s9', 100]])
  assert.equal(replayLostForAgents(lost, [agent('a', 's1'), agent('b', 's1'), agent('c', 's2')]), 4)
  assert.equal(replayLostForAgents(lost, [agent('c', 's2')]), 0)
  assert.equal(replayLostForAgents(undefined, [agent('a', 's1')]), 0)
})

test('the Cost panel: header totals and rows read "at least" for a session with lost events, plain otherwise', () => {
  const agents = new Map<string, any>([['a', agent('a', 's1')], ['b', agent('b', 's2')]])
  const plain: string[] = []
  drawCostSummaryPanel(recordingCtx(plain), agents, new Map())
  assert.ok(!plain.some(t => /at least/.test(t)), `no loss, no noise: ${JSON.stringify(plain)}`)

  const texts: string[] = []
  drawCostSummaryPanel(recordingCtx(texts), agents, new Map(), [], false, new Map([['s1', 5]]))
  assert.ok(texts.some(t => /^at least ~\$/.test(t)), `header cost qualified: ${JSON.stringify(texts)}`)
  assert.ok(texts.some(t => /^at least .* ctx tokens$/.test(t)), `header tokens qualified: ${JSON.stringify(texts)}`)
  const costs = texts.filter(t => /^(at least )?~\$/.test(t))
  assert.equal(costs.filter(t => t.startsWith('at least')).length, 2, `header and the row of the lossy session: ${JSON.stringify(costs)}`)
  assert.ok(costs.some(t => !t.startsWith('at least')), 'the agent of the intact session keeps its plain figure')
})

// The wiring of the top bar (index.tsx -> TopBar) is tested in loss-qualified-wiring.test.tsx; this is only the wording helper
test('topBarContextText words a lower-bound usage "at least", an exact one plainly', () => {
  const cost: UsageTotal = { value: 2.1, status: 'available', estimated: true }
  const t = topBarContextText(usageUnderLoss(exact, 2), usageUnderLoss(cost, 2))
  assert.match(t.tokens, /^at least 120k tokens in context$/)
  assert.match(t.spoken, /at least/)
  const clean = topBarContextText(exact, cost)
  assert.doesNotMatch(clean.tokens + clean.spoken, /at least/)
})
