/** Usage attribution (#61): a usage belongs to an agent only when it addresses exactly one; the rest is shown apart. */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'
import {
  resolveUsageTarget, summarizeCosts, addUnattributed, MAX_UNATTRIBUTED_KEYS, OVERFLOW_KEY,
} from '../web/lib/attribution'
import { agentCost } from '../web/lib/cost'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string }
function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent({ time: 1, ...e }, { ...state, currentTime: 1 }, ctx)
  return state
}

const main: Ev = { type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } }
const spawn = (name: string, toolUseId?: string): Ev => ({ type: 'agent_spawn', payload: { name, parent: 'orchestrator', ...(toolUseId ? { toolUseId } : {}) } })
const toolEnd = (agent: string, tokenCost: number, sessionId?: string): Ev => ({
  type: 'tool_call_end', sessionId, payload: { agent, tool: 'Read', result: 'ok', tokenCost },
})
const ctxUpdate = (agent: string, tokens: number): Ev => ({ type: 'context_update', payload: { agent, tokens } })

test('a usage addressed to one known agent is attributed to it', () => {
  const s = run([main, spawn('worker'), toolEnd('worker', 500)])
  assert.equal(s.agents.get('default:worker')!.tokensUsed, 500)
  assert.equal(s.unattributed.size, 0)
})

test('a usage for an agent that does not exist is counted apart, not lost and not guessed', () => {
  const s = run([main, toolEnd('ghost', 700), ctxUpdate('ghost2', 900)])
  assert.equal(s.agents.get('default:orchestrator')!.tokensUsed, 0)
  const sum = summarizeCosts(s.agents.values(), s.unattributed.values())
  assert.equal(sum.attributedTokens, 0)
  assert.equal(sum.unattributedTokens, 1600)
  assert.equal(s.unattributed.get('default:ghost')!.reason, 'orphan')
})

test('a name shared by two instances is ambiguous: neither instance receives the usage', () => {
  const s = run([main, spawn('worker', 'toolu_1'), spawn('worker', 'toolu_2'), toolEnd('worker', 400), ctxUpdate('worker', 1000)])
  assert.ok(s.agents.has('default:worker'))
  assert.ok(s.agents.has('default:worker@toolu_2'))
  assert.equal(s.agents.get('default:worker')!.tokensUsed, 0)
  assert.equal(s.agents.get('default:worker@toolu_2')!.tokensUsed, 0)
  assert.equal(s.unattributed.get('default:worker')!.reason, 'ambiguous')
  assert.equal(s.unattributed.get('default:worker')!.tokens, 1000)
})

test('the instance addressed by its own local id is unambiguous', () => {
  const s = run([main, spawn('worker', 'toolu_1'), spawn('worker', 'toolu_2'), toolEnd('worker@toolu_2', 300)])
  assert.equal(s.agents.get('default:worker@toolu_2')!.tokensUsed, 300)
  assert.equal(s.unattributed.size, 0)
})

test('resolveUsageTarget: one rule, three outcomes', () => {
  const s = run([main, spawn('worker', 'toolu_1'), spawn('worker', 'toolu_2'), spawn('solo', 'toolu_3')])
  assert.equal(resolveUsageTarget(s.agents, 'default', 'solo').kind, 'attributed')
  assert.equal(resolveUsageTarget(s.agents, 'default', 'orchestrator').kind, 'attributed')
  assert.equal(resolveUsageTarget(s.agents, 'default', 'worker').kind, 'ambiguous')
  assert.equal(resolveUsageTarget(s.agents, 'default', 'nobody').kind, 'orphan')
  // Same name in another session does not make it ambiguous
  assert.equal(resolveUsageTarget(s.agents, 'other', 'worker').kind, 'orphan')
})

test('an orphan usage is handed to the agent once it appears (late binding), never twice', () => {
  const s = run([main, ctxUpdate('late', 1200), spawn('late')])
  assert.equal(s.agents.get('default:late')!.tokensUsed, 1200)
  assert.equal(s.unattributed.size, 0)
})

test('an ambiguous remainder is not handed to a later agent', () => {
  const s = run([main, spawn('worker', 'toolu_1'), spawn('worker', 'toolu_2'), toolEnd('worker', 400)])
  assert.equal(s.unattributed.size, 1)
  assert.equal(s.agents.get('default:worker')!.tokensUsed, 0)
})

test('session scoping: the unattributed entry remembers its session', () => {
  const s = run([main, toolEnd('ghost', 50, 's9')])
  assert.equal(s.unattributed.get('s9:ghost')!.sessionId, 's9')
})

test('summarizeCosts: root total + remainder = session total, priced consistently', () => {
  const s = run([main, spawn('worker'), toolEnd('worker', 1_000_000), toolEnd('ghost', 500_000)])
  const sum = summarizeCosts(s.agents.values(), s.unattributed.values())
  assert.equal(sum.attributedCost, agentCost(1_000_000, undefined))
  assert.equal(sum.unattributedCost, agentCost(500_000, undefined))
  assert.equal(sum.sessionCost, sum.attributedCost + sum.unattributedCost)
  assert.equal(sum.sessionTokens, 1_500_000)
})

test('summarizeCosts on nothing is all zeros', () => {
  const sum = summarizeCosts([], [])
  assert.deepEqual(sum, { attributedTokens: 0, attributedCost: 0, unattributedTokens: 0, unattributedCost: 0, sessionTokens: 0, sessionCost: 0 })
})

test('invalid tokens are ignored, the map is bounded and overflow is folded in one entry', () => {
  const m = new Map()
  addUnattributed(m, 's', 'k', 'orphan', -5, 'add')
  addUnattributed(m, 's', 'k', 'orphan', NaN, 'add')
  assert.equal(m.size, 0)
  for (let i = 0; i < MAX_UNATTRIBUTED_KEYS + 20; i++) addUnattributed(m, 's', `k${i}`, 'orphan', 10, 'add')
  assert.ok(m.size <= MAX_UNATTRIBUTED_KEYS + 1)
  assert.equal(m.get(OVERFLOW_KEY)!.tokens, 200)
  const total = [...m.values()].reduce((a, e) => a + e.tokens, 0)
  assert.equal(total, (MAX_UNATTRIBUTED_KEYS + 20) * 10)
})

test('a context reading that turns ambiguous after being attributed is not counted twice', () => {
  const s = run([main, spawn('w', 'toolu_1'), ctxUpdate('w', 50_000), spawn('w', 'toolu_2'), ctxUpdate('w', 60_000)])
  assert.equal(s.agents.get('default:w')!.tokensUsed, 50_000)
  const sum = summarizeCosts(s.agents.values(), s.unattributed.values())
  assert.equal(sum.unattributedTokens, 0)
  assert.equal(sum.sessionTokens, 50_000)
})

test('overflow: absolute readings of overflowed names are never accumulated', () => {
  const m = new Map()
  for (let i = 0; i < MAX_UNATTRIBUTED_KEYS; i++) addUnattributed(m, 's', `k${i}`, 'orphan', 10, 'set')
  for (let i = 0; i < 200; i++) addUnattributed(m, 's', 'late', 'orphan', 50_000, 'set')
  assert.equal(m.has(OVERFLOW_KEY), false)
  // Increments (tool cost) still fold into the overflow entry
  addUnattributed(m, 's', 'late', 'orphan', 70, 'add')
  assert.equal(m.get(OVERFLOW_KEY)!.tokens, 70)
})
