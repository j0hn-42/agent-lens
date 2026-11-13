// Burrow view: which room an agent is drawn in, and what its bubble says. Only the observed state counts:
// no random chatter, no task invented for an agent that is not running one.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { placeAgent, pickAnimal, postureOf, BURROW_ROOM_ORDER } from '../web/lib/burrow/burrow-model'
import { BURROW_ANIMALS } from '../web/lib/burrow/burrow-types'

const roomOfTool = (tool: string | undefined) => placeAgent({ ...base, state: 'tool_calling', currentTool: tool }).room
const base = { archived: false, activity: undefined, awaitingNextEvent: false, currentTool: undefined } as const

test('roomOfTool: edits in the office, reads and searches in the library, the shell in the workshop', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(roomOfTool(t), 'office', t)
  // writing its to-do list is writing: the office, not the laboratory
  assert.equal(roomOfTool('TodoWrite'), 'office')
  for (const t of ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LS']) assert.equal(roomOfTool(t), 'library', t)
  for (const t of ['Bash', 'BashOutput', 'KillShell']) assert.equal(roomOfTool(t), 'workshop', t)
})

test('postureOf: the posture encodes the observed state, an idle agent alone strolls', () => {
  assert.equal(postureOf('thinking', false), 'sit')
  assert.equal(postureOf('waiting_permission', false), 'wave')
  assert.equal(postureOf('error', false), 'still')
  assert.equal(postureOf('idle', false), 'stroll')
  assert.equal(postureOf('paused', false), 'still')
  assert.equal(postureOf('tool_calling', false), 'still', 'a call whose tool is unknown claims no activity')
  for (const s of ['idle', 'thinking', 'waiting_permission', 'error', 'tool_calling'] as const) assert.equal(postureOf(s, true), 'sleep', `stale ${s}`)
})

test('roomOfTool: a dispatch to a sub-agent is the telephone (the sub-agent walks in through the front door)', () => {
  assert.equal(roomOfTool('Agent'), 'phone')
  assert.equal(roomOfTool('Task'), 'phone')
})

test('placeAgent: a dispatch with sub-agents still out says how many it waits for; none out, the bubble names the tool', () => {
  const p = (delegating?: number) => placeAgent({ ...base, state: 'tool_calling', currentTool: 'Agent' }, { delegating })
  assert.deepEqual(p(2), { presence: 'in', room: 'phone', bubble: { kind: 'waiting', n: 2 } })
  assert.deepEqual(p(0), { presence: 'in', room: 'phone', bubble: { kind: 'tool', tool: 'Agent' } })
  assert.deepEqual(p(undefined).bubble, { kind: 'tool', tool: 'Agent' })
  // waiting is only claimed while the dispatch tool runs: thinking with sub-agents out says thinking
  assert.deepEqual(placeAgent({ ...base, state: 'thinking' }, { delegating: 3 }).bubble, { kind: 'state', state: 'thinking' })
  assert.deepEqual(placeAgent({ ...base, state: 'tool_calling', currentTool: 'Read' }, { delegating: 3 }).bubble, { kind: 'tool', tool: 'Read' })
})

test('roomOfTool: any other named tool (MCP, unknown) goes to the laboratory; no name, no room', () => {
  assert.equal(roomOfTool('mcp__github__get_issue'), 'lab')
  assert.equal(roomOfTool('SomethingNew'), 'lab')
  assert.equal(roomOfTool(undefined), 'lounge')
  assert.equal(roomOfTool(''), 'lounge')
})

test('placeAgent: a running tool call puts the agent in the room of the tool, the bubble names the tool', () => {
  const p = placeAgent({ ...base, state: 'tool_calling', currentTool: 'Edit' })
  assert.deepEqual(p, { presence: 'in', room: 'office', bubble: { kind: 'tool', tool: 'Edit' } })
  assert.deepEqual(placeAgent({ ...base, state: 'tool_calling', currentTool: 'Bash' }).room, 'workshop')
})

test('placeAgent: a tool call whose tool name was not received claims no room: lounge, with the state only', () => {
  const p = placeAgent({ ...base, state: 'tool_calling' })
  assert.equal(p.room, 'lounge')
  assert.deepEqual(p.bubble, { kind: 'state', state: 'tool_calling' })
})

test('placeAgent: a stale agent (silent, replayed or imported) claims no room and no tool: lounge, last known state', () => {
  const p = placeAgent({ ...base, state: 'tool_calling', currentTool: 'Bash' }, { stale: true })
  assert.deepEqual(p, { presence: 'in', room: 'lounge', bubble: { kind: 'stale', state: 'tool_calling' } })
  assert.deepEqual(placeAgent({ ...base, state: 'idle' }, { stale: true }).bubble, null)
  // a finished agent is finished, fresh or not
  assert.equal(placeAgent({ ...base, state: 'complete' }, { stale: true }).presence, 'finished')
})

test('placeAgent: a live tool call that is only silent (a long command) keeps the room of its tool, its bubble says last known state', () => {
  const silent = placeAgent({ ...base, state: 'tool_calling', currentTool: 'Bash' }, { stale: true, silentOnly: true })
  assert.deepEqual(silent, { presence: 'in', room: 'workshop', bubble: { kind: 'stale', state: 'tool_calling' } })
  // replayed or imported: nothing proves the call is still open, lounge as before
  assert.equal(placeAgent({ ...base, state: 'tool_calling', currentTool: 'Bash' }, { stale: true, silentOnly: false }).room, 'lounge')
  // silent but not in a named tool call: lounge
  assert.equal(placeAgent({ ...base, state: 'thinking' }, { stale: true, silentOnly: true }).room, 'lounge')
  assert.equal(placeAgent({ ...base, state: 'tool_calling', currentTool: undefined }, { stale: true, silentOnly: true }).room, 'lounge')
})

test('placeAgent: waiting for the user (a permission, or an AskUserQuestion call) is the post beside the front door', () => {
  assert.deepEqual(placeAgent({ ...base, state: 'waiting_permission' }), { presence: 'in', room: 'door', bubble: { kind: 'state', state: 'waiting_permission' } })
  // the bubble still quotes the tool as received
  assert.deepEqual(placeAgent({ ...base, state: 'tool_calling', currentTool: 'AskUserQuestion' }), { presence: 'in', room: 'door', bubble: { kind: 'tool', tool: 'AskUserQuestion' } })
  // a stale permission wait proves nothing about now: lounge, last known state, as every stale agent
  assert.equal(placeAgent({ ...base, state: 'waiting_permission' }, { stale: true }).room, 'lounge')
})

test('placeAgent: thinking, an error and a pause stay in the lounge and say so', () => {
  for (const state of ['thinking', 'error', 'paused'] as const) {
    const p = placeAgent({ ...base, state })
    assert.equal(p.presence, 'in')
    assert.equal(p.room, 'lounge', state)
    assert.deepEqual(p.bubble, { kind: 'state', state })
  }
})

test('placeAgent: idle rests in the lounge without a bubble (nothing is claimed about what it does)', () => {
  assert.deepEqual(placeAgent({ ...base, state: 'idle' }), { presence: 'in', room: 'lounge', bubble: null })
  // between two steps of a turn the agent is not at rest, but nothing is observed either: same picture, still no claim
  assert.deepEqual(placeAgent({ ...base, state: 'idle', awaitingNextEvent: true }), { presence: 'in', room: 'lounge', bubble: null })
})

test('placeAgent: a finished agent rests in the lounge without a bubble (like a dimmed node of the graph), and an error is never taken for a finished one', () => {
  assert.deepEqual(placeAgent({ ...base, state: 'complete' }), { presence: 'finished', room: 'lounge', bubble: null })
  assert.equal(placeAgent({ ...base, state: 'idle', archived: true }).presence, 'finished')
  assert.equal(placeAgent({ ...base, state: 'idle', activity: 'done' }).presence, 'finished')
  assert.equal(placeAgent({ ...base, state: 'error', activity: 'done' }).presence, 'in')
  assert.equal(placeAgent({ ...base, state: 'waiting_permission', archived: false, activity: 'done' }).presence, 'in')
})

test('pickAnimal: stable for a key, and two agents get two animals while the cast is not used up', () => {
  assert.equal(pickAnimal('s1:main', new Set()), pickAnimal('s1:main', new Set()))
  const used = new Set<string>()
  for (let i = 0; i < BURROW_ANIMALS.length; i++) {
    const a = pickAnimal(`s1:agent-${i}`, used)
    assert.ok(!used.has(a), `${a} already taken`)
    used.add(a)
  }
  assert.equal(used.size, BURROW_ANIMALS.length)
})

test('pickAnimal: beyond nine agents an animal is shared, the pick stays inside the cast', () => {
  const all = new Set(BURROW_ANIMALS.map((a) => a.sprite))
  const a = pickAnimal('s1:tenth', all)
  assert.ok(all.has(a))
})

test('BURROW_ROOM_ORDER lists the lounge and the four workshops once each', () => {
  assert.deepEqual([...BURROW_ROOM_ORDER].sort(), ['lab', 'library', 'lounge', 'office', 'workshop'])
})
