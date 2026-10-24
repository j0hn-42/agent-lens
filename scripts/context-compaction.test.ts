// Context compactions (#232), web side: a `context_compacted` event becomes a COMPACTED row of the
// Conversation panel that says only what the transcript proves (trigger, size before), and says so
// when a value is not reported. The compaction cost has no source: it is always "not reported".
import { test } from 'node:test'
import { readReadingGuideDomains } from './reading-guide'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'
import { readCompaction, compactionText, COMPACTION_LABEL } from '../web/lib/compaction'
import { FEED_MESSAGE_TYPES, TOOL_MESSAGE_TYPES, buildFeedMessages, latestFeedMessage } from '../web/lib/feed-utils'
import { AGENT_EVENT_TYPES, SessionNormalizer } from '../web/lib/event-normalize'
import { ROLE_COLORS } from '../web/lib/colors'

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
    state = processEvent({ time, type: e.type, payload: e.payload, sessionId: 's1' }, { ...state, currentTime: time }, ctx)
  }
  return state
}

const main = agentKeyOf('s1', 'orchestrator')
const spawn = { type: 'agent_spawn' as const, payload: { name: 'orchestrator', isMain: true } }

test('readCompaction keeps only a known trigger and a positive whole size', () => {
  assert.deepEqual(readCompaction({ trigger: 'auto', preTokens: 154321 }), { trigger: 'auto', preTokens: 154321 })
  assert.deepEqual(readCompaction({ trigger: 'manual' }), { trigger: 'manual' })
  assert.deepEqual(readCompaction({}), {})
  for (const bad of [{ trigger: 'AUTO' }, { trigger: 3 }, { preTokens: -1 }, { preTokens: 0 }, { preTokens: 1.5 }, { preTokens: '100' }, { preTokens: Number.NaN }, { preTokens: Infinity }]) {
    assert.deepEqual(readCompaction(bad), {}, JSON.stringify(bad))
  }
})

test('compactionText states the trigger and the size before, or says they are not reported; never a cost', () => {
  assert.equal(compactionText({ trigger: 'auto', preTokens: 154321 }),
    'Context compacted (automatic). Size before: 154,321 tokens, reported by the runtime. Cost not reported.')
  assert.equal(compactionText({ trigger: 'manual' }),
    'Context compacted (manual, /compact). Size before not reported. Cost not reported.')
  assert.equal(compactionText({}),
    'Context compacted (trigger not reported). Size before not reported. Cost not reported.')
  assert.equal(COMPACTION_LABEL, 'COMPACTED')
  assert.equal(ROLE_COLORS.compaction.label, COMPACTION_LABEL)
})

test('a context_compacted event adds one compaction row at its time, without touching the agent state', () => {
  const before = run([spawn])
  const s = run([spawn, { type: 'context_compacted', payload: { agent: 'orchestrator', trigger: 'auto', preTokens: 1000 }, time: 7 }])
  const rows = s.conversations.get(main)!
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, 'compaction')
  assert.equal(rows[0].timestamp, 7)
  assert.deepEqual(rows[0].compaction, { trigger: 'auto', preTokens: 1000 })
  assert.equal(rows[0].content, compactionText({ trigger: 'auto', preTokens: 1000 }))
  const a = s.agents.get(main)!
  assert.equal(a.state, before.agents.get(main)!.state)
  assert.deepEqual(a.messageBubbles, before.agents.get(main)!.messageBubbles)
})

test('invalid fields of a context_compacted event are dropped, not shown', () => {
  const s = run([spawn, { type: 'context_compacted', payload: { agent: 'orchestrator', trigger: 'often', preTokens: -3 } }])
  const row = s.conversations.get(main)![0]
  assert.deepEqual(row.compaction, {})
  assert.match(row.content, /trigger not reported/)
  assert.match(row.content, /Size before not reported/)
})

test('compaction rows are conversation rows: listed with tool calls hidden, and they can be the latest one', () => {
  assert.ok(FEED_MESSAGE_TYPES.has('compaction'))
  assert.ok(!TOOL_MESSAGE_TYPES.has('compaction'))
  const s = run([
    spawn,
    { type: 'message', payload: { agent: 'orchestrator', role: 'assistant', content: 'working' }, time: 1 },
    { type: 'context_compacted', payload: { agent: 'orchestrator', trigger: 'manual' }, time: 2 },
  ])
  const feed = buildFeedMessages(s.conversations)
  assert.deepEqual(feed.map(m => m.type), ['assistant', 'compaction'])
  assert.equal(latestFeedMessage(s.conversations)?.type, 'compaction')
})

test('the bridge normalizer accepts context_compacted', () => {
  assert.ok(AGENT_EVENT_TYPES.includes('context_compacted'))
  const n = new SessionNormalizer('s1')
  const out = n.processBatch([
    { time: 1, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { time: 2, type: 'context_compacted', payload: { agent: 'orchestrator', trigger: 'auto', preTokens: 5 } },
  ])
  n.dispose()
  assert.deepEqual(out.find(e => e.type === 'context_compacted')?.payload, { agent: 'orchestrator', trigger: 'auto', preTokens: 5 })
})

test('docs/reading-the-ui.md explains the COMPACTED row and what it does not prove', async () => {
  const doc = readReadingGuideDomains()
  assert.match(doc, /## Context compactions/)
  assert.match(doc, /\*\*COMPACTED\*\*/)
  assert.match(doc, /Cost not reported/)
  assert.match(doc, /compact_boundary/)
})
