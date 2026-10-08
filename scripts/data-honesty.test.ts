import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import { usageFromAgent, combineUsage, formatTokenUsage, formatCostUsage, USAGE_LABELS } from '../web/lib/usage'
import { agentCostUsage, totalCostUsage } from '../web/lib/cost'
import type { SimulationEvent } from '../web/lib/agent-types'
import { buildLinkPanelModel } from '../web/components/agent-visualizer/canvas/link-panel-model'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'> & { time?: number }>): SimulationState {
  let state = createEmptyState()
  for (const e of events) {
    const time = e.time ?? 1
    state = processEvent({ time, type: e.type, payload: e.payload }, { ...state, currentTime: time }, ctx)
  }
  return state
}

const key = agentKeyOf('default', 'orchestrator')
const spawn = { type: 'agent_spawn' as const, payload: { name: 'orchestrator', isMain: true }, time: 0 }
const toolRound = (tool: string, end: Record<string, unknown>, toolUseId: string) => [
  { type: 'tool_call_start' as const, payload: { agent: 'orchestrator', tool, args: 'x', toolUseId } },
  { type: 'tool_call_end' as const, payload: { agent: 'orchestrator', tool, result: 'r', toolUseId, ...end } },
]

test('a fresh agent has no token data: unavailable, not 0', () => {
  const a = run([spawn]).agents.get(key)!
  assert.deepEqual(usageFromAgent(a), { value: null, status: 'unavailable', estimated: false })
})

test('a tool end without tokenCost keeps the tool figure null (absent, not 0) and the agent unavailable', () => {
  const s = run([spawn, ...toolRound('WebSearch', {}, 't1')])
  assert.equal(Array.from(s.toolCalls.values())[0].tokenCost, null)
  assert.equal(usageFromAgent(s.agents.get(key)!).status, 'unavailable')
})

test('an explicit 0 is a value: exact zero, available', () => {
  const s = run([spawn, ...toolRound('Bash', { tokenCost: 0, tokenSource: 'reported' }, 't1')])
  assert.equal(Array.from(s.toolCalls.values())[0].tokenCost, 0)
  assert.deepEqual(usageFromAgent(s.agents.get(key)!), { value: 0, status: 'available', estimated: false })
})

test('exact case: every figure reported => available, not estimated', () => {
  const s = run([spawn, ...toolRound('Read', { tokenCost: 100, tokenSource: 'reported' }, 't1'), ...toolRound('Read', { tokenCost: 50, tokenSource: 'reported' }, 't2')])
  assert.deepEqual(usageFromAgent(s.agents.get(key)!), { value: 150, status: 'available', estimated: false })
})

test('estimated case: an estimated figure raises the estimated badge', () => {
  const s = run([spawn, ...toolRound('Read', { tokenCost: 100, tokenSource: 'estimated' }, 't1')])
  assert.deepEqual(usageFromAgent(s.agents.get(key)!), { value: 100, status: 'available', estimated: true })
})

test('partial case: a missing figure among known ones makes the total a lower bound', () => {
  const s = run([spawn, ...toolRound('Read', { tokenCost: 100 }, 't1'), ...toolRound('WebSearch', {}, 't2'), ...toolRound('Read', { tokenCost: 20 }, 't3')])
  const u = usageFromAgent(s.agents.get(key)!)
  assert.equal(u.value, 120)
  assert.equal(u.status, 'partial')
  assert.equal(formatTokenUsage(u), `${USAGE_LABELS.atLeast} 120 ${USAGE_LABELS.estimated}`)
})

test('a gap before the first known figure still makes the total partial', () => {
  const s = run([spawn, ...toolRound('WebSearch', {}, 't1'), ...toolRound('Read', { tokenCost: 30, tokenSource: 'reported' }, 't2')])
  assert.equal(usageFromAgent(s.agents.get(key)!).status, 'partial')
})

test('context_update gives an absolute figure that supersedes the running sum and its gaps', () => {
  const s = run([
    spawn, ...toolRound('WebSearch', {}, 't1'),
    { type: 'context_update', payload: { agent: 'orchestrator', tokens: 5000, tokenSource: 'reported' } },
  ])
  assert.deepEqual(usageFromAgent(s.agents.get(key)!), { value: 5000, status: 'available', estimated: false })
})

test('a context_update without a usable figure does not reset the counter to 0', () => {
  const s = run([
    spawn,
    { type: 'context_update', payload: { agent: 'orchestrator', tokens: 5000 } },
    { type: 'context_update', payload: { agent: 'orchestrator', breakdown: { systemPrompt: 1, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 } } },
  ])
  assert.equal(s.agents.get(key)!.tokensUsed, 5000)
})

test('totals across agents: unavailable agents make the fleet total partial', () => {
  const s = run([
    spawn,
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
    { type: 'context_update', payload: { agent: 'orchestrator', tokens: 1_000_000, tokenSource: 'reported' } },
  ])
  const total = combineUsage(Array.from(s.agents.values()).map(usageFromAgent))
  assert.equal(total.status, 'partial')
  assert.equal(total.value, 1_000_000)
  const cost = totalCostUsage(s.agents.values())
  assert.equal(cost.status, 'partial')
  assert.ok(cost.value !== null && cost.value > 0)
  assert.match(formatCostUsage(cost), new RegExp(`^${USAGE_LABELS.atLeast} `))
})

test('cost of an agent with no data is unavailable, not $0', () => {
  const a = run([spawn]).agents.get(key)!
  assert.equal(agentCostUsage(a).value, null)
  assert.equal(formatCostUsage(agentCostUsage(a)), USAGE_LABELS.unavailable)
})

test('no agents at all: nothing known', () => {
  assert.equal(totalCostUsage([]).status, 'unavailable')
})

// ── Cuts at ingestion are recorded, never silent (#128) ──
test('a prompt, a report and a message over the ingestion cap carry the number of characters cut', () => {
  const s = run([
    spawn,
    { type: 'subagent_dispatch', payload: { parent: 'orchestrator', child: 'worker', task: 't', prompt: 'p'.repeat(12_000), toolUseId: 'toolu_1' } },
    { type: 'subagent_return', payload: { parent: 'orchestrator', child: 'worker', summary: 'r'.repeat(9_000), toolUseId: 'toolu_1' } },
    { type: 'message_sent', payload: { from: 'worker', to: 'orchestrator', content: 'm'.repeat(4_500) } },
    { type: 'message_sent', payload: { from: 'worker', to: 'orchestrator', content: 'm'.repeat(4_000) } },
  ])
  const links = Array.from(s.links.values())
  const spawnLink = links.find(l => l.kind === 'spawn')!
  const byType = (t: string) => spawnLink.messages.find(m => m.type === t)!
  assert.equal(byType('dispatch').content.length, 4000)
  assert.equal(byType('dispatch').cutChars, 8_000)
  assert.equal(byType('return').cutChars, 5_000)
  const conv = Array.from(s.conversations.values()).flat()
  assert.ok(conv.some(m => m.type === 'dispatch' && m.cutChars === 8_000))
  assert.ok(conv.some(m => m.type === 'return' && m.cutChars === 5_000))
  const tm = links.find(l => l.kind === 'teammate')!.messages
  assert.equal(tm[0].cutChars, 500)
  assert.equal(tm[1].cutChars, undefined) // exactly at the cap: nothing was lost

  const model = buildLinkPanelModel(spawnLink, s.agents)
  assert.equal(model.entries.find(e => e.type === 'dispatch')!.truncatedChars, 8_000)
  assert.equal(model.entries.find(e => e.type === 'return')!.truncatedChars, 5_000)
})
