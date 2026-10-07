import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  BACKOFF_BASE_MS, BACKOFF_MAX_MS, POLL_AFTER_FAILURES, BACKOFF_JITTER_RATIO,
  backoffDelay, nextLinkState, INITIAL_LINK_STATE, reconnectDetail, createLoadToken,
  filterForSession, messageSessionIds, createEventDedupe, type LinkState, type LinkEvent,
} from '../web/lib/reconnect'

test('named thresholds match the issue (5 s to 30 s, polling after 3 failures)', () => {
  assert.equal(BACKOFF_BASE_MS, 5_000)
  assert.equal(BACKOFF_MAX_MS, 30_000)
  assert.equal(POLL_AFTER_FAILURES, 3)
})

test('backoffDelay doubles from 5 s and caps at 30 s (no jitter)', () => {
  const table: Array<[number, number]> = [[1, 5_000], [2, 10_000], [3, 20_000], [4, 30_000], [5, 30_000], [50, 30_000], [0, 5_000], [-3, 5_000], [NaN, 5_000]]
  for (const [attempt, ms] of table) assert.equal(backoffDelay(attempt, () => 0), ms, `attempt ${attempt}`)
})

test('backoffDelay jitter is injected, only adds, and never exceeds the ceiling', () => {
  assert.equal(backoffDelay(1, () => 1), Math.round(5_000 * (1 + BACKOFF_JITTER_RATIO)))
  assert.equal(backoffDelay(1, () => 0.5), 5_500)
  assert.equal(backoffDelay(4, () => 1), BACKOFF_MAX_MS)
  assert.equal(backoffDelay(1, () => -5), 5_000)
  assert.equal(backoffDelay(1, () => 9), 6_000)
})

test('link state machine: polling after 3 failures, sticky until open', () => {
  const table: Array<{ from: LinkState; ev: LinkEvent; to: LinkState }> = [
    { from: INITIAL_LINK_STATE, ev: 'error', to: { mode: 'sse', failures: 1 } },
    { from: { mode: 'sse', failures: 1 }, ev: 'error', to: { mode: 'sse', failures: 2 } },
    { from: { mode: 'sse', failures: 2 }, ev: 'error', to: { mode: 'polling', failures: 3 } },
    { from: { mode: 'polling', failures: 3 }, ev: 'probe-failed', to: { mode: 'polling', failures: 4 } },
    { from: { mode: 'polling', failures: 4 }, ev: 'error', to: { mode: 'polling', failures: 5 } },
    { from: { mode: 'polling', failures: 5 }, ev: 'open', to: INITIAL_LINK_STATE },
    { from: { mode: 'sse', failures: 2 }, ev: 'open', to: INITIAL_LINK_STATE },
  ]
  for (const { from, ev, to } of table) assert.deepEqual(nextLinkState(from, ev), to, `${from.mode}/${from.failures} + ${ev}`)
})

test('reconnectDetail wording', () => {
  assert.equal(reconnectDetail(2, 10_000), 'reconnecting (attempt 2, retry in 10s)')
  assert.equal(reconnectDetail(1, 5_500), 'reconnecting (attempt 1, retry in 6s)')
})

test('load token: only the latest token is current', () => {
  const t = createLoadToken()
  const a = t.next()
  assert.equal(t.isCurrent(a), true)
  const b = t.next()
  assert.ok(b > a)
  assert.equal(t.isCurrent(a), false)
  assert.equal(t.isCurrent(b), true)
})

const ev = (sessionId?: string) => ({ time: 1, type: 'x', payload: {}, ...(sessionId ? { sessionId } : {}) })

test('filterForSession keeps everything when no session is requested', () => {
  const m = { type: 'agent-event', event: ev('a') }
  assert.equal(filterForSession(m, null), m)
  assert.equal(filterForSession(m, undefined), m)
})

test('filterForSession rejects other sessions for every message kind', () => {
  const table: Array<[string, unknown, boolean]> = [
    ['event same', { type: 'agent-event', event: ev('a') }, true],
    ['event other', { type: 'agent-event', event: ev('b') }, false],
    ['event unnamed', { type: 'agent-event', event: ev() }, true],
    ['started other', { type: 'session-started', session: { id: 'b' } }, false],
    ['started same', { type: 'session-started', session: { id: 'a' } }, true],
    ['ended other', { type: 'session-ended', sessionId: 'b' }, false],
    ['updated same', { type: 'session-updated', sessionId: 'a', label: 'l' }, true],
    ['status', { type: 'connection-status', status: 'connected' }, true],
    ['junk', 'str', true],
  ]
  for (const [name, msg, kept] of table) assert.equal(filterForSession(msg, 'a') !== null, kept, name)
})

test('filterForSession filters batches event by event', () => {
  const out = filterForSession({ type: 'agent-event-batch', events: [ev('a'), ev('b'), ev('a')] }, 'a') as { events: unknown[] }
  assert.equal(out.events.length, 2)
  assert.equal(filterForSession({ type: 'agent-event-batch', events: [ev('b')] }, 'a'), null)
})

test('messageSessionIds tolerates hostile shapes', () => {
  for (const bad of [null, 3, [], { type: 'agent-event' }, { type: 'agent-event', event: 5 }, { type: 'agent-event-batch', events: 'x' }])
    assert.deepEqual(messageSessionIds(bad), [])
})

test('event dedupe: second sighting is reported, capacity evicts the oldest', () => {
  const d = createEventDedupe(2)
  assert.equal(d.seen(ev('a')), false)
  assert.equal(d.seen(ev('a')), true)
  d.seen(ev('b')); d.seen(ev('c'))
  assert.equal(d.size, 2)
  assert.equal(d.seen(ev('a')), false, 'evicted entry is forgotten')
})
