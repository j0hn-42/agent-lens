// Burrow view: the animal follows the room where most of its recent tool calls went, not each call. Over the last
// 10 seconds the named calls received for an agent are counted per room (a call still running counts as long as it
// runs); the animal changes room only when another room leads by two calls, or when its room has no call left.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createBurrowEngine } from '../web/lib/burrow/burrow-engine'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'
import { createBurrowSyncState, syncBurrow, type SyncAgent } from '../web/lib/burrow/burrow-sync'

const TITLES = { lounge: 'L', office: 'O', library: 'B', workshop: 'A', lab: 'X', home: 'M' }
type Call = { id: string; agentId: string; toolName: string; state: 'running' | 'complete' }
const T0 = 1_000_000

/** A small live session: tool calls start and end, the agent's state follows, each step synced at its time */
function session(seed = 3) {
  let s = seed
  const e = createBurrowEngine({ data: BURROW_DATA, titles: TITLES, rng: () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } })
  const st = createBurrowSyncState()
  const calls = new Map<string, Call>()
  const agents = new Map<string, SyncAgent>()
  let n = 0
  const agent = (id: string, over: Partial<SyncAgent> = {}) => {
    agents.set(id, { id, displayName: id, sessionId: 's', state: 'idle', kind: 'main', parentId: null, lastEventAt: T0, ...over })
  }
  const sync = (now: number) => syncBurrow(e, st, agents, {
    hideInactive: false, selectedId: null, now, toolCalls: calls as never,
    bubbleText: (b) => (b.kind === 'tool' ? b.tool : `${b.kind}:${'state' in b ? b.state : ''}`),
  })
  /** The agent starts a call of `tool` at `now` (ending the one it ran, unless `keep`) */
  const start = (id: string, tool: string, now: number, keep = false) => {
    if (!keep) for (const c of calls.values()) if (c.agentId === id && c.state === 'running') c.state = 'complete'
    const cid = `c${++n}`
    calls.set(cid, { id: cid, agentId: id, toolName: tool, state: 'running' })
    const a = agents.get(id)!
    agents.set(id, { ...a, state: 'tool_calling', currentTool: tool, lastEventAt: now })
    return { cid, result: sync(now) }
  }
  const end = (id: string, now: number, state: SyncAgent['state'] = 'thinking') => {
    for (const c of calls.values()) if (c.agentId === id && c.state === 'running') c.state = 'complete'
    const a = agents.get(id)!
    agents.set(id, { ...a, state, currentTool: undefined, lastEventAt: now })
    return sync(now)
  }
  return { e, st, calls, agent, sync, start, end, set: (id: string, over: Partial<SyncAgent>, now: number) => { agents.set(id, { ...agents.get(id)!, ...over, lastEventAt: now }); return sync(now) } }
}

test('an agent that alternates Read, Edit, Read... settles in the room it started in, it does not run back and forth', () => {
  const s = session()
  s.agent('a')
  s.sync(T0)
  const tools = ['Read', 'Edit', 'Read', 'Edit', 'Read', 'Edit', 'Read', 'Edit']
  tools.forEach((tool, i) => {
    const { result } = s.start('a', tool, T0 + 1000 + i * 800)
    assert.equal(s.e.jobOf('a'), 'library', `after ${tool} #${i}`)
    const row = result.rows.find((r) => r.id === 'a')!
    assert.equal(row.room, 'library', 'the row says where the animal stands')
    assert.equal(row.tool, tool, 'and the tool actually running')
  })
})

test('another room takes over once it leads by two calls', () => {
  const s = session()
  s.agent('a')
  s.sync(T0)
  s.start('a', 'Read', T0 + 1000)
  s.start('a', 'Edit', T0 + 2000)
  assert.equal(s.e.jobOf('a'), 'library', 'office 1, library 1: no lead')
  s.start('a', 'Write', T0 + 3000)
  assert.equal(s.e.jobOf('a'), 'library', 'office 2, library 1: one call is not a clear lead')
  s.start('a', 'Edit', T0 + 4000)
  assert.equal(s.e.jobOf('a'), 'office', 'office 3, library 1: the office leads by two')
})

test('a single long Bash still sends the animal to the workshop: once the earlier calls are older than the window, the running call alone counts', () => {
  const s = session()
  s.agent('a')
  s.sync(T0)
  s.start('a', 'Read', T0 + 1000)
  s.start('a', 'Bash', T0 + 2000)
  assert.equal(s.e.jobOf('a'), 'library', 'workshop 1, library 1')
  s.sync(T0 + 9000)
  assert.equal(s.e.jobOf('a'), 'library')
  const r = s.sync(T0 + 11_500)
  assert.equal(s.e.jobOf('a'), 'workshop', 'the Read left the window, the Bash still runs')
  assert.equal(r.rows[0].room, 'workshop')
  s.sync(T0 + 60_000)
  assert.equal(s.e.jobOf('a'), 'workshop', 'a call that runs keeps counting')
})

test('a first call goes straight to its room; after a pause in the lounge the next call decides afresh', () => {
  const s = session()
  s.agent('a')
  s.sync(T0)
  s.start('a', 'Bash', T0 + 1000)
  assert.equal(s.e.jobOf('a'), 'workshop')
  s.end('a', T0 + 1500, 'idle')
  assert.equal(s.e.jobOf('a'), null)
  s.start('a', 'Edit', T0 + 2500)
  assert.equal(s.e.jobOf('a'), 'office', 'idle in between: no room is kept, whatever the window still holds')
})

test('the short think between two calls keeps the room the animal stands in (the dominant one)', () => {
  const s = session()
  s.agent('a')
  s.sync(T0)
  s.start('a', 'Read', T0 + 1000)
  s.start('a', 'Edit', T0 + 2000)
  const r = s.end('a', T0 + 2500, 'thinking')
  assert.equal(s.e.jobOf('a'), 'library')
  assert.equal(r.rows[0].room, 'library')
  assert.equal(r.rows[0].tool, undefined, 'no tool runs: the row names none')
})

test('waiting for the user, an error, a dispatch at the telephone and AskUserQuestion take priority over the dominant room', () => {
  const s = session()
  s.agent('a')
  s.sync(T0)
  for (let i = 0; i < 4; i++) s.start('a', 'Read', T0 + 1000 + i * 300)
  s.set('a', { state: 'waiting_permission', currentTool: undefined }, T0 + 2500)
  assert.equal(s.e.jobOf('a'), 'door')
  s.start('a', 'Read', T0 + 3000)
  assert.equal(s.e.jobOf('a'), 'library')
  s.start('a', 'AskUserQuestion', T0 + 3500)
  assert.equal(s.e.jobOf('a'), 'door')
  s.start('a', 'Agent', T0 + 4000)
  assert.equal(s.e.jobOf('a'), 'phone')
  s.set('a', { state: 'error', currentTool: undefined }, T0 + 4500)
  assert.equal(s.e.jobOf('a'), null)
})

test('calls already received when the view opens are not counted (they have no time), a call running then counts', () => {
  const s = session()
  s.agent('a', { state: 'tool_calling', currentTool: 'Edit' })
  for (let i = 0; i < 5; i++) s.calls.set(`old${i}`, { id: `old${i}`, agentId: 'a', toolName: 'Read', state: 'complete' })
  s.calls.set('now', { id: 'now', agentId: 'a', toolName: 'Edit', state: 'running' })
  const r = s.sync(T0)
  assert.equal(s.e.jobOf('a'), 'office')
  assert.deepEqual(r.received, [], 'nothing is received on the first look')
})

test('received: each call seen starting since the last sync, once, with the room of its tool (the view flashes that room)', () => {
  const s = session()
  s.agent('a')
  s.agent('b')
  s.sync(T0)
  const { cid, result } = s.start('a', 'Grep', T0 + 1000)
  assert.deepEqual(result.received, [{ id: cid, agentId: 'a', room: 'library' }])
  assert.deepEqual(s.sync(T0 + 1100).received, [], 'not twice')
  const two = s.start('b', 'Agent', T0 + 1200).result.received
  assert.deepEqual(two.map((x) => x.room), ['phone'])
  // a call first seen already finished (a replayed history) is not a call starting now
  s.calls.set('late', { id: 'late', agentId: 'b', toolName: 'Bash', state: 'complete' })
  assert.deepEqual(s.sync(T0 + 1300).received, [])
  // an unnamed or empty tool name claims no room
  s.calls.set('anon', { id: 'anon', agentId: 'b', toolName: '', state: 'running' })
  assert.deepEqual(s.sync(T0 + 1400).received, [])
})

test('a stale agent (replayed, or silent) keeps the rule of its last known state, the window does not move it', () => {
  const s = session()
  s.agent('a')
  s.sync(T0)
  s.start('a', 'Read', T0 + 1000)
  s.start('a', 'Bash', T0 + 2000)
  assert.equal(s.e.jobOf('a'), 'library')
  // silent long past the staleness limit, the call still open: the room of the tool it runs, as before
  s.sync(T0 + 2000 + 5 * 60_000)
  assert.equal(s.e.jobOf('a'), 'workshop')
})
