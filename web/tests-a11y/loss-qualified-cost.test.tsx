// #366, #591: the token and cost totals (Cost panel on the canvas, spoken totals of the top bar) are "(incomplete)" when the relay could not replay events:
// a context reading is absolute (a lost compaction can lower it), so the cost priced from it is no lower bound either.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import { drawCostSummaryPanel } from '@/components/agent-visualizer/canvas/draw-cost'
import { replayLostForAgents, usageUnderLoss } from '@/lib/event-loss'
import { topBarContextText } from '@/lib/chrome-utils'
import { formatCostUsage, spokenCostUsage, formatTokenUsage, type UsageTotal } from '@/lib/usage'
import { formatCost } from '@/lib/utils'
import { usageText } from '@/lib/card-text'

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

test('usageUnderLoss: a complete figure becomes incomplete (no lower bound), nothing else changes', () => {
  assert.deepEqual(usageUnderLoss(exact, 3), { value: 120000, status: 'available', estimated: false, incomplete: true })
  assert.equal(usageUnderLoss(exact, 0), exact)
  const none: UsageTotal = { value: null, status: 'unavailable', estimated: false }
  assert.equal(usageUnderLoss(none, 3), none)
  const est: UsageTotal = { value: 5, status: 'available', estimated: true }
  assert.deepEqual(usageUnderLoss(est, 1), { value: 5, status: 'available', estimated: true, incomplete: true })
  const part: UsageTotal = { value: 7, status: 'partial', estimated: false }
  assert.equal(usageUnderLoss(part, 2).incomplete, true, 'a partial figure under loss is incomplete too')
  assert.equal(formatCostUsage(usageUnderLoss(part, 2)), '~$7.00 (incomplete)', 'and says no "at least"')
  assert.equal(formatCostUsage(usageUnderLoss(est, 1)), '~$5.00 estimated (incomplete)')
  assert.equal(spokenCostUsage(usageUnderLoss(exact, 1)), 'context cost estimate $120000 (incomplete)'.replace('$120000', '$' + formatCost(120000)))
  assert.equal(formatTokenUsage(usageUnderLoss(exact, 1)), '120k (incomplete)')
  assert.equal(usageText('fr', usageUnderLoss(est, 1)), '5 estimé (incomplet)')
  assert.equal(usageText('fr', usageUnderLoss(exact, 1)), '120k (incomplet)')
})

test('replayLostForAgents: sessions the agents belong to, each once, never the whole tally', () => {
  const lost = new Map([['s1', 4], ['s9', 100]])
  assert.equal(replayLostForAgents(lost, [agent('a', 's1'), agent('b', 's1'), agent('c', 's2')]), 4)
  assert.equal(replayLostForAgents(lost, [agent('c', 's2')]), 0)
  assert.equal(replayLostForAgents(undefined, [agent('a', 's1')]), 0)
})

test('the Cost panel: header totals and rows read "(incomplete)" for a session with lost events, plain otherwise', () => {
  const agents = new Map<string, any>([['a', agent('a', 's1')], ['b', agent('b', 's2')]])
  const plain: string[] = []
  drawCostSummaryPanel(recordingCtx(plain), agents, new Map())
  assert.ok(!plain.some(t => /at least/.test(t)), `no loss, no noise: ${JSON.stringify(plain)}`)

  const texts: string[] = []
  drawCostSummaryPanel(recordingCtx(texts), agents, new Map(), [], false, new Map([['s1', 5]]))
  assert.ok(texts.some(t => /^~\$[\d.]+ \(incomplete\)$/.test(t)), `header cost qualified: ${JSON.stringify(texts)}`)
  assert.ok(texts.some(t => /^[\d.]+[kM]? ctx tokens \(incomplete\)$/.test(t)), `header tokens qualified: ${JSON.stringify(texts)}`)
  assert.ok(!texts.some(t => /at least/.test(t)), `no lower bound: ${JSON.stringify(texts)}`)
  const costs = texts.filter(t => /^~\$/.test(t))
  assert.equal(costs.filter(t => t.endsWith('(incomplete)')).length, 2, `header and the row of the lossy session: ${JSON.stringify(costs)}`)
  assert.ok(costs.some(t => !t.endsWith('(incomplete)')), 'the agent of the intact session keeps its plain figure')
})

test('the Cost panel header: a lossy session that only has unattributed usage in the view still qualifies the totals', () => {
  const agents = new Map<string, any>([['b', agent('b', 's2')]])
  const rest = [{ sessionId: 's1', reason: 'no-agent', tokens: 5000, estimated: false }] as any[]
  const texts: string[] = []
  drawCostSummaryPanel(recordingCtx(texts), agents, new Map(), rest, false, new Map([['s1', 5]]))
  assert.ok(texts.some(t => /^~\$[\d.]+ \(incomplete\)$/.test(t)), `header cost qualified: ${JSON.stringify(texts)}`)
  const intact: string[] = []
  drawCostSummaryPanel(recordingCtx(intact), agents, new Map(), rest, false, new Map([['s9', 5]]))
  assert.ok(!intact.some(t => /\(incomplete\)/.test(t)), `a loss of another session: ${JSON.stringify(intact)}`)
})

// BY TOOL rows are sums of per-call costs (each call adds, none subtracts): a lost call can only add, so "at least" IS proven there (#591)
test('the Cost panel BY TOOL rows: a call of an agent of a lossy session makes its tool a lower bound, a call of an intact one stays exact', () => {
  const agents = new Map<string, any>([['a', agent('a', 's1')], ['b', agent('b', 's2')]])
  const call = (agentId: string, toolName: string): any => ({ agentId, toolName, tokenCost: 4000, tokenSource: 'reported', state: 'complete' })
  const toolCalls = new Map<string, any>([['t1', call('a', 'Bash')], ['t2', call('b', 'Read')]])
  const texts: string[] = []
  drawCostSummaryPanel(recordingCtx(texts), agents, toolCalls, [], false, new Map([['s1', 5]]))
  const at = (name: string) => texts.indexOf(name)
  assert.ok(at('Bash') >= 0 && at('Read') >= 0, `both tools are listed: ${JSON.stringify(texts)}`)
  // The row of a tool draws its name, then its tokens and cost: the figure that follows the name
  const figureAfter = (name: string) => texts.slice(at(name) + 1).find(t => /~\$/.test(t))
  assert.match(figureAfter('Bash') ?? '', /^at least ~\$/, `lossy owner: ${JSON.stringify(texts)}`)
  assert.doesNotMatch(figureAfter('Read') ?? '', /^at least/, `intact owner: ${JSON.stringify(texts)}`)
})

// The wiring of the top bar (index.tsx -> TopBar) is tested in loss-qualified-wiring.test.tsx; this is only the wording helper
test('topBarContextText words a usage under loss "(incomplete)", an exact one plainly', () => {
  const cost: UsageTotal = { value: 2.1, status: 'available', estimated: true }
  const t = topBarContextText(usageUnderLoss(exact, 2), usageUnderLoss(cost, 2))
  assert.match(t.tokens, /^120k tokens in context \(incomplete\)$/)
  assert.match(t.spoken, /\(incomplete\)$/)
  assert.doesNotMatch(t.tokens + t.spoken, /at least/)
  const fr = topBarContextText(usageUnderLoss(exact, 2), usageUnderLoss(cost, 2), 'fr')
  assert.match(fr.spoken, /\(incomplet\)$/)
  const clean = topBarContextText(exact, cost)
  assert.doesNotMatch(clean.tokens + clean.spoken, /at least|incomplete/)
})
