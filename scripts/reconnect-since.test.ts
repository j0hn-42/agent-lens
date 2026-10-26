// Resume point of the relay client (#366): the controller keeps the relay's cursor (instance and last number received,
// from `relay-cursor` then the `seq` of each live event) and sends it back as ?since= when it reconnects, so the relay can
// count what the cut link lost. The first connection sends none; a malformed cursor or number is ignored.
import { test, beforeEach, afterEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { createReconnectingSource, createLoadToken, BACKOFF_BASE_MS, type EventSourceLike } from '../web/lib/reconnect'

class FakeES implements EventSourceLike {
  static all: FakeES[] = []
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  closed = false
  constructor(public url: string) { FakeES.all.push(this) }
  close() { this.closed = true }
  open() { this.onopen?.({}) }
  send(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  fail() { this.onerror?.({}) }
  static get last() { return FakeES.all[FakeES.all.length - 1] }
}

let messages: unknown[] = []
const flush = () => new Promise<void>(r => setImmediate(r))
const tick = async (ms: number) => { mock.timers.tick(ms); await flush() }
const INSTANCE = 'a1b2c3d4e5f60718'

function start(url = 'http://relay/events') {
  return createReconnectingSource({
    url, statusUrl: 'http://relay/status', loadToken: createLoadToken(),
    onMessage: d => messages.push(d), onStatus: () => {},
    createEventSource: u => new FakeES(u), fetchStatus: async () => ({ ok: true }), random: () => 0,
  })
}

beforeEach(() => {
  FakeES.all = []; messages = []
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
})
afterEach(() => mock.timers.reset())

/** URL of the reconnection after a connection that received `cursor` (or nothing when undefined) */
async function reconnectUrlAfter(cursor: unknown, url = 'http://relay/events'): Promise<string> {
  FakeES.all = []
  const src = start(url)
  FakeES.last.open()
  if (cursor !== undefined) FakeES.last.send(cursor)
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  const next = FakeES.last.url
  src.close()
  return next
}

test('only a valid cursor is kept: a hex instance and a safe non-negative number', async () => {
  assert.equal(await reconnectUrlAfter({ type: 'relay-cursor', instance: INSTANCE, seq: 4 }), `http://relay/events?since=${INSTANCE}.4`)
  for (const bad of [{ type: 'relay-cursor' }, { type: 'relay-cursor', instance: 'XYZ!', seq: 1 }, { type: 'relay-cursor', instance: INSTANCE, seq: -1 },
    { type: 'relay-cursor', instance: INSTANCE, seq: 1.5 }, { type: 'relay-cursor', instance: 'a'.repeat(65), seq: 1 }, { type: 'relay-cursor', instance: INSTANCE }]) {
    assert.equal(await reconnectUrlAfter(bad), 'http://relay/events', JSON.stringify(bad))
  }
})

test('the parameter is appended to a URL with or without a query', async () => {
  assert.equal(await reconnectUrlAfter(undefined), 'http://relay/events')
  assert.equal(await reconnectUrlAfter({ type: 'relay-cursor', instance: INSTANCE, seq: 7 }, 'http://relay/events?session=s1'), `http://relay/events?session=s1&since=${INSTANCE}.7`)
})

test('first connection: no since; the reconnection sends the cursor advanced by the live events received', async () => {
  start()
  assert.equal(FakeES.last.url, 'http://relay/events')
  FakeES.last.open()
  FakeES.last.send({ type: 'relay-cursor', instance: INSTANCE, seq: 10 })
  FakeES.last.send({ type: 'agent-event', event: { time: 1, type: 'x', sessionId: 's' }, seq: 11 })
  FakeES.last.send({ type: 'agent-event', event: { time: 2, type: 'x', sessionId: 's' }, seq: 13 })
  FakeES.last.send({ type: 'agent-event', event: { time: 3, type: 'x', sessionId: 's' }, seq: 'junk' })
  assert.equal(messages.some(m => (m as { type?: string }).type === 'relay-cursor'), false, 'the cursor is the controller\'s, not a message for the app')
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.last.url, `http://relay/events?since=${INSTANCE}.13`)
})

test('a connection that got no cursor sends none; a newer cursor (relay restarted) replaces the old one', async () => {
  start('http://relay/events?session=s1')
  FakeES.last.open()
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.last.url, 'http://relay/events?session=s1', 'no cursor received: nothing to resume from')
  FakeES.last.open()
  FakeES.last.send({ type: 'relay-cursor', instance: INSTANCE, seq: 50 })
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  FakeES.last.open()
  FakeES.last.send({ type: 'relay-cursor', instance: 'ffffffffffffffff', seq: 2 })
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.last.url, 'http://relay/events?session=s1&since=ffffffffffffffff.2')
})

// #653: what the client does at a reconnection decides whether the relay may replay only what was missed.
test('a reconnection keeps what was delivered: nothing tells the app to empty its graph, the cursor is sent back (#653)', async () => {
  start()
  FakeES.last.open()
  FakeES.last.send({ type: 'relay-cursor', instance: INSTANCE, seq: 10 })
  const ev = { time: 1, type: 'message', sessionId: 's' }
  FakeES.last.send({ type: 'agent-event', event: ev, seq: 11 })
  const before = messages.length
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.last.url, `http://relay/events?since=${INSTANCE}.11`)
  FakeES.last.open()
  FakeES.last.send({ type: 'agent-event', event: { time: 2, type: 'message', sessionId: 's' }, seq: 12 })
  const types = messages.map(m => (m as { type?: string }).type)
  assert.equal(messages.length, before + 1, 'only the new event reaches the app; the earlier ones stay delivered')
  assert.ok(!types.includes('reset'), 'no reset message')
  // A replayed copy of an event already delivered is still dropped (a relay of an older version replays everything)
  FakeES.last.send({ type: 'agent-event', event: ev })
  assert.equal(messages.length, before + 1, 'a replayed duplicate is dropped')
})

// #613: the graph of the app after a reconnection is what proves the behaviour, not the absence of a message.
// The messages go through the real bridge (web/lib/vscode-bridge.ts) and the real reducer of the simulation
// (processEvent), the way the page consumes them. Not covered: the `reset` handling of the page hook.
test('the simulation graph keeps every agent across a reconnection, whether the relay honours since or replays everything (#613)', async () => {
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  const { toSimulationEvent } = await import('../web/lib/bridge-types')
  const { processEvent } = await import('../web/hooks/simulation/process-event')
  const { createEmptyState } = await import('../web/hooks/simulation/types')
  g.window = { addEventListener: () => {}, removeEventListener: () => {} }
  try {
    const { vscodeBridge } = await import('../web/lib/vscode-bridge')
    assert.ok(vscodeBridge, 'the bridge exists')
    const ctx = { syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }), getContextWindowSize: () => 200_000, blockIdCounter: { current: 0 }, skipForceSync: true }
    let state = createEmptyState()
    const off = vscodeBridge.onEvent(e => { state = processEvent(toSimulationEvent(e), state, ctx) })
    const names = () => Array.from(state.agents.values()).map(a => a.name).sort()
    const spawn = (n: number) => ({ time: n, type: 'agent_spawn', sessionId: 's', payload: n === 1 ? { name: 'orchestrator', isMain: true } : { name: `worker-${n}`, parent: 'orchestrator' } })
    const live = (n: number) => ({ type: 'agent-event', event: spawn(n), seq: 10 + n })
    try {
      const src = createReconnectingSource({
        url: 'http://relay/events', statusUrl: 'http://relay/status', loadToken: createLoadToken(),
        onMessage: d => vscodeBridge.dispatch(d), onStatus: () => {},
        createEventSource: u => new FakeES(u), fetchStatus: async () => ({ ok: true }), random: () => 0,
      })
      FakeES.last.open()
      FakeES.last.send({ type: 'relay-cursor', instance: INSTANCE, seq: 10 })
      for (const n of [1, 2, 3]) FakeES.last.send(live(n))
      assert.deepEqual(names(), ['orchestrator', 'worker-2', 'worker-3'], 'precondition: the graph holds the live agents')
      FakeES.last.fail()
      await tick(BACKOFF_BASE_MS)
      assert.equal(FakeES.last.url, `http://relay/events?since=${INSTANCE}.13`, 'precondition: the cursor is sent back')
      // A relay that honours since: only what is numbered after it
      FakeES.last.open()
      FakeES.last.send({ type: 'agent-event-batch', events: [spawn(4)] })
      assert.deepEqual(names(), ['orchestrator', 'worker-2', 'worker-3', 'worker-4'], 'the graph kept its agents and gained the missing one')
      // A relay that ignores since (older, other instance) replays everything: copies are not added a second time
      FakeES.last.fail()
      await tick(BACKOFF_BASE_MS)
      FakeES.last.open()
      FakeES.last.send({ type: 'agent-event-batch', events: [1, 2, 3, 4, 5].map(spawn) })
      assert.deepEqual(names(), ['orchestrator', 'worker-2', 'worker-3', 'worker-4', 'worker-5'], 'each agent once, plus the new one')
      assert.equal(state.agents.size, 5)
      src.close()
    } finally { off() }
  } finally {
    if (!hadWindow) delete g.window
  }
})
