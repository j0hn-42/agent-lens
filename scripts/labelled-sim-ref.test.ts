// #36: the canvas reads agents from a ref; createLabelledSimulationRef decorates them with the session
// label/runtime, memoised so nothing is copied again while the agents map and the session list are unchanged.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createLabelledSimulationRef } from '../web/lib/chrome-utils'

type A = { id: string; sessionId: string; sessionLabel?: string; runtime?: 'claude' | 'codex' }
const mk = () => {
  const a1: A = { id: 'a1', sessionId: 's1' }
  const a2: A = { id: 'a2', sessionId: 's2', runtime: 'codex' }
  return { a1, a2, agents: new Map<string, A>([['a1', a1], ['a2', a2]]) }
}
const sessions = [
  { id: 's1', label: 'payments-api', runtime: 'claude' as const },
  { id: 's2', label: 'web', runtime: 'claude' as const },
]

test('agents read through the ref carry the session label and runtime; the source is untouched', () => {
  const { a1, agents } = mk()
  const frame = { agents, other: 42 }
  const ref = createLabelledSimulationRef({ current: frame }, () => sessions)
  const out = ref.current
  assert.equal(out.agents.get('a1')?.sessionLabel, 'payments-api')
  assert.equal(out.agents.get('a1')?.runtime, 'claude')
  assert.equal(out.agents.get('a2')?.sessionLabel, 'web')
  assert.equal(out.agents.get('a2')?.runtime, 'codex', 'an own runtime wins')
  assert.equal(out.other, 42, 'the rest of the frame is passed through')
  assert.equal(a1.sessionLabel, undefined, 'the simulation agent is not mutated')
})

test('same agents map and session list: same decorated map, no recomputation', () => {
  const { agents } = mk()
  const source = { current: { agents } }
  const ref = createLabelledSimulationRef(source, () => sessions)
  const first = ref.current.agents
  source.current = { agents } // a new frame object, same agents map
  assert.equal(ref.current.agents, first)
})

test('a changed agents map re-decorates but reuses the decorated objects of unchanged agents', () => {
  const { a1, a2, agents } = mk()
  const source = { current: { agents } }
  const ref = createLabelledSimulationRef(source, () => sessions)
  const before = ref.current.agents
  const a2b = { ...a2, runtime: 'codex' as const }
  source.current = { agents: new Map([['a1', a1], ['a2', a2b]]) }
  const after = ref.current.agents
  assert.notEqual(after, before)
  assert.equal(after.get('a1'), before.get('a1'), 'unchanged agent keeps its decorated object')
  assert.notEqual(after.get('a2'), before.get('a2'))
})

test('a new session list re-labels', () => {
  const { agents } = mk()
  let list = sessions
  const ref = createLabelledSimulationRef({ current: { agents } }, () => list)
  assert.equal(ref.current.agents.get('a1')?.sessionLabel, 'payments-api')
  list = [{ id: 's1', label: 'renamed', runtime: 'claude' }, sessions[1]]
  assert.equal(ref.current.agents.get('a1')?.sessionLabel, 'renamed')
})
