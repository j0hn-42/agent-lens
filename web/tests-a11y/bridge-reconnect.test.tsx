// Relay restart scenario for the resilient SSE client (#67): fake EventSource, fake timers, jsdom.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import React from 'react'
import { render, cleanup, act } from '@testing-library/react'

import { useReconnectingSource } from '@/hooks/use-reconnecting-source'
import type { SourceStatus, EventSourceLike } from '@/lib/reconnect'
import { BACKOFF_BASE_MS, POLL_INTERVAL_MS } from '@/lib/reconnect'

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

let statusOk = false
let probes = 0
const fetchStatus = async () => { probes++; return { ok: statusOk } }

let received: unknown[] = []
let latest: SourceStatus
function Probe(props: { sessionId?: string | null; enabled?: boolean }) {
  latest = useReconnectingSource({
    enabled: props.enabled ?? true, origin: 'http://127.0.0.1:9', sessionId: props.sessionId ?? null,
    onMessage: d => received.push(d),
    createEventSource: url => new FakeES(url), fetchStatus, random: () => 0,
  })
  return <p>{latest.status}</p>
}

beforeEach(() => {
  FakeES.all = []; received = []; probes = 0; statusOk = false
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
})
afterEach(() => {
  cleanup()
  mock.timers.reset()
})

const tick = async (ms: number) => { await act(async () => { mock.timers.tick(ms); await Promise.resolve() }) }
const agentEvent = (sessionId: string, n: number) => ({ type: 'agent-event', event: { time: n, type: 'x', payload: { n }, sessionId } })

test('relay restart: 3 failures -> polling -> recovery, no duplicates after the replay', async () => {
  render(<Probe />)
  const first = FakeES.last
  assert.equal(first.url, 'http://127.0.0.1:9/events')
  await act(async () => first.open())
  assert.equal(latest.status, 'connected')
  await act(async () => first.send(agentEvent('a', 1)))
  assert.equal(received.length, 1)

  // Relay drops: failure 1 -> retry in 5 s
  await act(async () => first.fail())
  assert.equal(latest.status, 'disconnected')
  assert.equal(latest.detail, 'reconnecting (attempt 1, retry in 5s)')
  assert.equal(first.closed, true)
  await tick(BACKOFF_BASE_MS - 1)
  assert.equal(FakeES.all.length, 1, 'not before the delay')
  await tick(1)
  assert.equal(FakeES.all.length, 2)

  // failure 2 -> retry in 10 s
  await act(async () => FakeES.last.fail())
  assert.equal(latest.detail, 'reconnecting (attempt 2, retry in 10s)')
  await tick(10_000)
  assert.equal(FakeES.all.length, 3)

  // failure 3 -> polling: no more SSE attempts, /status probes instead
  await act(async () => FakeES.last.fail())
  assert.equal(latest.mode, 'polling')
  assert.equal(latest.attempt, 3)
  await tick(POLL_INTERVAL_MS)
  assert.equal(probes, 1)
  assert.equal(FakeES.all.length, 3, 'polling does not open SSE while the relay is unreachable')
  await tick(POLL_INTERVAL_MS)
  assert.equal(probes, 2)
  assert.equal(latest.status, 'disconnected')

  // Relay is back: the probe succeeds, SSE is tried again and opens
  statusOk = true
  await tick(POLL_INTERVAL_MS)
  assert.equal(FakeES.all.length, 4)
  await act(async () => FakeES.last.open())
  assert.equal(latest.status, 'connected')
  assert.equal(latest.mode, 'sse')
  assert.equal(latest.attempt, 0)
  assert.equal(latest.detail, null)

  // The relay replays its buffer: the event already seen is dropped, the new one goes through
  await act(async () => FakeES.last.send(agentEvent('a', 1)))
  await act(async () => FakeES.last.send(agentEvent('a', 2)))
  assert.deepEqual(received.map(m => (m as { event: { payload: { n: number } } }).event.payload.n), [1, 2])
})

test('failed SSE attempt while polling keeps polling', async () => {
  render(<Probe />)
  for (let i = 0; i < 3; i++) {
    await act(async () => FakeES.last.fail())
    if (i < 2) await tick(30_000)
  }
  statusOk = true
  await tick(POLL_INTERVAL_MS)
  await act(async () => FakeES.last.fail())
  assert.equal(latest.mode, 'polling')
  assert.equal(latest.attempt, 4)
})

test('session switch: events and messages of the previous session are ignored', async () => {
  const { rerender } = render(<Probe sessionId="a" />)
  const old = FakeES.last
  assert.equal(old.url, 'http://127.0.0.1:9/events?session=a')
  await act(async () => old.open())
  rerender(<Probe sessionId="b" />)
  assert.equal(old.closed, true)
  const next = FakeES.last
  assert.equal(next.url, 'http://127.0.0.1:9/events?session=b')
  await act(async () => next.open())

  await act(async () => old.send(agentEvent('a', 1)))
  await act(async () => old.fail())
  assert.equal(received.length, 0, 'stale stream is silent')
  assert.equal(latest.status, 'connected', 'stale error does not flip the status')

  await act(async () => next.send(agentEvent('a', 2)))
  assert.equal(received.length, 0, 'event of another session rejected on the live stream')
  await act(async () => next.send(agentEvent('b', 3)))
  assert.equal(received.length, 1)
})

test('stale probe response after a switch is ignored', async () => {
  let release: (v: { ok: boolean }) => void = () => {}
  const slow = () => new Promise<{ ok: boolean }>(r => { release = r })
  function Slow(p: { sessionId: string }) {
    latest = useReconnectingSource({
      enabled: true, origin: '', sessionId: p.sessionId, onMessage: () => {},
      createEventSource: url => new FakeES(url), fetchStatus: slow, random: () => 0,
    })
    return null
  }
  const { rerender } = render(<Slow sessionId="a" />)
  for (let i = 0; i < 3; i++) { await act(async () => FakeES.last.fail()); if (i < 2) await tick(30_000) }
  await tick(POLL_INTERVAL_MS) // probe in flight
  const before = FakeES.all.length
  rerender(<Slow sessionId="b" />)
  const afterSwitch = FakeES.all.length
  assert.equal(afterSwitch, before + 1)
  await act(async () => { release({ ok: true }); await Promise.resolve() })
  assert.equal(FakeES.all.length, afterSwitch, 'late probe of the old selection opens nothing')
})

test('unmount releases the stream and every timer', async () => {
  const { unmount } = render(<Probe />)
  await act(async () => FakeES.last.fail())
  const es = FakeES.last
  unmount()
  assert.equal(es.closed, true)
  await tick(120_000)
  assert.equal(FakeES.all.length, 1, 'no reconnect after unmount')
  assert.equal(probes, 0)
})

test('disabled hook never connects', () => {
  render(<Probe enabled={false} />)
  assert.equal(FakeES.all.length, 0)
})
