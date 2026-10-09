import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { GUIDED_SCENARIO } from '../web/lib/guided-scenario'
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
function play(events: SimulationEvent[]): SimulationState {
  let state = createEmptyState()
  for (const e of events) state = processEvent(e, { ...state, currentTime: e.time }, ctx)
  return state
}

test('the guided scenario is sorted by time: the player reads it in array order', () => {
  for (let i = 1; i < GUIDED_SCENARIO.length; i++) {
    assert.ok(GUIDED_SCENARIO[i].time >= GUIDED_SCENARIO[i - 1].time, `event ${i} (t=${GUIDED_SCENARIO[i].time}) is before t=${GUIDED_SCENARIO[i - 1].time}`)
  }
})

test('the guided scenario is short enough for seekToTime to replay it instantly', () => {
  assert.ok(GUIDED_SCENARIO[GUIDED_SCENARIO.length - 1].time <= 50)
})

test('the played scenario produces what the tour explains', () => {
  const s = play(GUIDED_SCENARIO)
  const agents = [...s.agents.values()]
  assert.ok(agents.some(a => a.runtime === 'codex'), 'a Codex agent')
  assert.ok(agents.some(a => a.runtime !== 'codex'), 'a Claude agent')
  // The engine sets `kind` only for teammates
  assert.ok(agents.some(a => !a.isMain && a.kind !== 'teammate'), 'a sub-agent')
  assert.ok(agents.some(a => a.kind === 'teammate'), 'a teammate')
  assert.ok([...s.toolCalls.values()].some(t => t.state === 'error'), 'a failed tool call')
  assert.ok(s.links.size > 0 && [...s.links.values()].some(l => l.messages.length > 0), 'a link with messages')
  assert.ok(s.teams.size > 0, 'a team')
})

test('the permission request puts the main agent in waiting_permission at that moment', () => {
  const t = GUIDED_SCENARIO.find(e => e.type === 'permission_requested')!.time
  const s = play(GUIDED_SCENARIO.filter(e => e.time <= t))
  assert.ok([...s.agents.values()].some(a => a.state === 'waiting_permission'))
})
