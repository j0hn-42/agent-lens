// Launch state in useVSCodeBridge (#229): status.launch read from a SAME-ORIGIN relay only, the `launch` and
// `launch-list` SSE merged by id, and never taken from a window message (an embedding frame cannot make one up).
import { test, afterEach, beforeEach, mock } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderHook, cleanup, act } from '@testing-library/react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { useVSCodeBridge } from '@/hooks/use-vscode-bridge'

class FakeES {
  static all: FakeES[] = []
  onopen: ((e: unknown) => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(public url: string) { FakeES.all.push(this) }
  close() {}
  open() { this.onopen?.({}) }
  send(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  static get last() { return FakeES.all[FakeES.all.length - 1] }
}

const g = globalThis as unknown as Record<string, unknown>
const env = process.env as Record<string, string | undefined>
const KEYS = ['AGENT_LENS_STANDALONE', 'NEXT_PUBLIC_RELAY_PORT', 'NEXT_PUBLIC_DEMO'] as const
const saved: Record<string, string | undefined> = {}
let statusBody: unknown = {}
let statusUrls: string[] = []
let dispatched: unknown[] = []

const view = (over: Record<string, unknown> = {}) => ({
  id: '0123456789abcdef', repo: 'o/r', issue: 7, role: 'qa', worktree: 'issue-7-qa',
  sessionId: '0f6c3a1e-58b2-4c1d-9a0e-2b7d4e5f6a7b', state: 'requested', requestedAt: 1, outputBytes: 0, outputDroppedBytes: 0, ...over,
})

beforeEach(() => {
  for (const k of KEYS) saved[k] = env[k]
  env.AGENT_LENS_STANDALONE = '1'
  delete env.NEXT_PUBLIC_DEMO
  FakeES.all = []; statusUrls = []; dispatched = []; statusBody = {}
  g.EventSource = FakeES
  g.fetch = async (url: string) => { statusUrls.push(url); return { ok: true, json: async () => statusBody } }
  mock.method(vscodeBridge!, 'dispatch', (d: unknown) => { dispatched.push(d) })
})
afterEach(() => {
  cleanup()
  mock.restoreAll()
  for (const k of KEYS) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k] }
})

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

test('same origin with status.launch: the launch surface is exposed, with the launches of the status', async () => {
  env.NEXT_PUBLIC_RELAY_PORT = ''
  statusBody = { launch: { maxConcurrent: 2, launches: [view({ state: 'started', pid: 42 })] } }
  const { result } = renderHook(() => useVSCodeBridge())
  assert.equal(result.current.launch, null, 'nothing before the relay answered')
  await act(async () => FakeES.last.open())
  await flush()
  assert.ok(statusUrls.includes('/status'))
  const launch = result.current.launch as { maxConcurrent: number; launches: ReadonlyMap<string, { pid?: number }> } | null
  assert.equal(launch?.maxConcurrent, 2)
  assert.equal(launch?.launches.get('0123456789abcdef')?.pid, 42)
})

test('no status.launch (relay without --allow-launch): no launch surface', async () => {
  env.NEXT_PUBLIC_RELAY_PORT = ''
  statusBody = { relayVersion: '1' }
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  assert.equal(result.current.launch, null)
})

test('a relay on another origin (dev server): no launch surface, the POST could not pass without CORS', async () => {
  env.NEXT_PUBLIC_RELAY_PORT = '4321'
  statusBody = { launch: { maxConcurrent: 1, launches: [] } }
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  assert.equal(result.current.launch, null)
})

test('`launch` and `launch-list` SSE are merged by id and not forwarded to the window bridge', async () => {
  env.NEXT_PUBLIC_RELAY_PORT = ''
  statusBody = { launch: { maxConcurrent: 1, launches: [] } }
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  await act(async () => FakeES.last.send({ type: 'launch-list', launches: [view(), view({ id: 'fedcba9876543210', issue: 8 })] }))
  assert.equal(result.current.launch?.launches.size, 2)
  await act(async () => FakeES.last.send({ type: 'launch', launch: view({ state: 'session', pid: 5, sessionSeenAt: 9 }) }))
  assert.equal(result.current.launch?.launches.size, 2)
  assert.equal(result.current.launch?.launches.get('0123456789abcdef')?.state, 'session')
  assert.ok(!dispatched.some(d => (d as { type?: string }).type?.startsWith('launch')), 'launch messages stay out of the window bridge')
})

test('a window message cannot make up a launch', async () => {
  env.NEXT_PUBLIC_RELAY_PORT = ''
  statusBody = { launch: { maxConcurrent: 1, launches: [] } }
  mock.restoreAll()
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  await act(async () => { vscodeBridge!.dispatch({ type: 'launch', launch: view() }) })
  assert.equal(result.current.launch?.launches.size, 0)
})

test('reconnecting to a relay that knows no launch empties the list (an empty status is a snapshot too)', async () => {
  env.NEXT_PUBLIC_RELAY_PORT = ''
  statusBody = { launch: { maxConcurrent: 1, launches: [view({ state: 'started', pid: 42 })] } }
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  assert.equal(result.current.launch?.launches.size, 1)
  // The relay restarted: its child was killed without an end event, and the new relay lists nothing
  statusBody = { launch: { maxConcurrent: 1, launches: [] } }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await act(async () => FakeES.last.onerror?.({}))
    assert.equal((result.current as { launch: unknown }).launch, null, 'no launch surface while the link is down')
    await act(async () => { mock.timers.tick(10_000) })
  } finally { mock.timers.reset() }
  assert.equal(FakeES.all.length, 2, 'the page reconnects')
  await act(async () => FakeES.last.open())
  await flush()
  assert.equal((result.current as typeof result.current).launch?.launches.size, 0, 'no "Démarré (pid 42)" without proof')
})

test('an SSE `launch-list` replaces what was known', async () => {
  env.NEXT_PUBLIC_RELAY_PORT = ''
  statusBody = { launch: { maxConcurrent: 1, launches: [view(), view({ id: 'fedcba9876543210', issue: 8 })] } }
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  assert.equal(result.current.launch?.launches.size, 2)
  await act(async () => FakeES.last.send({ type: 'launch-list', launches: [view({ id: 'fedcba9876543210', issue: 8 })] }))
  assert.deepEqual([...(result.current.launch?.launches.keys() ?? [])], ['fedcba9876543210'])
})
