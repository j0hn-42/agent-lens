import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { GUIDED_SCENARIO } from '../web/lib/guided-scenario'
import { GUIDED_STEPS, DESCRIBED_ONLY } from '../web/lib/guided-steps'
import { LEGEND_ENTRY_IDS, type LegendEntryId } from '../web/lib/legend-entries'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
const playUntil = (time: number): SimulationState => {
  let state = createEmptyState()
  for (const e of GUIDED_SCENARIO.filter(ev => ev.time <= time)) state = processEvent(e, { ...state, currentTime: e.time }, ctx)
  return state
}
const duration = GUIDED_SCENARIO[GUIDED_SCENARIO.length - 1].time

test('every legend entry is explained by at least one step', () => {
  const covered = new Set(GUIDED_STEPS.flatMap(s => s.covers))
  assert.deepEqual(LEGEND_ENTRY_IDS.filter(id => !covered.has(id)), [])
})

test('steps only cover real legend entries, and steps have an id, a title and a body', () => {
  const known = new Set<string>(LEGEND_ENTRY_IDS)
  for (const s of GUIDED_STEPS) {
    assert.ok(s.id && s.title.trim() && s.body.trim(), `step ${s.id} has text`)
    for (const c of s.covers) assert.ok(known.has(c), `${s.id} covers unknown entry ${c}`)
  }
  assert.equal(new Set(GUIDED_STEPS.map(s => s.id)).size, GUIDED_STEPS.length, 'unique step ids')
})

test('step times are non-decreasing and inside the scenario', () => {
  for (let i = 0; i < GUIDED_STEPS.length; i++) {
    assert.ok(GUIDED_STEPS[i].time >= 0 && GUIDED_STEPS[i].time <= duration, `${GUIDED_STEPS[i].id} inside [0, ${duration}]`)
    if (i > 0) assert.ok(GUIDED_STEPS[i].time >= GUIDED_STEPS[i - 1].time, `${GUIDED_STEPS[i].id} after ${GUIDED_STEPS[i - 1].id}`)
  }
})

test('agent targets exist at the time of their step', () => {
  for (const s of GUIDED_STEPS) {
    if (s.target.kind !== 'agent') continue
    const name = s.target.name
    assert.ok([...playUntil(s.time).agents.values()].some(a => a.name === name), `${s.id}: agent ${name} at t=${s.time}`)
  }
})

// What the simulation can prove is proven: a step never claims a state, runtime or context segment
// that the scenario has not produced yet at its time (CONTRIBUTING: never show an unproven state).
const STATE_OF = (id: LegendEntryId) => id.startsWith('state-') ? id.slice('state-'.length) : null
const CTX_FIELD: Partial<Record<LegendEntryId, string>> = {
  'ctx-system': 'systemPrompt', 'ctx-user': 'userMessages', 'ctx-tool-results': 'toolResults', 'ctx-reasoning': 'reasoning', 'ctx-subagent': 'subagentResults',
}
const hasContext = (field: string, time: number) => GUIDED_SCENARIO.some((e: SimulationEvent) =>
  e.type === 'context_update' && e.time <= time && Number((e.payload as { breakdown?: Record<string, number> }).breakdown?.[field] ?? 0) > 0)

test('covered states, runtimes and context segments are on screen at the step time', () => {
  for (const s of GUIDED_STEPS) {
    const state = playUntil(s.time)
    const agents = [...state.agents.values()]
    for (const id of s.covers) {
      if (DESCRIBED_ONLY.includes(id)) continue
      const st = STATE_OF(id)
      if (st) assert.ok(agents.some(a => a.state === st), `${s.id}: an agent is ${st} at t=${s.time}`)
      if (id === 'rt-codex') assert.ok(agents.some(a => a.runtime === 'codex'), `${s.id}: a Codex agent`)
      if (id === 'rt-claude') assert.ok(agents.some(a => a.runtime !== 'codex'), `${s.id}: a Claude agent`)
      const field = CTX_FIELD[id]
      if (field) assert.ok(hasContext(field, s.time), `${s.id}: context ${field} > 0`)
      if (id === 'team-row') assert.ok(state.teams.size > 0, `${s.id}: a team`)
    }
  }
})

test('DESCRIBED_ONLY entries are explained with words that say they are not on screen', () => {
  for (const id of DESCRIBED_ONLY) {
    const step = GUIDED_STEPS.find(s => s.covers.includes(id))
    assert.ok(step, `${id} is covered`)
    assert.match(step!.body, /not (shown|part of)|never shown|does not appear|only (appears|when)/i, `${step!.id} says ${id} is not in this demo`)
  }
})
