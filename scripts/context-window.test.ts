import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { contextWindowSize, contextWindowAssumed, windowCoveringUsage, formatContextWindow } from '../web/lib/context-window'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { Agent, SimulationEvent } from '../web/lib/agent-types'
import { contextPercentLabel, contextPercentColor } from '../web/components/agent-visualizer/canvas/overlay-metrics'
import { SCENE } from '../web/lib/colors'

describe('contextWindowSize (#249)', () => {
  it('reads the family table, newest ids included', () => {
    assert.equal(contextWindowSize('claude-opus-4-6', false), 1_000_000)
    assert.equal(contextWindowSize('claude-haiku-4-5-20251001', false), 200_000)
    assert.equal(contextWindowSize('gpt-5-codex', false), 400_000)
  })
  it('CLAUDE_CODE_DISABLE_1M_CONTEXT caps every window to 200k, known or not', () => {
    assert.equal(contextWindowSize('claude-opus-4-6', true), 200_000)
    assert.equal(contextWindowSize(undefined, true), 200_000)
    assert.equal(contextWindowSize('claude-sonnet-4-5[1m]', true), 200_000)
  })
  it('an explicit [1m] suffix means a 1M window, even for a family below that', () => {
    assert.equal(contextWindowSize('claude-haiku-4-5[1m]', false), 1_000_000)
    assert.equal(contextWindowSize('CLAUDE-SONNET-4-5[1M]', false), 1_000_000)
  })
  it('an unknown model keeps the 200k default; no model at all keeps the 1M fallback', () => {
    assert.equal(contextWindowSize('some-new-model', false), 200_000)
    assert.equal(contextWindowSize(undefined, false), 1_000_000)
  })
  it('the cap also applies to a window above 200k that is not 1M', () => {
    assert.equal(contextWindowSize('gpt-5-codex', true), 200_000)
  })
})

describe('windowCoveringUsage (#249)', () => {
  it('keeps the window while the usage fits in it', () => {
    assert.equal(windowCoveringUsage(200_000, 150_000), 200_000)
    assert.equal(windowCoveringUsage(200_000, 200_000), 200_000)
  })
  it('a window cannot be smaller than what was used: it grows to the next known size', () => {
    assert.equal(windowCoveringUsage(200_000, 340_000), 1_000_000)
  })
  it('beyond every known size, the usage itself is the only proven bound', () => {
    assert.equal(windowCoveringUsage(200_000, 1_250_000), 1_250_000)
  })
  it('ignores a missing or invalid usage', () => {
    assert.equal(windowCoveringUsage(200_000, 0), 200_000)
    assert.equal(windowCoveringUsage(200_000, Number.NaN), 200_000)
  })
})

describe('contextWindowAssumed (#364)', () => {
  it('a window from a model id the table knows, a [1m] suffix or the 200k cap is not flagged', () => {
    assert.equal(contextWindowAssumed('claude-opus-4-6', false), false)
    assert.equal(contextWindowAssumed('claude-haiku-4-5[1m]', false), false)
    assert.equal(contextWindowAssumed('gpt-5-codex', false), false)
    assert.equal(contextWindowAssumed('some-new-model', true), false)
    assert.equal(contextWindowAssumed(undefined, true), false)
  })
  it('an unknown model (200k default) or no model at all (1M fallback) is an assumed window', () => {
    assert.equal(contextWindowAssumed('some-new-model', false), true)
    assert.equal(contextWindowAssumed(undefined, false), true)
    assert.equal(contextWindowAssumed('', false), true)
  })
})

describe('formatContextWindow (#364)', () => {
  it('says "assumed" next to a window that is not known', () => {
    assert.equal(formatContextWindow({ tokensMax: 200_000, tokensMaxAssumed: true }), '200k assumed')
    assert.equal(formatContextWindow({ tokensMax: 200_000 }), '200k')
    assert.equal(formatContextWindow({ tokensMax: 200_000, tokensMaxAssumed: false }), '200k')
  })
})

describe('ring percentage on an assumed window (#364)', () => {
  const agent = (over: Record<string, unknown>) => ({ tokensUsed: 190_000, tokenStatus: 'available', tokensMax: 200_000, ...over }) as unknown as Agent
  it('says "assumed" next to the percentage', () => {
    assert.equal(contextPercentLabel(agent({}), 0.95), '95%')
    assert.equal(contextPercentLabel(agent({ tokensMaxAssumed: true }), 0.95), '95% assumed')
  })
  it('never colours an assumed window as critical or warning', () => {
    assert.equal(contextPercentColor(0.95, false), SCENE.error)
    assert.equal(contextPercentColor(0.95, true), SCENE.textDim)
    assert.equal(contextPercentColor(0.8, true), SCENE.textDim)
  })
})

describe('the assumed flag follows the events (#364)', () => {
  const ctx: ProcessEventContext = {
    syncForceSimulation: () => {},
    findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: (m?: string) => contextWindowSize(m, false),
    isContextWindowAssumed: (m?: string) => contextWindowAssumed(m, false),
    blockIdCounter: { current: 0 },
    skipForceSync: true,
  }
  function run(events: Array<Pick<SimulationEvent, 'type' | 'payload'>>): SimulationState {
    let state = createEmptyState()
    for (const e of events) state = processEvent({ time: 1, type: e.type, payload: e.payload }, { ...state, currentTime: 1 }, ctx)
    return state
  }
  const main = (s: SimulationState) => s.agents.get('default:main')!

  it('an agent spawned without a model has an assumed window; a known model clears it', () => {
    const s = run([{ type: 'agent_spawn', payload: { name: 'main', isMain: true } }])
    assert.equal(main(s).tokensMaxAssumed, true)
    const t = run([{ type: 'agent_spawn', payload: { name: 'main', isMain: true, model: 'claude-opus-4-6' } }])
    assert.equal(main(t).tokensMaxAssumed, false)
    const u = run([
      { type: 'agent_spawn', payload: { name: 'main', isMain: true } },
      { type: 'model_detected', payload: { agent: 'main', model: 'claude-opus-4-6' } },
    ])
    assert.equal(main(u).tokensMaxAssumed, false)
  })
  it('a model the table does not know keeps the window assumed', () => {
    const s = run([
      { type: 'agent_spawn', payload: { name: 'main', isMain: true } },
      { type: 'model_detected', payload: { agent: 'main', model: 'mystery-9' } },
    ])
    assert.equal(main(s).tokensMax, 200_000)
    assert.equal(main(s).tokensMaxAssumed, true)
  })
  it('a window reported by the runtime is not assumed', () => {
    const s = run([
      { type: 'agent_spawn', payload: { name: 'main', isMain: true } },
      { type: 'context_update', payload: { agent: 'main', tokens: 5_000, tokensMax: 272_000 } },
    ])
    assert.equal(main(s).tokensMax, 272_000)
    assert.equal(main(s).tokensMaxAssumed, false)
  })
  it('a known window that a reading overflows was wrong: the grown window is assumed', () => {
    const s = run([
      { type: 'agent_spawn', payload: { name: 'main', isMain: true, model: 'claude-haiku-4-5' } },
      { type: 'context_update', payload: { agent: 'main', tokens: 340_000 } },
    ])
    assert.equal(main(s).tokensMax, 1_000_000)
    assert.equal(main(s).tokensMaxAssumed, true)
  })
})
