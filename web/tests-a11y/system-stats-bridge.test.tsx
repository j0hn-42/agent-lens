// Machine health in useVSCodeBridge (#357): the relay's SSE `system-stats` samples fill a bounded buffer,
// a malformed sample changes nothing, nothing reaches the window bridge, and a down link empties the buffer.
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
let dispatched: unknown[] = []

const sample = (ts: number) => ({
  ts, cpu: { total: 0.5, perCore: [0.4, 0.6] }, mem: { total: 100, used: 40 }, swap: null, disk: null,
  load: [1, 1, 1], uptime: 10, platformNote: null,
})

beforeEach(() => {
  for (const k of KEYS) saved[k] = env[k]
  env.AGENT_LENS_STANDALONE = '1'
  env.NEXT_PUBLIC_RELAY_PORT = ''
  delete env.NEXT_PUBLIC_DEMO
  FakeES.all = []; dispatched = []
  g.EventSource = FakeES
  g.fetch = async () => ({ ok: true, json: async () => ({}) })
  mock.method(vscodeBridge!, 'dispatch', (d: unknown) => { dispatched.push(d) })
})
afterEach(() => {
  cleanup()
  mock.restoreAll()
  for (const k of KEYS) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k] }
})

const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

test('empty until the relay sends a sample', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  assert.deepEqual(result.current.systemStats, [])
})

test('a valid system-stats message appends one point and stays out of the window bridge', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  await act(async () => FakeES.last.send({ type: 'system-stats', sample: sample(1) }))
  await act(async () => FakeES.last.send({ type: 'system-stats', sample: sample(2) }))
  assert.deepEqual(result.current.systemStats.map(s => s.ts), [1, 2])
  assert.ok(!dispatched.some(d => (d as { type?: string }).type === 'system-stats'))
})

test('a malformed sample adds no point', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  await act(async () => FakeES.last.send({ type: 'system-stats', sample: sample(1) }))
  const before = result.current.systemStats
  await act(async () => FakeES.last.send({ type: 'system-stats', sample: { ts: 'x' } }))
  await act(async () => FakeES.last.send({ type: 'system-stats' }))
  assert.equal(result.current.systemStats, before, 'same buffer, no state change')
})

test('a window message cannot make up a sample', async () => {
  mock.restoreAll()
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  await act(async () => { vscodeBridge!.dispatch({ type: 'system-stats', sample: sample(1) }) })
  assert.deepEqual(result.current.systemStats, [])
})

test('a down link empties the buffer: stale figures are never shown as current', async () => {
  const { result } = renderHook(() => useVSCodeBridge())
  await act(async () => FakeES.last.open())
  await flush()
  await act(async () => FakeES.last.send({ type: 'system-stats', sample: sample(1) }))
  assert.equal(result.current.systemStats.length, 1)
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await act(async () => FakeES.last.onerror?.({}))
    assert.deepEqual(result.current.systemStats, [])
  } finally { mock.timers.reset() }
})
