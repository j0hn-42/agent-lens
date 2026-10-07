// useVSCodeBridge wiring of the resilient relay client (#67): the real hook, a fake EventSource and fake
// timers. Covers relayEnabled, status mapping, relay-down / relay-up / parse-error notices, the detail
// fields, the relaySessionId option and the offline fallback. The VS Code case runs last: the bridge
// singleton cannot leave VS Code mode once it entered it.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'

import { useVSCodeBridge, PARSE_NOTICE_INTERVAL_MS } from '@/hooks/use-vscode-bridge'
import { BACKOFF_BASE_MS, POLL_INTERVAL_MS } from '@/lib/reconnect'

class FakeES {
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

const g = globalThis as unknown as Record<string, unknown>
const ENV_KEYS = ['AGENT_LENS_STANDALONE', 'NODE_ENV', 'NEXT_PUBLIC_DEMO', 'NEXT_PUBLIC_RELAY_PORT'] as const
const savedEnv: Record<string, string | undefined> = {}
const setEnv = (k: (typeof ENV_KEYS)[number], v: string | undefined) => {
  const env = process.env as Record<string, string | undefined>
  if (v === undefined) delete env[k]; else env[k] = v
}
let posted: unknown[] = []
const realPostMessage = window.postMessage
let statusFetches = 0
let statusUrls: string[] = []
let statusOk = false

const relayEnv = (port = '4321') => {
  setEnv('AGENT_LENS_STANDALONE', '1')
  setEnv('NEXT_PUBLIC_RELAY_PORT', port)
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  for (const k of ENV_KEYS) if (k !== 'NODE_ENV') setEnv(k, undefined)
  FakeES.all = []; posted = []; statusFetches = 0; statusUrls = []; statusOk = false
  g.EventSource = FakeES
  g.fetch = async (url: string) => { statusFetches++; statusUrls.push(url); return { ok: statusOk } }
  ;(window as unknown as { postMessage: unknown }).postMessage = (d: unknown) => { posted.push(d) }
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  mock.method(Math, 'random', () => 0) // no jitter: exact delays
})
afterEach(() => {
  cleanup()
  mock.timers.reset()
  mock.restoreAll()
  for (const k of ENV_KEYS) setEnv(k, savedEnv[k])
  window.postMessage = realPostMessage
})

const tick = async (ms: number) => { await act(async () => { mock.timers.tick(ms); await Promise.resolve() }) }
const agentEvent = (sessionId: string, n: number) => ({ type: 'agent-event', event: { time: n, type: 'x', payload: { n }, sessionId } })

test('relay mode (standalone): connects to the configured relay port and maps the stream status', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.all.length, 1)
  assert.equal(FakeES.last.url, 'http://127.0.0.1:4321/events')
  assert.equal(result.current.relayPort, '4321')
  assert.equal(result.current.connectionStatus, 'connecting')
  assert.equal(result.current.useMockData, true, 'demo data until a relay is connected')
  assert.equal(result.current.relayUnreachable, false)
  assert.equal(result.current.connectionDetail, null)
  assert.equal(result.current.reconnectAttempt, 0)
  assert.equal(result.current.relayLinkMode, 'sse')

  await act(async () => FakeES.last.open())
  assert.equal(result.current.connectionStatus, 'connected')
  assert.equal(result.current.useMockData, false, 'connected relay replaces the demo')
  assert.equal(result.current.notice, null, 'a first connection is not a "reconnected" event')
})

test('relay mode without a port uses the same origin', () => {
  relayEnv('')
  renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.last.url, '/events')
})

test('relay mode via the dev server needs NEXT_PUBLIC_DEMO=0', () => {
  setEnv('NODE_ENV', 'development')
  setEnv('NEXT_PUBLIC_DEMO', '1')
  renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.all.length, 0, 'demo dev server: no relay')
  cleanup()
  setEnv('NEXT_PUBLIC_DEMO', '0')
  renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.all.length, 1, 'dev server with a real relay')
})

test('production build outside standalone has no relay', () => {
  setEnv('NODE_ENV', 'production')
  setEnv('NEXT_PUBLIC_DEMO', '0')
  renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.all.length, 0)
})

test('drop: disconnected status, relay-down notice once, detail and counters, then reconnected notice', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())

  await act(async () => FakeES.last.fail())
  assert.equal(result.current.connectionStatus, 'disconnected')
  assert.equal(result.current.relayUnreachable, true)
  assert.equal(result.current.connectionDetail, 'reconnecting (attempt 1, retry in 5s)')
  assert.equal(result.current.reconnectAttempt, 1)
  assert.equal(result.current.notice?.kind, 'relay-down')
  assert.equal(result.current.notice?.message, 'Relay unreachable on :4321')
  const downId = result.current.notice?.id

  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.all.length, 2)
  await act(async () => FakeES.last.fail())
  assert.equal(result.current.reconnectAttempt, 2)
  assert.equal(result.current.connectionDetail, 'reconnecting (attempt 2, retry in 10s)')
  assert.equal(result.current.notice?.id, downId, 'no second relay-down notice for the same outage')

  await tick(2 * BACKOFF_BASE_MS)
  await act(async () => FakeES.last.fail())
  assert.equal(result.current.relayLinkMode, 'polling')
  assert.equal(result.current.reconnectAttempt, 3)
  assert.equal(result.current.notice?.id, downId)

  // Relay answers again: polling probe, SSE retried, reconnected
  statusOk = true
  await tick(POLL_INTERVAL_MS)
  assert.equal(statusFetches, 1)
  assert.deepEqual(statusUrls, ['http://127.0.0.1:4321/status'])
  assert.equal(FakeES.all.length, 4)
  await act(async () => FakeES.last.open())
  assert.equal(result.current.connectionStatus, 'connected')
  assert.equal(result.current.relayUnreachable, false)
  assert.equal(result.current.connectionDetail, null)
  assert.equal(result.current.reconnectAttempt, 0)
  assert.equal(result.current.relayLinkMode, 'sse')
  assert.equal(result.current.notice?.kind, 'relay-up')
  assert.equal(result.current.notice?.message, 'Relay reconnected')

  // A new outage announces itself again
  await act(async () => FakeES.last.fail())
  assert.equal(result.current.notice?.kind, 'relay-down')
})

test('relay-down message without a port', async () => {
  relayEnv('')
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.fail())
  assert.equal(result.current.notice?.message, 'Relay unreachable')
})

test('relay messages are forwarded to the window; malformed ones raise a rate-limited parse-error notice', async () => {
  relayEnv()
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send(agentEvent('a', 1)))
  assert.deepEqual(posted, [agentEvent('a', 1)])

  await act(async () => FakeES.last.send('{nope'))
  assert.equal(result.current.notice?.kind, 'parse-error')
  assert.equal(posted.length, 1, 'junk is not forwarded')
  const id = result.current.notice?.id
  await tick(PARSE_NOTICE_INTERVAL_MS - 1)
  await act(async () => FakeES.last.send('{nope'))
  assert.equal(result.current.notice?.id, id, 'inside the interval: no new notice')
  await tick(1)
  await act(async () => FakeES.last.send('{nope'))
  assert.equal(result.current.notice?.id, id, 'exactly at the interval: still rate limited')
  await tick(1)
  await act(async () => FakeES.last.send('{nope'))
  assert.notEqual(result.current.notice?.id, id, 'past the interval: a new notice')
})

test('relaySessionId asks the relay for one session and rejects the others', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge({ relaySessionId: 's 1' }))
  assert.equal(FakeES.last.url, 'http://127.0.0.1:4321/events?session=s%201')
  await act(async () => FakeES.last.open())
  assert.equal(result.current.connectionStatus, 'connected')
  await act(async () => FakeES.last.send(agentEvent('other', 1)))
  assert.equal(posted.length, 0)
  await act(async () => FakeES.last.send(agentEvent('s 1', 2)))
  assert.equal(posted.length, 1)
})

test('unmount closes the stream and cancels reconnect timers', async () => {
  relayEnv()
  const { unmount } = renderHook(() => useVSCodeBridge())
  const first = FakeES.last
  await act(async () => first.fail())
  unmount()
  await tick(10 * BACKOFF_BASE_MS)
  assert.equal(FakeES.all.length, 1, 'no reconnect after unmount')
  assert.equal(statusFetches, 0)
})

test('unmount while a /status probe is in flight aborts it and arms nothing', async () => {
  relayEnv()
  const signals: AbortSignal[] = []
  let reject: (e: unknown) => void = () => {}
  g.fetch = (_url: string, init: { signal: AbortSignal }) => {
    signals.push(init.signal)
    statusFetches++
    return new Promise((_, rej) => { reject = rej })
  }
  const { unmount } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.fail())
  await tick(BACKOFF_BASE_MS)
  await act(async () => FakeES.last.fail())
  await tick(2 * BACKOFF_BASE_MS)
  await act(async () => FakeES.last.fail())
  await tick(POLL_INTERVAL_MS)
  assert.equal(statusFetches, 1)
  unmount()
  assert.equal(signals[0].aborted, true)
  reject(new Error('late'))
  await act(async () => { await Promise.resolve() })
  await tick(10 * POLL_INTERVAL_MS)
  assert.equal(statusFetches, 1)
  assert.equal(FakeES.all.length, 3)
})

test('outside relay mode: no stream, and the status turns to disconnected after exactly 1500 ms', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.all.length, 0)
  assert.equal(result.current.connectionStatus, 'connecting')
  await tick(1499)
  assert.equal(result.current.connectionStatus, 'connecting')
  await tick(1)
  assert.equal(result.current.connectionStatus, 'disconnected')
  assert.equal(result.current.connectionDetail, null)
  assert.equal(result.current.reconnectAttempt, 0)
})

test('in relay mode the 1500 ms offline fallback does not run', async () => {
  relayEnv()
  const { result } = renderHook(() => useVSCodeBridge())
  await tick(5000)
  assert.equal(result.current.connectionStatus, 'connecting')
})

test('inside VS Code the relay is not used, even in relay mode', async () => {
  relayEnv()
  const { result } = renderHook(() => useVSCodeBridge())
  const stream = FakeES.last
  assert.equal(result.current.isVSCode, false)
  await act(async () => stream.fail())
  assert.equal(result.current.reconnectAttempt, 1)
  assert.equal(result.current.connectionDetail, 'reconnecting (attempt 1, retry in 5s)')
  await act(async () => {
    window.dispatchEvent(new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', { data: { type: '__vscode-bridge-init' } }))
  })
  assert.equal(result.current.isVSCode, true)
  assert.equal(stream.closed, true, 'the relay stream is released')
  assert.equal(result.current.connectionDetail, null, 'a stale relay detail is hidden once the relay is off')
  assert.equal(result.current.reconnectAttempt, 0)
  await tick(10 * BACKOFF_BASE_MS)
  assert.equal(FakeES.all.length, 1)
  cleanup()
  renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.all.length, 1, 'a later mount does not connect either')
})
