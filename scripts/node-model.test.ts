/** Model, provenance and reasoning effort per agent (#60). */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: (m?: string) => (m && m.includes('opus') ? 1_000_000 : 200_000),
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'>>): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent({ time: 1, ...e }, { ...state, currentTime: 1 }, ctx)
  return state
}

const main = { type: 'agent_spawn' as const, payload: { name: 'orchestrator', isMain: true } }
const KEY = 'default:worker'

test('a spawn model without a source is only "requested"', () => {
  const s = run([main, { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', model: 'sonnet' } }])
  const a = s.agents.get(KEY)!
  assert.equal(a.model, 'sonnet')
  assert.equal(a.modelSource, 'requested')
})

test('requestedModel on a spawn is kept apart and shown as the model until the runtime reports', () => {
  const s = run([main, { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', requestedModel: 'opus', subagentType: 'frontend-engineer' } }])
  const a = s.agents.get(KEY)!
  assert.equal(a.requestedModel, 'opus')
  assert.equal(a.model, 'opus')
  assert.equal(a.modelSource, 'requested')
  assert.equal(a.subagentType, 'frontend-engineer')
  assert.equal(a.modelsUsed, undefined)
})

test('a configured model replaces a requested one', () => {
  const s = run([main, { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', requestedModel: 'opus', model: 'claude-sonnet-4-6', modelSource: 'configured' } }])
  const a = s.agents.get(KEY)!
  assert.equal(a.model, 'claude-sonnet-4-6')
  assert.equal(a.modelSource, 'configured')
  assert.equal(a.requestedModel, 'opus')
})

test('model_detected is the runtime source and outranks requested and configured', () => {
  const s = run([
    main,
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', requestedModel: 'opus' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'claude-haiku-4-5' } },
  ])
  const a = s.agents.get(KEY)!
  assert.equal(a.model, 'claude-haiku-4-5')
  assert.equal(a.modelSource, 'runtime')
  assert.equal(a.requestedModel, 'opus')
  assert.deepEqual(a.modelsUsed, ['claude-haiku-4-5'])
})

test('a late requested/configured spawn never hides the model that ran', () => {
  const s = run([
    main,
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'claude-haiku-4-5' } },
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', requestedModel: 'opus', model: 'sonnet', modelSource: 'configured' } },
  ])
  const a = s.agents.get(KEY)!
  assert.equal(a.model, 'claude-haiku-4-5')
  assert.equal(a.modelSource, 'runtime')
  assert.equal(a.requestedModel, 'opus')
})

test('every model that really ran is listed once, in order', () => {
  const s = run([
    main,
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', requestedModel: 'opus' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'm-a' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'm-b' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'm-a' } },
  ])
  assert.deepEqual(s.agents.get(KEY)!.modelsUsed, ['m-a', 'm-b'])
})

test('context window follows the shown model only when the model changes', () => {
  const s = run([
    main,
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'claude-opus-4-6' } },
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', requestedModel: 'haiku' } },
  ])
  assert.equal(s.agents.get(KEY)!.tokensMax, 1_000_000)
})

test('effort is shown only when configured and valid', () => {
  const none = run([main, { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } }])
  assert.equal(none.agents.get(KEY)!.effort, undefined)
  const bad = run([main, { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', effort: 'ludicrous' } }])
  assert.equal(bad.agents.get(KEY)!.effort, undefined)
  const spawn = run([main, { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', effort: 'High' } }])
  assert.equal(spawn.agents.get(KEY)!.effort, 'high')
  const detected = run([
    main,
    { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'gpt-5', effort: 'medium' } },
    { type: 'model_detected', payload: { agent: 'worker', model: 'gpt-5' } },
  ])
  assert.equal(detected.agents.get(KEY)!.effort, 'medium')
})

test('an untrusted model source is ignored (treated as requested)', () => {
  const s = run([main, { type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator', model: 'x', modelSource: 'runtime-ish' } }])
  assert.equal(s.agents.get(KEY)!.modelSource, 'requested')
})
