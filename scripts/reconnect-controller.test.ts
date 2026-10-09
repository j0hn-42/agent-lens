// Timing and lifecycle of the resilient relay client (#67), through createReconnectingSource with
// a fake EventSource, a fake /status and node's mock timers. Each assertion guards one production line.
import { test, beforeEach, afterEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  createReconnectingSource, createLoadToken, backoffDelay, filterForSession,
  BACKOFF_BASE_MS, CONNECT_TIMEOUT_MS, POLL_AFTER_FAILURES, HEARTBEAT_INTERVAL_MS, SILENCE_TIMEOUT_MS, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, REPLAY_WINDOW_MS, DEDUPE_CAPACITY, createEventDedupe,
  type EventSourceLike, type SourceStatus,
} from '../web/lib/reconnect'

class FakeES implements EventSourceLike {
  static all: FakeES[] = []
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  closed = false
  constructor(public url: string) { FakeES.all.push(this) }
  close() { this.closed = true }
  open() { this.onopen?.({}) }
  send(msg: unknown) { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }) }
  fail() { this.onerror?.({}) }
  static get last() { return FakeES.all[FakeES.all.length - 1] }
}

interface Probe { url: string; signal: AbortSignal; resolve(v: { ok: boolean }): void; reject(e: unknown): void }
let probes: Probe[] = []
/** A /status that stays pending until the test settles it; optionally it rejects when aborted, like fetch */
const hangingFetch = (rejectOnAbort: boolean) => (url: string, signal: AbortSignal) =>
  new Promise<{ ok: boolean }>((resolve, reject) => {
    probes.push({ url, signal, resolve, reject })
    if (rejectOnAbort) signal.addEventListener('abort', () => reject(new Error('aborted')))
  })

let statuses: SourceStatus[] = []
let messages: unknown[] = []
let parseErrors = 0
const last = () => statuses[statuses.length - 1]
const flush = () => new Promise<void>(r => setImmediate(r))
const tick = async (ms: number) => { mock.timers.tick(ms); await flush() }

function start(over: Partial<Parameters<typeof createReconnectingSource>[0]> = {}) {
  return createReconnectingSource({
    url: 'http://relay/events', statusUrl: 'http://relay/status', loadToken: createLoadToken(),
    onMessage: d => messages.push(d), onStatus: s => statuses.push(s), onParseError: () => { parseErrors++ },
    createEventSource: u => new FakeES(u), fetchStatus: hangingFetch(true), random: () => 0, ...over,
  })
}

/** Three SSE failures: the client is polling and the first probe is scheduled POLL_INTERVAL_MS from now */
async function intoPolling() {
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  FakeES.last.fail()
  await tick(2 * BACKOFF_BASE_MS)
  FakeES.last.fail()
  assert.equal(last().mode, 'polling')
}

beforeEach(() => {
  FakeES.all = []; probes = []; statuses = []; messages = []; parseErrors = 0
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
})
afterEach(() => mock.timers.reset())

test('probe period is exactly POLL_INTERVAL_MS, and it repeats after a failed probe', async () => {
  start()
  await intoPolling()
  await tick(POLL_INTERVAL_MS - 1)
  assert.equal(probes.length, 0, 'not one ms early')
  await tick(1)
  assert.equal(probes.length, 1)
  probes[0].resolve({ ok: false })
  await flush()
  assert.equal(last().attempt, 4)
  assert.equal(last().detail, 'reconnecting (attempt 4, retry in 5s)')
  await tick(POLL_INTERVAL_MS - 1)
  assert.equal(probes.length, 1)
  await tick(1)
  assert.equal(probes.length, 2)
  assert.equal(probes[0].url, 'http://relay/status')
})

test('a hanging /status is aborted after POLL_TIMEOUT_MS and counted as a failed probe', async () => {
  assert.ok(POLL_TIMEOUT_MS < POLL_INTERVAL_MS)
  start()
  await intoPolling()
  await tick(POLL_INTERVAL_MS)
  assert.equal(probes.length, 1)
  await tick(POLL_TIMEOUT_MS - 1)
  assert.equal(probes[0].signal.aborted, false, 'still waiting one ms before the timeout')
  assert.equal(last().attempt, 3)
  await tick(1)
  assert.equal(probes[0].signal.aborted, true, 'aborted exactly at the timeout')
  assert.equal(last().attempt, 4, 'the abort is a failure')
  assert.equal(last().mode, 'polling')
  assert.equal(FakeES.all.length, 3, 'no SSE attempt after a hung probe')
  await tick(POLL_INTERVAL_MS)
  assert.equal(probes.length, 2, 'polling goes on')
})

test('a probe that answers is not aborted later by its own timeout', async () => {
  start()
  await intoPolling()
  await tick(POLL_INTERVAL_MS)
  probes[0].resolve({ ok: true })
  await flush()
  assert.equal(FakeES.all.length, 4, 'relay answered: SSE retried')
  await tick(10 * POLL_TIMEOUT_MS)
  assert.equal(probes[0].signal.aborted, false)
})

test('close() during an in-flight probe aborts it and a late rejection arms nothing', async () => {
  const src = start({ fetchStatus: hangingFetch(false) })
  await intoPolling()
  await tick(POLL_INTERVAL_MS)
  src.close()
  assert.equal(probes[0].signal.aborted, true, 'the in-flight request is cancelled')
  const before = statuses.length
  probes[0].reject(new Error('late'))
  await flush()
  await tick(10 * POLL_INTERVAL_MS)
  assert.equal(probes.length, 1, 'no new probe: no timer was armed after close')
  assert.equal(statuses.length, before, 'no status after close')
  assert.equal(FakeES.all.length, 3)
})

test('close() during an in-flight probe ignores a late success', async () => {
  const src = start({ fetchStatus: hangingFetch(false) })
  await intoPolling()
  await tick(POLL_INTERVAL_MS)
  src.close()
  probes[0].resolve({ ok: true })
  await flush()
  assert.equal(FakeES.all.length, 3, 'no SSE opened after close')
})

test('close() of an older source does not invalidate the newer one sharing the token', () => {
  const token = createLoadToken()
  const a = start({ loadToken: token, onMessage: () => {} })
  const first = FakeES.last
  start({ loadToken: token })
  const second = FakeES.last
  a.close()
  assert.equal(first.closed, true)
  assert.equal(second.closed, false)
  second.open()
  second.send({ type: 'agent-event', event: { time: 1, type: 'x', payload: {} } })
  assert.equal(messages.length, 1, 'the live source still delivers')
  assert.equal(last().status, 'connected')
})

test('statusUrl is what gets probed', async () => {
  start({ statusUrl: 'http://other:9/status' })
  await intoPolling()
  await tick(POLL_INTERVAL_MS)
  assert.equal(probes[0].url, 'http://other:9/status')
})

test('malformed frames raise onParseError and are not delivered', () => {
  start()
  FakeES.last.open()
  FakeES.last.send('{nope')
  assert.equal(parseErrors, 1)
  assert.equal(messages.length, 0)
  FakeES.last.send({ type: 'connection-status' })
  assert.equal(parseErrors, 1)
  assert.equal(messages.length, 1)
})

const ev = (n: number) => ({ time: n, type: 'x', payload: { n }, sessionId: 's' })
const ns = (m: unknown) => (m as { events: Array<{ time: number }> }).events.map(e => e.time)

test('batches: replayed events are dropped after a reconnect, fresh ones kept, an all-replay batch is swallowed', async () => {
  start()
  FakeES.last.open()
  FakeES.last.send({ type: 'agent-event-batch', events: [ev(1), ev(2)] })
  assert.deepEqual(ns(messages[0]), [1, 2], 'first connection delivers everything')
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  FakeES.last.open()
  FakeES.last.send({ type: 'agent-event-batch', events: [ev(1), ev(3), ev(2)] })
  assert.equal(messages.length, 2)
  assert.deepEqual(ns(messages[1]), [3])
  FakeES.last.send({ type: 'agent-event-batch', events: [ev(1), ev(2)] })
  assert.equal(messages.length, 2, 'fully replayed batch not delivered')
})

test('the replay window closes after REPLAY_WINDOW_MS: later identical events are delivered again', async () => {
  start()
  FakeES.last.open()
  FakeES.last.send({ type: 'agent-event', event: ev(1) })
  FakeES.last.fail()
  await tick(BACKOFF_BASE_MS)
  FakeES.last.open()
  await tick(REPLAY_WINDOW_MS - 1)
  FakeES.last.send({ type: 'agent-event', event: ev(1) })
  assert.equal(messages.length, 1, 'one ms before the end of the window: dropped')
  await tick(1)
  FakeES.last.send({ type: 'agent-event', event: ev(1) })
  assert.equal(messages.length, 2, 'at the end of the window: delivered')
  await tick(1)
  FakeES.last.send({ type: 'agent-event', event: ev(1) })
  assert.equal(messages.length, 3, 'after the window: delivered')
})

test('the window restarts on every reconnect', async () => {
  start()
  FakeES.last.open()
  FakeES.last.send({ type: 'agent-event', event: ev(1) })
  for (let i = 0; i < 2; i++) {
    FakeES.last.fail()
    await tick(BACKOFF_BASE_MS)
    FakeES.last.open()
    FakeES.last.send({ type: 'agent-event', event: ev(1) })
    await tick(REPLAY_WINDOW_MS + 1)
  }
  assert.equal(messages.length, 1)
})

test('backoffDelay ignores a random() that is not a number', () => {
  assert.equal(backoffDelay(1, () => NaN), BACKOFF_BASE_MS)
  assert.equal(backoffDelay(2, () => Infinity), 2 * BACKOFF_BASE_MS)
})

test('filterForSession drops non-object entries of a batch', () => {
  const e = { time: 1, type: 'x', payload: {}, sessionId: 'a' }
  const out = filterForSession({ type: 'agent-event-batch', events: [null, 1, 'x', e] }, 'a') as { events: unknown[] }
  assert.deepEqual(out.events, [e])
  assert.equal(filterForSession({ type: 'agent-event-batch', events: [null, 1, 'x'] }, 'a'), null)
})

test('session-updated of another session is rejected, of the requested one kept', () => {
  assert.equal(filterForSession({ type: 'session-updated', sessionId: 'b', label: 'l' }, 'a'), null)
  assert.notEqual(filterForSession({ type: 'session-updated', sessionId: 'a', label: 'l' }, 'a'), null)
})

test('dedupe capacity: the oldest entry survives exactly DEDUPE_CAPACITY insertions and goes at the next', () => {
  const d = createEventDedupe()
  for (let i = 0; i < DEDUPE_CAPACITY - 1; i++) d.seen({ i })
  assert.equal(d.size, DEDUPE_CAPACITY - 1)
  d.seen({ i: DEDUPE_CAPACITY - 1 })
  assert.equal(d.size, DEDUPE_CAPACITY, 'at the limit nothing is evicted')
  assert.equal(d.seen({ i: 1 }), true, 'still remembered at the limit')
  d.seen({ i: DEDUPE_CAPACITY })
  assert.equal(d.size, DEDUPE_CAPACITY, 'one above: bounded')
  assert.equal(d.seen({ i: 0 }), false, 'the oldest was evicted')
})

test('a probe that fails by itself is not aborted later by its own timeout', async () => {
  start()
  await intoPolling()
  await tick(POLL_INTERVAL_MS)
  probes[0].reject(new Error('refused'))
  await flush()
  await tick(POLL_TIMEOUT_MS)
  assert.equal(probes[0].signal.aborted, false)
})

test('only events of the requested session reach onMessage', () => {
  start({ sessionId: 'a' })
  FakeES.last.open()
  FakeES.last.send({ type: 'agent-event', event: { time: 1, type: 'x', payload: {}, sessionId: 'b' } })
  assert.equal(messages.length, 0)
  FakeES.last.send({ type: 'agent-event', event: { time: 2, type: 'x', payload: {}, sessionId: 'a' } })
  assert.equal(messages.length, 1)
})

// Silence detection (#141)

test('silence: no byte for SILENCE_TIMEOUT_MS closes the stream, shows it lost and reconnects with backoff', async () => {
  start()
  FakeES.last.open()
  assert.equal(last().status, 'connected')
  await tick(SILENCE_TIMEOUT_MS - 1)
  assert.equal(last().status, 'connected', 'not one ms early')
  assert.equal(FakeES.last.closed, false)
  await tick(1)
  assert.equal(FakeES.all[0].closed, true)
  assert.equal(last().status, 'disconnected')
  assert.equal(last().attempt, 1)
  assert.equal(last().detail, 'reconnecting (attempt 1, retry in 5s)')
  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.all.length, 2, 'a new connection is attempted after the backoff')
})

test('silence: a heartbeat keeps the stream alive and never reaches the consumer', async () => {
  start()
  FakeES.last.open()
  for (let i = 0; i < 10; i++) {
    await tick(HEARTBEAT_INTERVAL_MS)
    FakeES.last.send({ type: 'heartbeat' })
  }
  assert.equal(last().status, 'connected')
  assert.equal(FakeES.all.length, 1)
  assert.deepEqual(messages, [])
  await tick(SILENCE_TIMEOUT_MS)
  assert.equal(last().status, 'disconnected', 'beats stopped: silence detected')
})

test('silence: any real message also counts as life', async () => {
  start()
  FakeES.last.open()
  await tick(SILENCE_TIMEOUT_MS - 1)
  FakeES.last.send({ type: 'session-list', sessions: [] })
  await tick(SILENCE_TIMEOUT_MS - 1)
  assert.equal(last().status, 'connected')
  assert.equal(messages.length, 1)
})

test('silence: recovery resets the failure counter once the new stream opens', async () => {
  start()
  FakeES.last.open()
  await tick(SILENCE_TIMEOUT_MS)
  await tick(BACKOFF_BASE_MS)
  FakeES.last.open()
  assert.equal(last().status, 'connected')
  assert.equal(last().attempt, 0)
  await tick(SILENCE_TIMEOUT_MS - 1)
  assert.equal(last().status, 'connected', 'the watchdog restarts with the new stream')
})

test('silence: close() stops the watchdog of an open stream', async () => {
  const source = start()
  FakeES.last.open()
  source.close()
  await tick(10 * SILENCE_TIMEOUT_MS)
  assert.equal(FakeES.all.length, 1)
})

// Connection guard (#207): a request that never answers must not stay "connecting" forever

test('connect timeout: a source that never fires onopen nor onerror is closed and retried with backoff', async () => {
  start()
  assert.equal(last().status, 'connecting')
  await tick(CONNECT_TIMEOUT_MS - 1)
  assert.equal(FakeES.all.length, 1)
  assert.equal(FakeES.last.closed, false, 'not one ms early')
  await tick(1)
  assert.equal(FakeES.all[0].closed, true)
  assert.equal(last().status, 'disconnected')
  assert.equal(last().attempt, 1)
  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.all.length, 2, 'a new attempt is scheduled')
})

test('connect timeout: repeated hangs switch to polling after POLL_AFTER_FAILURES', async () => {
  start()
  for (let i = 0; i < POLL_AFTER_FAILURES; i++) {
    await tick(CONNECT_TIMEOUT_MS)
    if (i < POLL_AFTER_FAILURES - 1) await tick(backoffDelay(i + 1, () => 0))
  }
  assert.equal(last().status, 'disconnected')
  assert.equal(last().mode, 'polling')
  await tick(POLL_INTERVAL_MS)
  assert.equal(probes.length, 1, 'the reachability probe runs')
})

test('connect timeout: onopen in time disarms the connect guard, close() cancels it', async () => {
  const source = start()
  await tick(CONNECT_TIMEOUT_MS - 1)
  FakeES.last.open()
  await tick(SILENCE_TIMEOUT_MS - 1)
  assert.equal(last().status, 'connected')
  source.close()
  await tick(10 * CONNECT_TIMEOUT_MS)
  assert.equal(FakeES.all.length, 1)
})
