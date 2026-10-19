// useVSCodeBridge wiring of the resilient relay client (#67): the real hook, a fake EventSource and fake
// timers. Covers relayEnabled, status mapping, relay-down / relay-up / parse-error notices, the detail
// fields, the relaySessionId option and the offline fallback. The VS Code case runs last: the bridge
// singleton cannot leave VS Code mode once it entered it.
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'

import { useVSCodeBridge, PARSE_NOTICE_INTERVAL_MS } from '@/hooks/use-vscode-bridge'
import { resetDefaultUiPreferencesStore, useUiPreferences } from '@/hooks/use-ui-preferences'
import { BACKOFF_BASE_MS, POLL_INTERVAL_MS } from '@/lib/reconnect'
import { ALL_SESSIONS_ID } from '@/lib/bridge-types'

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
const realDispatch = vscodeBridge!.dispatch.bind(vscodeBridge)
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
  g.fetch = async (url: string, init?: { headers?: unknown }) => {
    if (init?.headers) return { ok: false } // hooks-state read (#176), not a reachability probe
    statusFetches++; statusUrls.push(url); return { ok: statusOk } }
  mock.method(vscodeBridge!, 'dispatch', (d: unknown) => { posted.push(d) }) // what the relay forwards to the bridge
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  mock.method(Math, 'random', () => 0) // no jitter: exact delays
})
afterEach(() => {
  cleanup()
  resetDefaultUiPreferencesStore() // 'Show finished sessions' lives in the shared preference store (#372)
  mock.timers.reset()
  mock.restoreAll()
  for (const k of ENV_KEYS) setEnv(k, savedEnv[k])
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

test('hooksConfigured comes from GET /status only when the relay watches Claude Code (#176)', async () => {
  relayEnv('4321')
  const g = globalThis as unknown as { fetch: unknown }
  let body: unknown = { runtimes: ['claude'], hooksConfigured: false }
  g.fetch = async () => ({ ok: true, json: async () => body })
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.hooksConfigured, undefined)
  await act(async () => FakeES.last.open())
  await tick(0)
  assert.equal(result.current.hooksConfigured, false)
  body = { runtimes: ['codex'], hooksConfigured: false }
  const second = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await tick(0)
  const result2 = second.result
  assert.equal(result2.current.hooksConfigured, undefined, 'Codex only: the flag says nothing')
})

test('disable1MContext comes from GET /status in relay mode, only when the relay watches Claude Code (#249)', async () => {
  relayEnv('4321')
  const g = globalThis as unknown as { fetch: unknown }
  let body: unknown = { runtimes: ['claude'], hooksConfigured: true, disable1MContext: true }
  g.fetch = async () => ({ ok: true, json: async () => body })
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.disable1MContext, false)
  await act(async () => FakeES.last.open())
  await tick(0)
  assert.equal(result.current.disable1MContext, true)
  body = { runtimes: ['codex'], hooksConfigured: false, disable1MContext: true }
  const second = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await tick(0)
  assert.equal(second.result.current.disable1MContext, false, 'Codex only: the Claude Code flag says nothing')
})

test('event-loss (#366): only the first connection of a graph counts, and it lives as long as the graph, not the link', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.eventLoss, null)
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { a: 3 }, otherEvents: 2 }))
  assert.deepEqual(result.current.eventLoss, { evicted: { a: 3 }, otherEvents: 2 })
  // The link drops: the graph keeps its hole, so the figure stays
  await act(async () => FakeES.last.fail())
  assert.deepEqual(result.current.eventLoss, { evicted: { a: 3 }, otherEvents: 2 }, 'a cut link does not make the graph complete again')
  // The relay reconnects and sends its cumulative total since it started: the graph was kept, so it says nothing about it
  await tick(BACKOFF_BASE_MS)
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { a: 50 }, otherEvents: 9 }))
  assert.deepEqual(result.current.eventLoss, { evicted: { a: 3 }, otherEvents: 2 }, 'a later connection never replaces the first figure')
})

test('event-loss (#366): a reconnection resumes from the relay cursor and adds the gap the cut link left', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { a: 3 } }))
  await act(async () => FakeES.last.send({ type: 'relay-cursor', instance: 'a1b2c3d4e5f60718', seq: 20 }))
  await act(async () => FakeES.last.send({ ...agentEvent('a', 1), seq: 21 }))
  await act(async () => FakeES.last.fail())
  await tick(BACKOFF_BASE_MS)
  assert.equal(FakeES.last.url, 'http://127.0.0.1:4321/events?since=a1b2c3d4e5f60718.21')
  await act(async () => FakeES.last.open())
  // The relay's totals of this connection are ignored, its gap (events numbered after 21 this client never got) is added
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { a: 90 }, gap: { a: 4, b: 2 } }))
  assert.deepEqual(result.current.eventLoss, { evicted: { a: 7, b: 2 }, otherEvents: 0 })
})

test('event-loss (#366): a first connection without loss is not turned into a loss by a reconnection', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.fail())
  await tick(BACKOFF_BASE_MS)
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { a: 5 } }))
  assert.equal(result.current.eventLoss, null)
})

test('event-loss (#366): a scope change reloads the view, so the next connection is a first one again', async () => {
  relayEnv('4321')
  g.fetch = async (_url: string, init?: { method?: string }) =>
    init?.method === 'POST' ? { ok: true, json: async () => ({ scope: 'all', allWorkspaces: true }) } : { ok: false }
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { a: 3 } }))
  assert.deepEqual(result.current.eventLoss, { evicted: { a: 3 }, otherEvents: 0 })
  // A reconnection before the scope change: the counter of connections is past the first one (#453: without it the
  // test passed on code that took every figure, or that never reset the counter)
  await act(async () => FakeES.last.fail())
  await tick(BACKOFF_BASE_MS)
  await act(async () => FakeES.last.open())
  await act(async () => { await result.current.setRelayScope('all') })
  assert.equal(result.current.eventLoss, null, 'the old graph is gone with its loss')
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { b: 4 } }))
  assert.deepEqual(result.current.eventLoss, { evicted: { b: 4 }, otherEvents: 0 }, 'the first connection of the new graph counts: the counter was reset')
  // And it is a first connection like any other: a later one is ignored
  await act(async () => FakeES.last.fail())
  await tick(BACKOFF_BASE_MS)
  await act(async () => FakeES.last.open())
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { b: 40 } }))
  assert.deepEqual(result.current.eventLoss, { evicted: { b: 4 }, otherEvents: 0 }, 'a reconnection after the scope change says nothing about the new graph')
})

test('event-loss (#453): All counts only the sessions it shows (finished ones hidden by default), never otherEvents then', async () => {
  relayEnv('4321')
  const hook = renderHook(() => ({ bridge: useVSCodeBridge(), ui: useUiPreferences() }))
  const result = { get current() { return hook.result.current.bridge } }
  await act(async () => FakeES.last.open())
  const now = Date.now()
  await act(async () => realDispatch({ type: 'session-list', sessions: [
    { id: 'live', label: 'live', status: 'active', startTime: now, lastActivityTime: now },
    { id: 'old', label: 'old', status: 'completed', startTime: now - 86_400_000, lastActivityTime: now - 86_400_000 },
  ] }))
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { live: 3, old: 50 }, otherEvents: 9 }))
  await act(async () => result.current.selectSession(ALL_SESSIONS_ID))
  assert.equal(result.current.selectedSessionId, ALL_SESSIONS_ID)
  assert.equal(result.current.showFinished, false)
  assert.deepEqual([...(result.current.allViewSessionIds ?? [])], ['live'], 'the finished session is out of the view')
  assert.equal(result.current.replayLost, 3, 'the loss of the hidden finished session and of unnamed sessions is not claimed')
  assert.deepEqual([...(result.current.viewSessionIds ?? [])], ['live'], 'the notice adds up the normalizer counters of the same sessions')
  // Showing the finished sessions (Show mode 'all', written in the preferences) makes All every session: the whole tally counts again
  await act(async () => hook.result.current.ui.setPref('show', 'all'))
  assert.equal(result.current.allViewSessionIds, null)
  assert.equal(result.current.replayLost, 62)
  assert.equal(result.current.viewSessionIds, null)
})

test('event-loss (#366): a team view counts the sessions of the team, for the replay loss and for the notice alike', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  const now = Date.now()
  await act(async () => realDispatch({ type: 'session-list', sessions: [
    { id: 'lead', label: 'lead', status: 'active', startTime: now, lastActivityTime: now, teamName: 'T' },
    { id: 'solo', label: 'solo', status: 'active', startTime: now, lastActivityTime: now },
  ] }))
  await act(async () => FakeES.last.send({ type: 'event-loss', evicted: { lead: 2, solo: 30 } }))
  await act(async () => result.current.selectSession('team:T'))
  assert.equal(result.current.selectedSessionId, 'team:T')
  assert.ok(result.current.viewSessionIds?.has('lead'), JSON.stringify([...(result.current.viewSessionIds ?? [])]))
  assert.equal(result.current.viewSessionIds?.has('solo'), false)
  assert.equal(result.current.replayLost, 2)
})

test('event-loss (#366): outside relay mode there is none', () => {
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.eventLoss, null)
  assert.equal(result.current.replayLost, 0)
})

test('event-loss (#592): in VS Code (no relay) the figure comes from the extension, once per page; a reset empties it', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(FakeES.all.length, 0, 'no relay stream')
  assert.equal(result.current.eventLoss, null)
  await act(async () => realDispatch({ type: 'event-loss', evicted: { a: 3 }, otherEvents: 2 }))
  assert.deepEqual(result.current.eventLoss, { evicted: { a: 3 }, otherEvents: 2 })
  const now = Date.now()
  await act(async () => realDispatch({ type: 'session-list', sessions: [{ id: 'a', label: 'a', status: 'active', startTime: now, lastActivityTime: now }] }))
  assert.equal(result.current.replayLost, 3, 'the same surfaces as with the relay: All counts the sessions it shows')
  await act(async () => realDispatch({ type: 'event-loss', evicted: 'junk' }))
  assert.deepEqual(result.current.eventLoss, { evicted: { a: 3 }, otherEvents: 2 }, 'a message that does not parse never clears a figure')
  // A session's history read again reached the page: the extension sends the page's figure again, lower; it replaces
  await act(async () => realDispatch({ type: 'event-loss', evicted: { a: 1 }, otherEvents: 2 }))
  assert.equal(result.current.replayLost, 1)
  await act(async () => realDispatch({ type: 'event-loss', evicted: {} }))
  assert.equal(result.current.replayLost, 0, 'sent empty: nothing is claimed any more')
  await act(async () => realDispatch({ type: 'event-loss', evicted: { a: 3 }, otherEvents: 2 }))
  // The extension resets the graph when a new page is ready, then sends that page's figure (or none)
  await act(async () => realDispatch({ type: 'reset', reason: 'panel-reopened' }))
  assert.equal(result.current.eventLoss, null, 'the old graph is gone with its loss')
  await act(async () => realDispatch({ type: 'event-loss', evicted: { b: 1 }, gap: { b: 9 } }))
  assert.deepEqual(result.current.eventLoss, { evicted: { b: 1 }, otherEvents: 0 }, 'no cut link to resume in VS Code: a gap is never added')
  await act(async () => realDispatch({ type: 'reset', reason: 'panel-reopened' }))
})

test('event-loss (#592): a figure the extension sent before the view mounted is not lost', async () => {
  realDispatch({ type: 'event-loss', evicted: { early: 4 } })
  const { result } = renderHook(() => useVSCodeBridge())
  assert.deepEqual(result.current.eventLoss, { evicted: { early: 4 }, otherEvents: 0 })
  await act(async () => realDispatch({ type: 'reset', reason: 'panel-reopened' }))
  assert.equal(result.current.eventLoss, null)
})

test('event-loss (#592): with a relay stream, a figure from the frame is ignored (only the relay counts)', async () => {
  relayEnv('4321')
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await act(async () => realDispatch({ type: 'event-loss', evicted: { a: 3 } }))
  assert.equal(result.current.eventLoss, null)
  await act(async () => realDispatch({ type: 'reset', reason: 'panel-reopened' }))
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
    realDispatch({ type: '__vscode-bridge-init' })
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
