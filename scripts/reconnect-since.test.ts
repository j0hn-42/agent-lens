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
