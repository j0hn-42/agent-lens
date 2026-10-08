// 'Hide inactive agents' also hides the done agents (#147): isInactiveAgent / visibleAgents / announcement text.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { visibleAgents, isInactiveAgent, isDoneAgent, hiddenDoneCount, hiddenDoneText } from '../web/lib/inactive-agents'
import type { Agent } from '../web/lib/agent-types'

const mk = (id: string, state: Agent['state'], parentId: string | null = null) =>
  ({ id, state, parentId, archived: false }) as unknown as Agent
const mate = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, sessionId: 'S', parentId: 'main', state: 'thinking', kind: 'teammate', ...over }) as unknown as Agent
const wfMember = (id: string, activity: 'working' | 'idle' | 'done', state: Agent['state'] = 'idle') =>
  mate(id, { teamName: 'wf', teamKind: 'workflow', activity, state, parentId: 'orch' })

test('isInactiveAgent: a teammate whose activity is done is inactive although its state is not complete', () => {
  assert.equal(isInactiveAgent({ state: 'idle', kind: 'teammate', activity: 'done' }), true)
  assert.equal(isInactiveAgent({ state: 'thinking', kind: 'teammate', activity: 'done' }), true)
  assert.equal(isInactiveAgent({ state: 'complete' }), true)
  assert.equal(isInactiveAgent({ state: 'thinking', kind: 'teammate', activity: 'working' }), false)
  assert.equal(isInactiveAgent({ state: 'idle', kind: 'teammate', activity: 'working' }), false)
})

test('isDoneAgent: an error or a permission wait is never finished, even with activity done', () => {
  assert.equal(isDoneAgent({ state: 'error', activity: 'done' }), false)
  assert.equal(isDoneAgent({ state: 'waiting_permission', activity: 'done' }), false)
  assert.equal(isDoneAgent({ state: 'idle', activity: 'done' }), true)
  assert.equal(isDoneAgent({ state: 'idle', archived: true }), true)
  assert.equal(isDoneAgent({ state: 'idle', activity: 'idle' }), false)
})

test('visibleAgents: a done teammate is hidden, a working one stays, the button off shows everything', () => {
  const m = new Map<string, Agent>([
    ['main', mk('main', 'thinking')],
    ['t1', mate('t1', { activity: 'done', state: 'idle' })],
    ['t2', mate('t2', { activity: 'working' })],
  ])
  assert.deepEqual([...visibleAgents(m, true).keys()], ['main', 't2'])
  assert.equal(visibleAgents(m, false), m)
})

test('visibleAgents: a done agent stays when selected, and when it is the parent of a visible agent', () => {
  const m = new Map<string, Agent>([
    ['main', mk('main', 'thinking')],
    ['t1', mate('t1', { activity: 'done', state: 'idle' })],
    ['t2', mate('t2', { activity: 'working', parentId: 't1' })],
    ['t3', mate('t3', { activity: 'done', state: 'idle' })],
  ])
  assert.deepEqual([...visibleAgents(m, true).keys()], ['main', 't1', 't2'], 't1 is the parent of the working t2')
  assert.deepEqual([...visibleAgents(m, true, ['t3']).keys()], ['main', 't1', 't2', 't3'], 't3 is selected')
})

test('visibleAgents: in an active workflow the done members go, the working and waiting ones stay', () => {
  const m = new Map<string, Agent>([
    ['orch', mk('orch', 'idle')],
    ['w1', wfMember('w1', 'working', 'thinking')],
    ['w2', wfMember('w2', 'idle')],
    ['w3', wfMember('w3', 'done')],
    ['w4', wfMember('w4', 'done', 'complete')],
  ])
  assert.deepEqual([...visibleAgents(m, true).keys()], ['orch', 'w1', 'w2'], 'orch is the parent of the visible members')
})

test('visibleAgents: an active workflow is never drawn empty (it always has a member that is not done)', () => {
  const acts = ['working', 'idle', 'done'] as const
  for (const a of acts) for (const b of acts) for (const c of acts) {
    const m = new Map<string, Agent>([
      ['orch', mk('orch', 'idle')],
      ['w1', wfMember('w1', a, a === 'working' ? 'thinking' : 'idle')],
      ['w2', wfMember('w2', b, b === 'working' ? 'thinking' : 'idle')],
      ['w3', wfMember('w3', c, c === 'working' ? 'thinking' : 'idle')],
    ])
    const shown = visibleAgents(m, true)
    const members = ['w1', 'w2', 'w3'].filter(id => shown.has(id)).length
    if (a === 'done' && b === 'done' && c === 'done') assert.equal(members, 0, 'a finished workflow is hidden as a whole')
    else assert.ok(members >= 1, `${a}/${b}/${c}: the active workflow keeps a member`)
  }
})

test('visibleAgents: a done member of an active workflow stays when selected', () => {
  const m = new Map<string, Agent>([
    ['orch', mk('orch', 'idle')],
    ['w1', wfMember('w1', 'working', 'thinking')],
    ['w3', wfMember('w3', 'done')],
  ])
  assert.deepEqual([...visibleAgents(m, true, ['w3']).keys()], ['orch', 'w1', 'w3'])
})

test('hiddenDoneCount / hiddenDoneText: only finished agents are counted and worded', () => {
  const m = new Map<string, Agent>([
    ['main', mk('main', 'thinking')],
    ['t1', mate('t1', { activity: 'done', state: 'idle' })],
    ['t2', mate('t2', { activity: 'done', state: 'complete' })],
    ['i1', mk('i1', 'idle', 'main')],
  ])
  assert.equal(hiddenDoneCount(m, true), 2, 'the idle agent is hidden too but is not finished')
  assert.equal(hiddenDoneCount(m, false), 0)
  assert.equal(hiddenDoneCount(m, true, ['t1']), 1, 'a selected agent is not hidden')
  assert.equal(hiddenDoneCount(new Map([['main', mk('main', 'thinking')]]), true), 0)
  assert.equal(hiddenDoneText(2), '2 finished agents hidden')
  assert.equal(hiddenDoneText(1), '1 finished agent hidden')
  assert.equal(hiddenDoneText(0), '')
})
