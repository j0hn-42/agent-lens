// Burrow view: the scene follows the observed agents, and only them.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createBurrowEngine } from '../web/lib/burrow/burrow-engine'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'
import { createBurrowSyncState, syncBurrow as syncList, BURROW_MAX_ANIMALS, type SyncAgent } from '../web/lib/burrow/burrow-sync'

const TITLES = { lounge: 'L', office: 'O', library: 'B', workshop: 'A', lab: 'X', home: 'M' }
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 }
}
const setup = () => ({ e: createBurrowEngine({ data: BURROW_DATA, titles: TITLES, rng: seeded(5) }), st: createBurrowSyncState() })
const agent = (id: string, over: Partial<SyncAgent> = {}): SyncAgent => ({ id, displayName: id, sessionId: 's', state: 'idle', kind: 'main', parentId: null, ...over })
const syncBurrow = (e: ReturnType<typeof setup>['e'], st: ReturnType<typeof setup>['st'], list: SyncAgent[], o: Parameters<typeof syncList>[3]) =>
  syncList(e, st, new Map(list.map((a) => [a.id, a])), o)
const opts = { hideInactive: false, selectedId: null, now: 1_000_000, bubbleText: (b: { kind: string; tool?: string; state?: string }) => (b.kind === 'tool' ? String(b.tool) : `${b.kind}:${b.state}`) }
const run = (e: ReturnType<typeof setup>['e'], s: number) => { for (let t = 0; t < s; t += 0.1) e.update(0.1) }
const at = (e: ReturnType<typeof setup>['e'], id: string) => { const a = e.actors.find((x) => x.key === id); return a ? e.zoneOf(a.x, a.y) : null }

test('the first sync puts every agent in the burrow at once, working agents at their post', () => {
  const { e, st } = setup()
  syncBurrow(e, st, [agent('a'), agent('b', { state: 'tool_calling', currentTool: 'Edit' })], opts)
  assert.equal(at(e, 'a'), 'lounge')
  assert.equal(at(e, 'b'), 'office')
  assert.equal(e.actors.find((a) => a.key === 'b')?.said, 'Edit')
  assert.equal(e.actors.find((a) => a.key === 'a')?.said, null)
})

test('a tool change moves the animal to the room of the new tool, and idle brings it back to the lounge', () => {
  const { e, st } = setup()
  const a = agent('a', { state: 'tool_calling', currentTool: 'Read' })
  syncBurrow(e, st, [a], opts)
  assert.equal(at(e, 'a'), 'library')
  a.currentTool = 'Bash'
  syncBurrow(e, st, [a], opts)
  run(e, 40)
  assert.equal(at(e, 'a'), 'workshop')
  a.state = 'idle'; a.currentTool = undefined
  syncBurrow(e, st, [a], opts)
  run(e, 40)
  assert.equal(at(e, 'a'), 'lounge')
})

test('a finished agent stays in the burrow, resting in the lounge and listed as finished: the graph draws it too', () => {
  const { e, st } = setup()
  const a = agent('a', { state: 'tool_calling', currentTool: 'Edit' })
  const r1 = syncBurrow(e, st, [a, agent('done', { state: 'complete' })], opts)
  assert.equal(e.has('done'), true)
  assert.equal(e.isResting('done'), true)
  assert.deepEqual(r1.rows.find((x) => x.id === 'done')?.presence, 'finished')
  a.state = 'complete'; a.currentTool = undefined
  syncBurrow(e, st, [a, agent('done', { state: 'complete' })], opts)
  run(e, 60)
  assert.equal(e.isOutside('a'), false)
  assert.equal(at(e, 'a'), 'lounge')
  assert.equal(e.isResting('a'), true)
  assert.equal(e.actors.find((x) => x.key === 'a')?.said, null)
})

test('a finished agent walks out only when the filter hides it (Show: active), like the graph drops it', () => {
  const { e, st } = setup()
  const a = agent('a', { state: 'complete' })
  syncBurrow(e, st, [a], opts)
  assert.equal(e.has('a'), true)
  const r = syncBurrow(e, st, [a], { ...opts, hideInactive: true })
  assert.deepEqual(r.rows, [])
  run(e, 60)
  assert.equal(e.isOutside('a'), true)
  // a filtered finished agent that was never drawn is not drawn now
  const fresh = setup()
  syncBurrow(fresh.e, fresh.st, [agent('gone', { state: 'complete' })], { ...opts, hideInactive: true })
  assert.equal(fresh.e.has('gone'), false)
})

test('an agent that resumes after finishing stops resting and goes back to work', () => {
  const { e, st } = setup()
  const a = agent('a', { state: 'complete' })
  syncBurrow(e, st, [a], opts)
  a.state = 'tool_calling'; a.currentTool = 'Bash'
  syncBurrow(e, st, [a], opts)
  run(e, 40)
  assert.equal(e.isResting('a'), false)
  assert.equal(at(e, 'a'), 'workshop')
})

test('hide inactive: an idle agent is not drawn, unless it is the selected one', () => {
  const { e, st } = setup()
  const r = syncBurrow(e, st, [agent('a'), agent('b')], { ...opts, hideInactive: true, selectedId: 'b' })
  assert.equal(e.has('a'), false)
  assert.equal(e.has('b'), true)
  assert.deepEqual(r.rows.map((x) => x.id), ['b'])
})

test('an agent gone from the data walks out and leaves the scene', () => {
  const { e, st } = setup()
  syncBurrow(e, st, [agent('a'), agent('b')], opts)
  syncBurrow(e, st, [agent('b')], opts)
  for (let t = 0; t < 120 && e.has('a'); t += 0.1) e.update(0.1)
  assert.equal(e.has('a'), false)
  assert.equal(e.has('b'), true)
})

test('attention states keep their bubble, a tool bubble ends by itself', () => {
  const { e, st } = setup()
  syncBurrow(e, st, [agent('p', { state: 'waiting_permission' }), agent('t', { state: 'tool_calling', currentTool: 'Grep' })], opts)
  run(e, 30)
  assert.equal(e.actors.find((a) => a.key === 'p')?.said, 'state:waiting_permission')
  assert.equal(e.actors.find((a) => a.key === 't')?.said, null)
})

test('beyond the cap the extra agents are counted, not drawn, and an animal already drawn is never dropped for them', () => {
  const { e, st } = setup()
  const many = Array.from({ length: BURROW_MAX_ANIMALS + 5 }, (_, i) => agent(`k${i}`))
  const r = syncBurrow(e, st, many, opts)
  assert.equal(e.actors.length, BURROW_MAX_ANIMALS)
  assert.equal(r.hidden, 5)
  assert.equal(r.rows.length, BURROW_MAX_ANIMALS)
  // a busy agent among the extras is drawn first on a fresh scene
  const fresh = setup()
  const busy = agent('busy', { state: 'tool_calling', currentTool: 'Bash' })
  const r2 = syncBurrow(fresh.e, fresh.st, [...many, busy], opts)
  assert.equal(fresh.e.has('busy'), true)
  assert.equal(r2.hidden, 6)
})

test('the rows say where each agent is, for the keyboard and screen reader list', () => {
  const { e, st } = setup()
  const r = syncBurrow(e, st, [agent('a', { displayName: 'Main', state: 'thinking' })], opts)
  assert.deepEqual(r.rows, [{ id: 'a', name: 'Main', presence: 'in', room: 'lounge', state: 'thinking', stale: false }])
})

test('a new agent after the start walks in through the front door unless motion is reduced', () => {
  const { e, st } = setup()
  syncBurrow(e, st, [agent('a')], opts)
  syncBurrow(e, st, [agent('a'), agent('late')], opts)
  assert.equal(e.isOutside('late'), true)
  run(e, 30)
  assert.equal(e.isOutside('late'), false)
  const calm = setup()
  syncBurrow(calm.e, calm.st, [agent('a')], opts)
  syncBurrow(calm.e, calm.st, [agent('a'), agent('late')], { ...opts, instant: true })
  assert.equal(calm.e.isOutside('late'), false)
})

test('hide inactive: the finished wording is only for finished agents, a filtered idle one gets no row', () => {
  const { e, st } = setup()
  const idle = agent('idle')
  syncBurrow(e, st, [idle, agent('done', { state: 'complete' })], opts)
  const r = syncBurrow(e, st, [idle, agent('b')], { ...opts, hideInactive: true, selectedId: null })
  assert.ok(r.rows.every((x) => x.presence === 'in'), 'no row says away for a filtered idle agent')
  assert.deepEqual(r.rows, [])
})

test('hide inactive keeps the idle members of a live workflow and the parents of a working agent, like the graph', () => {
  const { e, st } = setup()
  const wf = { teamKind: 'workflow' as const, teamName: 'w', clusterKey: 'k' }
  const list = [
    agent('m1', { ...wf, activity: 'working' as const, state: 'tool_calling', currentTool: 'Read' }),
    agent('m2', { ...wf, activity: 'idle' as const }),
    agent('parent'),
    agent('child', { parentId: 'parent', state: 'thinking' }),
    agent('loner'),
  ]
  const r = syncBurrow(e, st, list, { ...opts, hideInactive: true })
  assert.deepEqual(r.rows.map((x) => x.id).sort(), ['child', 'm1', 'm2', 'parent'])
  assert.equal(e.has('loner'), false)
})

test('a stale agent (silent for long, or replayed) is not placed in a room and says it is the last known state', () => {
  const { e, st } = setup()
  const old = agent('old', { state: 'tool_calling', currentTool: 'Bash', lastEventAt: 1_000_000 - 10 * 60_000 })
  const history = agent('hist', { state: 'tool_calling', currentTool: 'Edit', lastEventAt: 999_999, freshnessSource: 'history' })
  const live = agent('live', { state: 'tool_calling', currentTool: 'Bash', lastEventAt: 999_999 })
  syncBurrow(e, st, [old, history, live], opts)
  assert.equal(at(e, 'old'), 'lounge')
  assert.equal(at(e, 'hist'), 'lounge')
  assert.equal(at(e, 'live'), 'workshop')
  assert.equal(e.actors.find((a) => a.key === 'old')?.said, 'stale:tool_calling')
  assert.equal(e.actors.find((a) => a.key === 'live')?.said, 'Bash')
})

test('a working agent takes the place of a finished animal first, then of an idle one, when the burrow is full', () => {
  const { e, st } = setup()
  const calm = { ...opts, instant: true }   // newcomers are inside at once: an animal outside the door holds no place
  const first = Array.from({ length: BURROW_MAX_ANIMALS }, (_, i) => agent(`k${i}`, { state: 'thinking' }))
  syncBurrow(e, st, first, calm)
  first[3].state = 'complete'
  first[7].state = 'idle'
  syncBurrow(e, st, first, calm)
  const fresh = agent('fresh', { state: 'thinking' })
  let r = syncBurrow(e, st, [...first, fresh], calm)
  assert.equal(e.has('fresh'), true)
  assert.equal(r.hidden, 0, 'it took a place, nothing is counted')
  assert.equal(e.isGone('k3'), true, 'the finished animal gave its place')
  assert.equal(e.isGone('k7'), false, 'the idle one kept it')
  const fresh2 = agent('fresh2', { state: 'thinking' })
  r = syncBurrow(e, st, [...first, fresh, fresh2], calm)
  assert.equal(e.has('fresh2'), true)
  assert.equal(e.isGone('k7'), true, 'then the idle animal gave its place')
  // a newcomer that claims no more than any drawn animal (idle, while only working ones are left) is counted
  const idle = agent('idle')
  r = syncBurrow(e, st, [...first, fresh, fresh2, idle], calm)
  assert.equal(e.has('idle'), false)
  assert.equal(r.hidden, 1)
})

test('an agent that needs attention takes the place of an idle animal when the burrow is full', () => {
  const { e, st } = setup()
  const idle = Array.from({ length: BURROW_MAX_ANIMALS }, (_, i) => agent(`i${i}`))
  syncBurrow(e, st, idle, opts)
  const ask = agent('ask', { state: 'waiting_permission' })
  const r = syncBurrow(e, st, [...idle, ask], opts)
  assert.equal(e.has('ask'), true)
  assert.equal(r.hidden, 0)
  assert.ok(r.rows.some((x) => x.id === 'ask'))
})

test('the rows carry the tool name, so the aria-hidden bubble holds no information of its own', () => {
  const { e, st } = setup()
  const r = syncBurrow(e, st, [agent('a', { state: 'tool_calling', currentTool: 'Grep' })], opts)
  assert.equal(r.rows[0].tool, 'Grep')
})

test('changed: true when a placement was applied, false when nothing moved', () => {
  const { e, st } = setup()
  assert.equal(syncBurrow(e, st, [agent('a')], opts).changed, true)
  assert.equal(syncBurrow(e, st, [agent('a')], opts).changed, false)
  assert.equal(syncBurrow(e, st, [agent('a', { state: 'thinking' })], opts).changed, true)
})
