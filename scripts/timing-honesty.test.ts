// Honesty and integration fixes of the "timing" batch (#108, #109): never show what cannot be proven.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent, Edge } from '../web/lib/agent-types'
import { isPseudoModel } from '../web/lib/model-provenance'
import { SessionModelTracker } from '../web/lib/session-model'
import { modelCostRate } from '../web/lib/cost'
import { MODEL_FAMILY_CONTEXT } from '../web/lib/canvas-constants'
import { COLORS } from '../web/lib/colors'
import { agentTreeSignature } from '../web/lib/row-sync'
import { drawDelegationPath } from '../web/components/agent-visualizer/canvas/delegation-path'
import { UNVERIFIED_DASH } from '../web/components/agent-visualizer/canvas/edge-style'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: (m?: string) => (m && /opus-4/.test(m) ? 1_000_000 : 200_000),
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

test('#109 a pseudo-model such as <synthetic> is not a model that ran', () => {
  assert.equal(isPseudoModel('<synthetic>'), true)
  assert.equal(isPseudoModel(''), true)
  assert.equal(isPseudoModel('claude-opus-4-6'), false)
})

test('#109 model_detected with <synthetic> leaves the model, its provenance and the window untouched', () => {
  const s = run([
    { ...spawn, payload: { ...spawn.payload, model: 'opus', modelSource: 'requested' } },
    { type: 'model_detected', payload: { agent: 'orchestrator', model: '<synthetic>' } },
  ])
  const a = s.agents.get(key)!
  assert.equal(a.model, 'opus')
  assert.equal(a.modelSource, 'requested')
  assert.equal(a.modelsUsed, undefined)
})

test('#109 the session model tracker ignores <synthetic>', () => {
  const t = new SessionModelTracker()
  t.ingest({ type: 'model_detected', sessionId: 's', payload: { agent: 'main', model: 'claude-opus-4-6' } })
  assert.equal(t.ingest({ type: 'model_detected', sessionId: 's', payload: { agent: 'main', model: '<synthetic>' } }), false)
  assert.equal(t.modelOf('s'), 'claude-opus-4-6')
})

test('#109 a model_detected that reports no effort clears the previous one', () => {
  const s = run([
    spawn,
    { type: 'model_detected', payload: { agent: 'orchestrator', model: 'gpt-5', effort: 'high' } },
    { type: 'model_detected', payload: { agent: 'orchestrator', model: 'gpt-5-mini' } },
  ])
  assert.equal(s.agents.get(key)!.effort, undefined)
  assert.equal(s.agents.get(key)!.model, 'gpt-5-mini')
})

test('#109 a model_detected with an effort sets it', () => {
  const s = run([spawn, { type: 'model_detected', payload: { agent: 'orchestrator', model: 'gpt-5', effort: 'high' } }])
  assert.equal(s.agents.get(key)!.effort, 'high')
})

test('#109 a cancelled tool call is not a tool error, an errored one is', () => {
  const round = (outcome: Record<string, unknown>) => run([
    spawn,
    { type: 'tool_call_start', payload: { agent: 'orchestrator', tool: 'Bash', args: 'x', toolUseId: 't1' } },
    { type: 'tool_call_end', payload: { agent: 'orchestrator', tool: 'Bash', result: 'r', toolUseId: 't1', ...outcome } },
  ])
  const cancelled = round({ outcome: 'cancelled' })
  assert.equal(cancelled.agents.get(key)!.toolErrors, 0)
  assert.equal(cancelled.agents.get(key)!.state, 'thinking')
  assert.equal(Array.from(cancelled.toolCalls.values())[0].errorMessage, undefined)
  const block = cancelled.timelineEntries.get(key)!.blocks.find(b => b.label.endsWith('CANCELLED'))!
  assert.notEqual(block.color, COLORS.error, 'cancelled is not drawn as an error')
  const failed = round({ outcome: 'failed', errorMessage: 'boom' })
  assert.equal(failed.agents.get(key)!.toolErrors, 1)
  assert.equal(failed.timelineEntries.get(key)!.blocks.find(b => b.label.endsWith('FAILED'))!.color, COLORS.error)
})

test('#109 a bare model alias (opus, haiku, sonnet) is priced and sized as its family', () => {
  assert.equal(modelCostRate('haiku'), 2)
  assert.equal(modelCostRate('opus'), 10)
  assert.equal(modelCostRate('claude-haiku-4-5'), 2)
  assert.equal(modelCostRate('totally-unknown'), 6)
  const ctxSize = (m: string) => MODEL_FAMILY_CONTEXT.find(f => f.pattern.test(m))?.size
  assert.equal(ctxSize('opus'), ctxSize('claude-opus-4-6'))
  assert.equal(ctxSize('some-opusine-thing'), undefined, 'only the whole alias matches')
})

function drawRecorder() {
  const log: string[] = []
  const state = { shadowBlur: -1, globalAlpha: -1 }
  const ctx = new Proxy({}, {
    get: (_t, k) => {
      if (k === 'setLineDash') return (d: number[]) => log.push(`dash:${d.join(',')}`)
      if (k === 'stroke') return () => log.push(`stroke:blur=${state.shadowBlur}:alpha=${state.globalAlpha}`)
      return typeof k === 'string' ? () => {} : undefined
    },
    set: (_t, k, v) => { if (k === 'shadowBlur' || k === 'globalAlpha') (state as Record<string, number>)[k as string] = v as number; return true },
  }) as unknown as CanvasRenderingContext2D
  return { ctx, log }
}

test('#109 the delegation path draws an unverified hop dashed and dim, a verified hop solid', () => {
  const ag = (id: string, x: number) => [id, { id, x, y: 0, opacity: 1 }] as const
  const agents = new Map([ag('root', 0), ag('a', 100), ag('b', 200)]) as never
  const edge = (from: string, to: string, verified?: boolean): Edge => ({ id: `${from}>${to}`, from, to, type: 'parent-child', opacity: 1, verified })
  const { ctx, log } = drawRecorder()
  drawDelegationPath(ctx, [edge('root', 'a', true), edge('a', 'b', false)], agents, new Map(), 0, true)
  assert.deepEqual(log.filter(l => l.startsWith('dash')), ['dash:', `dash:${UNVERIFIED_DASH.join(',')}`])
  const strokes = log.filter(l => l.startsWith('stroke'))
  assert.equal(strokes[0], 'stroke:blur=8:alpha=1')
  assert.equal(strokes[1], 'stroke:blur=0:alpha=0.6')
})

test('#108 the row signature covers tokenStatus and tokensEstimated, which the row displays', () => {
  const agent = { id: 'a', name: 'a', state: 'thinking', tokensUsed: 4000, tokensReported: true, model: 'm' }
  const node = (over: Record<string, unknown>) => ({ agent: { ...agent, ...over }, children: [] }) as never
  const base = agentTreeSignature(node({ tokenStatus: 'available' }), 0)
  assert.notEqual(agentTreeSignature(node({ tokenStatus: 'partial' }), 0), base)
  assert.notEqual(agentTreeSignature(node({ tokenStatus: 'available', tokensEstimated: true }), 0), base)
})

test('#108 the reason of an unverified link is given in the accessible relation', () => {
  const agents = new Map([
    ['main', { id: 'main', name: 'main', state: 'idle', isMain: true, parentId: null, x: 0, y: 0, tokensUsed: 0, toolCalls: 0 }],
    ['kid', { id: 'kid', name: 'kid', state: 'idle', isMain: false, parentId: 'main', x: 0, y: 0, tokensUsed: 0, toolCalls: 0 }],
  ]) as never
  const edges = [{ id: 'main>kid', from: 'main', to: 'kid', type: 'parent-child', opacity: 1, verified: false, unverifiedReason: 'parent-fallback' }] as Edge[]
  const model = buildA11yModel(agents, new Map(), [], new Map(), { edges } as never)
  const kid = model.agents.find(a => a.id === 'kid')!
  assert.equal(kid.relation, 'child of main (unverified link: parent unknown, attached to the main agent)')
})
