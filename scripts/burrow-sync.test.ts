// Burrow view: the scene follows the observed agents, and only them.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createBurrowEngine } from '../web/lib/burrow/burrow-engine'
import { BURROW_DATA } from '../web/lib/burrow/burrow-data'
import { BURROW_ERROR_PLACE } from '../web/lib/burrow/burrow-error-place'
import { clusterColor } from '../web/components/agent-visualizer/canvas/cluster-model'
import { createBurrowSyncState, syncBurrow as syncList, syncDue, simFingerprint, SYNC_INTERVAL_MS, BURROW_MAX_ANIMALS, type SyncAgent } from '../web/lib/burrow/burrow-sync'
/** Palette colour of a session, as the graph gives its halo */
const sessionColor = (id: string): string => clusterColor(`session:${id}`, [{ sessionId: id }])

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

test('waiting for the user, a permission or an AskUserQuestion call, sends the agent to the post beside the front door; it never keeps it', () => {
  const { e, st } = setup()
  const p = agent('p', { state: 'tool_calling', currentTool: 'Edit' })
  const q = agent('q', { state: 'tool_calling', currentTool: 'AskUserQuestion' })
  syncBurrow(e, st, [p, q], opts)
  assert.equal(e.jobOf('p'), 'office')
  assert.equal(e.jobOf('q'), 'door')
  assert.equal(e.actors.find((a) => a.key === 'q')?.said, 'AskUserQuestion')
  p.state = 'waiting_permission'
  const r = syncBurrow(e, st, [p, q], { ...opts, now: opts.now + 1000 })
  assert.equal(e.jobOf('p'), 'door', 'a permission wait does not keep the room of the tool')
  assert.equal(r.rows.find((x) => x.id === 'p')?.room, 'door')
  run(e, 30)
  assert.equal(e.actors.find((a) => a.key === 'p')?.said, 'state:waiting_permission')
  // answered, it thinks: it leaves the door (only an agent that waits for the user stands there)
  p.state = 'thinking'; q.state = 'thinking'; q.currentTool = undefined
  syncBurrow(e, st, [p, q], { ...opts, now: opts.now + 2000 })
  assert.equal(e.jobOf('p'), null)
  assert.equal(e.jobOf('q'), null)
})

test('a state bubble lasts as long as the state, a tool bubble still ends by itself', () => {
  const { e, st } = setup()
  syncBurrow(e, st, [agent('th', { state: 'thinking' }), agent('pa', { state: 'paused' }), agent('t', { state: 'tool_calling', currentTool: 'Grep' })], opts)
  run(e, 30)
  assert.equal(e.actors.find((a) => a.key === 'th')?.said, 'state:thinking')
  assert.equal(e.actors.find((a) => a.key === 'pa')?.said, 'state:paused')
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
  assert.deepEqual(r.rows, [{ id: 'a', name: 'Main', presence: 'in', room: 'lounge', state: 'thinking', stale: false, parentId: null, sessionId: 's', depth: 0 }])
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
  // a long command: live events, silent for 2 minutes, its Bash call seen opening and not closing
  const long = agent('long', { state: 'tool_calling', currentTool: 'Bash', lastEventAt: 1_000_000 - 2 * 60_000 })
  syncBurrow(e, st, [old, history, live, long], opts)
  assert.equal(at(e, 'old'), 'lounge', 'silent for 10 minutes: the end of the call may have been lost')
  assert.equal(at(e, 'hist'), 'lounge')
  assert.equal(at(e, 'live'), 'workshop')
  assert.equal(at(e, 'long'), 'workshop', 'a long command keeps its room')
  assert.equal(e.actors.find((a) => a.key === 'old')?.said, 'stale:tool_calling')
  assert.equal(e.actors.find((a) => a.key === 'long')?.said, 'stale:tool_calling', 'its bubble still says the state is the last one known')
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

test('delegation: an orchestrator in a dispatch call waits at the telephone, its sub-agents are listed under it', () => {
  const { e, st } = setup()
  const lead = agent('lead', { state: 'tool_calling', currentTool: 'Agent' })
  const sub = agent('sub', { state: 'tool_calling', currentTool: 'Read', parentId: 'lead', kind: 'subagent' })
  const r = syncBurrow(e, st, [sub, lead], { ...opts, delegations: new Map([['lead', 1]]) })
  assert.equal(e.jobOf('lead'), 'phone')
  assert.equal(r.rows.find((x) => x.id === 'lead')?.room, 'phone')
  assert.equal(e.actors.find((a) => a.key === 'lead')?.said, 'waiting:undefined')
  assert.deepEqual(r.rows.map((x) => `${x.id}:${x.depth}:${x.delegating ?? 0}`), ['lead:0:1', 'sub:1:0'])
})

test('syncBurrow stays cheap with 300 agents, most of them beyond the cap', () => {
  const { e, st } = setup()
  const states = ['idle', 'thinking', 'tool_calling', 'complete'] as const
  const list = Array.from({ length: 300 }, (_, i) => agent(`p${i}`, {
    state: states[i % states.length], currentTool: i % 4 === 2 ? 'Edit' : undefined, parentId: i > 10 ? `p${i % 10}` : null,
  }))
  const map = new Map(list.map((a) => [a.id, a]))
  for (let i = 0; i < 10; i++) syncList(e, st, map, opts)  // the first call places them, then warm up
  const runs = 60
  const t0 = performance.now()
  for (let i = 0; i < runs; i++) syncList(e, st, map, { ...opts, now: opts.now + i * 250 })
  const perCall = (performance.now() - t0) / runs
  // about 0.2 ms here; a search of every animal for every agent (the engine's lookups, the cap) took ten times that
  assert.ok(perCall < 2, `${perCall.toFixed(2)} ms per call`)
})

test('syncDue: the scene follows at once when the simulation changed, else at most every SYNC_INTERVAL_MS', () => {
  assert.equal(syncDue(null, 0, 'a'), true)                              // first frame
  const last = { at: 1000, fingerprint: 'a' }
  assert.equal(syncDue(last, 1010, 'a'), false)                          // same frame of data, too soon
  assert.equal(syncDue(last, 1000 + SYNC_INTERVAL_MS - 1, 'a'), false)
  assert.equal(syncDue(last, 1000 + SYNC_INTERVAL_MS, 'a'), true)        // time alone (freshness ages with the clock)
  assert.equal(syncDue(last, 1010, 'b'), true)                           // new events: at once
  assert.ok(SYNC_INTERVAL_MS <= 250)
})

test('simFingerprint changes with new events, a new or dropped agent and new link messages, not with the clock', () => {
  const links = new Map([['l', { id: 'l', from: 'a', to: 'b', kind: 'spawn', messages: [], dropped: 0 }]]) as unknown as NonNullable<Parameters<typeof simFingerprint>[0]>['links']
  const base = { agents: new Map([['a', agent('a')]]), links, eventIndex: 3, eventLog: [1, 2, 3], droppedEvents: 0, currentTime: 1 } as unknown as NonNullable<Parameters<typeof simFingerprint>[0]>
  const f = simFingerprint(base)
  assert.equal(simFingerprint({ ...base, currentTime: 9 } as typeof base), f)
  assert.notEqual(simFingerprint({ ...base, eventIndex: 4 } as typeof base), f)
  assert.notEqual(simFingerprint({ ...base, eventLog: [1, 2, 3, 4] } as unknown as typeof base), f)
  assert.notEqual(simFingerprint({ ...base, agents: new Map() } as typeof base), f)
  const more = new Map([['l', { id: 'l', from: 'a', to: 'b', kind: 'spawn', messages: [{ id: 'm', type: 'dispatch' }], dropped: 0 }]]) as unknown as typeof links
  assert.notEqual(simFingerprint({ ...base, links: more } as typeof base), f)
  assert.equal(simFingerprint(undefined), '')
})

// The graph badges a node whose loop verdict is proven (repeatMarks) and qualifies an agent whose session lost events:
// the burrow rows carry the same two facts, and nothing when there is no proof.
test('a row carries a proven loop and the events its session could not replay, the same facts the graph shows', () => {
  const { e, st } = setup()
  const loop = { status: 'loop', findings: [{ kind: 'repeat', toolName: 'Read', count: 3, atLeast: false, toolUseIds: [] }], calls: 3, comparable: 3, dropped: 0, lostEvents: 0 }
  const clear = { status: 'clear', findings: [], calls: 3, comparable: 3, dropped: 0, lostEvents: 0 }
  const noFinding = { status: 'loop', findings: [], calls: 3, comparable: 3, dropped: 0, lostEvents: 0 }
  const health = new Map([['a', loop], ['b', clear], ['c', noFinding], ['gone', loop]]) as unknown as NonNullable<Parameters<typeof syncList>[3]['health']>
  const { rows } = syncBurrow(e, st, [agent('a', { sessionId: 's1' }), agent('b', { sessionId: 's2' }), agent('c', { sessionId: 's2' })], {
    ...opts, health, replayLost: new Map([['s1', 7], ['s2', 0]]),
  })
  const row = (id: string) => rows.find((r) => r.id === id)
  assert.equal(row('a')?.loop, true)
  assert.equal(row('b')?.loop, undefined, 'a clear verdict is no badge, never a "no loop"')
  assert.equal(row('c')?.loop, undefined, 'a loop verdict without a finding proves nothing')
  assert.equal(row('a')?.replayLost, 7)
  assert.equal(row('b')?.replayLost, undefined, 'a session with nothing lost says nothing')
  const plain = syncBurrow(setup().e, createBurrowSyncState(), [agent('a', { sessionId: 's1' })], opts).rows[0]
  assert.equal(plain.loop, undefined)
  assert.equal(plain.replayLost, undefined)
})

test('the rows carry their session, and among roots the ones needing attention come first, sub-agents staying under their parent', () => {
  const { e, st } = setup()
  const list = [
    agent('idle1'),
    agent('tool1', { state: 'tool_calling', currentTool: 'Edit' }),
    agent('perm', { state: 'waiting_permission' }),
    agent('err', { state: 'error' }),
    agent('kid', { parentId: 'idle1' }),
  ]
  const { rows } = syncBurrow(e, st, list, opts)
  assert.deepEqual(rows.map((r) => r.id), ['perm', 'err', 'tool1', 'idle1', 'kid'])
  assert.equal(rows[0].sessionId, 's')
  assert.equal(rows[4].depth, 1)
})

test('the posture follows the state: thinking seated, waiting for a permission waving, in error or stale held still, never at random', () => {
  const { e, st } = setup()
  const think = agent('think', { state: 'thinking' })
  const list = [think, agent('wait', { state: 'waiting_permission' }), agent('err', { state: 'error' }),
    agent('old', { state: 'idle', lastEventAt: 1_000_000 - 10 * 60_000 })]
  syncBurrow(e, st, list, opts)
  run(e, 40)
  const actor = (id: string) => e.actors.find((x) => x.key === id)!
  const snap = (id: string) => { const a = actor(id); return { x: a.x, y: a.y, pose: a.pose, mode: a.mode } }
  const before = list.map((a) => snap(a.id))
  for (let i = 0; i < 6; i++) { run(e, 20); syncBurrow(e, st, list, opts) }
  assert.deepEqual(list.map((a) => snap(a.id)), before, 'every posture is held as long as the state')
  assert.equal(actor('think').mode, 'sit')
  assert.ok(['sit', 'sitLeft'].includes(String(actor('think').pose)))
  const wait = actor('wait')
  assert.equal(wait.pose, wait.meta.poses.wave ? 'wave' : null)
  assert.equal(actor('err').pose, null)
  assert.ok(BURROW_ERROR_PLACE.spots.some((p) => p.x === actor('err').x && p.y === actor('err').y), 'in error: at the fixed place of errors')
  const old = actor('old')
  assert.equal(old.pose, old.meta.poses.sleep ? 'sleep' : null)
  assert.ok(BURROW_DATA.map.poi.some((p) => p.id.startsWith('fire') && p.x === old.x && p.y === old.y), 'by the fireside')

  think.state = 'waiting_permission'
  syncBurrow(e, st, list, opts)
  run(e, 40)
  assert.equal(actor('think').mode, 'idle', 'off its seat')
  assert.equal(actor('think').pose, actor('think').meta.poses.wave ? 'wave' : null)
})

test('a stale idle agent that speaks again wakes up: the posture alone is a change the scene follows', () => {
  const { e, st } = setup()
  const a = agent('a', { state: 'idle', lastEventAt: 1_000_000 - 10 * 60_000 })
  syncBurrow(e, st, [a], opts)
  run(e, 40)
  const actor = e.actors.find((x) => x.key === 'a')!
  const { x, y } = actor
  a.lastEventAt = 999_999
  assert.equal(syncBurrow(e, st, [a], opts).changed, true)
  run(e, 60)
  assert.notEqual(actor.pose, 'sleep')
  assert.notEqual(`${actor.x},${actor.y}`, `${x},${y}`, 'idle and live again, it strolls')
})

// An 'All sessions' view: the ring under each animal tells its session or team apart, in the graph's halo colour
test('the rows carry the floor ring colour and the team, only when sessions or teams are to be told apart', () => {
  const { e, st } = setup()
  const one = syncBurrow(e, st, [agent('a'), agent('b', { parentId: 'a' })], opts).rows
  assert.ok(one.every((r) => r.marker === undefined && r.team === undefined), 'one session, no team: no ring')
  const two = syncBurrow(setup().e, createBurrowSyncState(), [
    agent('a', { sessionId: 's1' }),
    agent('m', { sessionId: 's2', teamName: 'alpha', teamKind: 'workflow', teamColor: '#12ab34' }),
    agent('kid', { sessionId: 's2', parentId: 'm' }),
  ], opts).rows
  const row = (id: string) => two.find((r) => r.id === id)
  assert.equal(row('a')?.marker, sessionColor('s1'))
  assert.equal(row('a')?.team, undefined)
  assert.equal(row('m')?.marker, '#12ab34')
  assert.deepEqual(row('m')?.team, { name: 'alpha', kind: 'workflow' })
  assert.equal(row('kid')?.marker, '#12ab34', 'a sub-agent without a team takes its parent\'s')
  assert.deepEqual(row('kid')?.team, { name: 'alpha', kind: 'workflow' })
})

test('a filtered agent of another session does not turn the rings on', () => {
  const { e, st } = setup()
  const { rows } = syncBurrow(e, st, [agent('a', { state: 'thinking' }), agent('old', { sessionId: 's2', state: 'complete' })], { ...opts, hideInactive: true })
  assert.deepEqual(rows.map((r) => r.id), ['a'])
  assert.equal(rows[0].marker, undefined)
})

test('the row of an agent running a tool carries the id of that running call, only when it is proven', () => {
  const { e, st } = setup()
  const call = (id: string, agentId: string, toolName: string, state: string) => [id, { id, agentId, toolName, state }] as const
  const toolCalls = new Map([
    call('t1', 'a', 'Grep', 'complete'),
    call('t2', 'a', 'Grep', 'running'),
    call('t3', 'b', 'Read', 'running'),
    call('t4', 'c', 'Edit', 'complete'),
  ])
  const r = syncBurrow(e, st, [
    agent('a', { state: 'tool_calling', currentTool: 'Grep' }),
    agent('b', { state: 'tool_calling', currentTool: 'Edit' }),
    agent('c', { state: 'tool_calling', currentTool: 'Edit' }),
    agent('d', { state: 'thinking' }),
  ], { ...opts, toolCalls: toolCalls as never })
  const id = (k: string) => r.rows.find((x) => x.id === k)?.toolCallId
  assert.equal(id('a'), 't2')
  assert.equal(id('b'), undefined, 'b runs Edit, the running call is a Read: not proven')
  assert.equal(id('c'), undefined, 'no running call')
  assert.equal(id('d'), undefined)
})

test('two running calls of the tool the bubble names (parallel calls, or an end that was lost): no call is proven, none is opened', () => {
  const { e, st } = setup()
  const call = (id: string, agentId: string, toolName: string, state: string) => [id, { id, agentId, toolName, state }] as const
  const toolCalls = new Map([
    call('t1', 'a', 'Read', 'running'), call('t2', 'a', 'Read', 'running'),
    call('t3', 'b', 'Grep', 'running'), call('t4', 'b', 'Read', 'running'),
  ])
  const r = syncBurrow(e, st, [
    agent('a', { state: 'tool_calling', currentTool: 'Read' }),
    agent('b', { state: 'tool_calling', currentTool: 'Read' }),
  ], { ...opts, toolCalls: toolCalls as never })
  const id = (k: string) => r.rows.find((x) => x.id === k)?.toolCallId
  assert.equal(id('a'), undefined, 'two running Reads: which one the bubble names is a guess')
  assert.equal(id('b'), 't4', 'one running Read among other tools: that one')
})

test('between two tool calls a thinking agent stays in the room of its last tool for up to 10 s, then goes back to the lounge', () => {
  const { e, st } = setup()
  const a = agent('a', { state: 'tool_calling', currentTool: 'Read' })
  const t0 = opts.now
  syncBurrow(e, st, [a], { ...opts, now: t0 })
  assert.equal(e.jobOf('a'), 'library')
  a.state = 'thinking'; a.currentTool = undefined
  const held = syncBurrow(e, st, [a], { ...opts, now: t0 + 3000 })
  assert.equal(e.jobOf('a'), 'library', 'a short think between two Reads does not send it back across the burrow')
  assert.equal(held.rows[0].room, 'library')
  assert.equal(e.actors.find((x) => x.key === 'a')?.said, 'state:thinking', 'the bubble says the state it is in, not the tool')
  syncBurrow(e, st, [a], { ...opts, now: t0 + 11_000 })
  assert.equal(e.jobOf('a'), null, 'a long think: back to the lounge')
  // idle, an error or a permission wait never hold the room
  const b = agent('b', { state: 'tool_calling', currentTool: 'Edit' })
  syncBurrow(e, st, [a, b], { ...opts, now: t0 + 12_000 })
  b.state = 'waiting_permission'; b.currentTool = undefined
  syncBurrow(e, st, [a, b], { ...opts, now: t0 + 12_500 })
  assert.equal(e.jobOf('b'), 'door', 'not the office: the post of the agents that wait for the user')
})
