// Burrow view: which room an agent is drawn in, and what its bubble says. Only the observed state counts:
// no random chatter, no task invented for an agent that is not running one.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { placeAgent, pickAnimal, BURROW_ROOM_ORDER } from '../web/lib/burrow/burrow-model'
import { BURROW_ANIMALS } from '../web/lib/burrow/burrow-types'

const roomOfTool = (tool: string | undefined) => placeAgent({ ...base, state: 'tool_calling', currentTool: tool }).room
const base = { archived: false, activity: undefined, awaitingNextEvent: false, currentTool: undefined } as const

test('roomOfTool: edits in the office, reads and searches in the library, the shell in the workshop', () => {
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.equal(roomOfTool(t), 'office', t)
  for (const t of ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'LS']) assert.equal(roomOfTool(t), 'library', t)
  for (const t of ['Bash', 'BashOutput', 'KillShell']) assert.equal(roomOfTool(t), 'workshop', t)
})

test('roomOfTool: any other named tool (agent dispatch, MCP, unknown) goes to the laboratory; no name, no room', () => {
  assert.equal(roomOfTool('Agent'), 'lab')
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
  assert.equal(placeAgent({ ...base, state: 'complete' }, { stale: true }).presence, 'away')
})

test('placeAgent: thinking, a permission wait, an error and a pause stay in the lounge and say so', () => {
  for (const state of ['thinking', 'waiting_permission', 'error', 'paused'] as const) {
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

test('placeAgent: a finished agent leaves through the front door, and an error is never taken for a finished one', () => {
  assert.equal(placeAgent({ ...base, state: 'complete' }).presence, 'away')
  assert.equal(placeAgent({ ...base, state: 'idle', archived: true }).presence, 'away')
  assert.equal(placeAgent({ ...base, state: 'idle', activity: 'done' }).presence, 'away')
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
