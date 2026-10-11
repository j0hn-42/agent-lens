// Waste detection (#234): repeated reads and identical calls, computed from events already received.
// Principle: only what is proven is reported; anything that cannot be compared is counted apart, never guessed.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, agentKeyOf, type SimulationState } from '../web/hooks/simulation/types'
import { listWaste, wasteSummary, wasteUsage, MAX_WASTE_TRACKED, type WasteItem } from '../web/lib/waste'
import { formatTokenUsage } from '../web/lib/usage'
import type { SimulationEvent } from '../web/lib/agent-types'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { time?: number; sessionId?: string }

function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  let t = 0
  for (const e of events) {
    t = e.time ?? t + 10   // spaced out: never inside the 3 s hook/watcher dedup window
    state = processEvent({ time: t, type: e.type, payload: e.payload, ...(e.sessionId ? { sessionId: e.sessionId } : {}) }, { ...state, currentTime: t }, ctx)
  }
  return state
}

const main = { type: 'agent_spawn' as const, payload: { name: 'main', isMain: true } }
const sub = { type: 'agent_spawn' as const, payload: { name: 'worker' } }
let n = 0
const call = (agent: string, tool: string, inputData: Record<string, unknown> | undefined, end: Record<string, unknown> = {}, id = `u${++n}`): Ev[] => [
  { type: 'tool_call_start', payload: { agent, tool, args: 'x', ...(inputData ? { inputData } : {}), toolUseId: id } },
  { type: 'tool_call_end', payload: { agent, tool, result: 'ok', toolUseId: id, ...end } },
]
const read = (agent: string, file: string, extra: Record<string, unknown> = {}, end: Record<string, unknown> = {}) =>
  call(agent, 'Read', { file_path: file, ...extra }, end)
const edit = (agent: string, file: string) => call(agent, 'Edit', { file_path: file, old_string: 'a', new_string: 'b' })

const only = (s: SimulationState): WasteItem => {
  const items = listWaste(s.waste)
  assert.equal(items.length, 1, `expected one finding, got ${JSON.stringify(items)}`)
  return items[0]
}

test('nothing repeated: no finding, and the summary says so', () => {
  const s = run([main, ...read('main', '/a.ts'), ...read('main', '/b.ts')])
  assert.deepEqual(listWaste(s.waste), [])
  assert.deepEqual(wasteSummary(s.waste), { items: [], repeats: 0, uncompared: 0, limitReached: false })
})

test('the same file read twice by the same agent is one repeated read', () => {
  const item = only(run([main, ...read('main', '/a.ts'), ...read('main', '/a.ts')]))
  assert.equal(item.kind, 'reread')
  assert.equal(item.toolName, 'Read')
  assert.equal(item.target, '/a.ts')
  assert.equal(item.repeats, 1)
  assert.equal(item.agentId, agentKeyOf('default', 'main'))
})

test('three reads are two repeats', () => {
  assert.equal(only(run([main, ...read('main', '/a.ts'), ...read('main', '/a.ts'), ...read('main', '/a.ts')])).repeats, 2)
})

test('a read of another range of the file is not a repeat (offset and limit are part of the call)', () => {
  const s = run([main, ...read('main', '/a.ts', { offset: 1, limit: 100 }), ...read('main', '/a.ts', { offset: 101, limit: 100 })])
  assert.deepEqual(listWaste(s.waste), [])
  const same = run([main, ...read('main', '/a.ts', { offset: 1, limit: 100 }), ...read('main', '/a.ts', { offset: 1, limit: 100 })])
  assert.equal(only(same).repeats, 1)
})

test('an edit seen in between makes the second read legitimate', () => {
  const s = run([main, ...read('main', '/a.ts'), ...edit('main', '/a.ts'), ...read('main', '/a.ts')])
  assert.deepEqual(listWaste(s.waste), [])
})

test('an edit of another file does not excuse the re-read', () => {
  const s = run([main, ...read('main', '/a.ts'), ...edit('main', '/b.ts'), ...read('main', '/a.ts')])
  assert.equal(only(s).repeats, 1)
})

test('an edit by another agent of the same session also excuses it', () => {
  const s = run([main, sub, ...read('main', '/a.ts'), ...edit('worker', '/a.ts'), ...read('main', '/a.ts')])
  assert.deepEqual(listWaste(s.waste), [])
})

test('a write whose path is unknown (patch) excuses every read of its session', () => {
  const s = run([main, ...read('main', '/a.ts'), ...call('main', 'apply_patch', { patch: '*** Update File: /a.ts' }), ...read('main', '/a.ts')])
  assert.deepEqual(listWaste(s.waste), [])
})

test('an edit after the repeat does not erase it', () => {
  const s = run([main, ...read('main', '/a.ts'), ...read('main', '/a.ts'), ...edit('main', '/a.ts'), ...read('main', '/a.ts')])
  assert.equal(only(s).repeats, 1)
})

test('two agents reading the same file is not a repeat: each has its own context', () => {
  const s = run([main, sub, ...read('main', '/a.ts'), ...read('worker', '/a.ts')])
  assert.deepEqual(listWaste(s.waste), [])
})

test('the same agent name in two sessions is two agents', () => {
  const a = { ...main, sessionId: 's1' }, b = { ...main, sessionId: 's2' }
  const reads = (sid: string) => read('main', '/a.ts').map(e => ({ ...e, sessionId: sid }))
  assert.deepEqual(listWaste(run([a, b, ...reads('s1'), ...reads('s2')]).waste), [])
})

test('a call replayed with the same tool_use_id is not counted twice', () => {
  const once = read('main', '/a.ts')
  const s = run([main, ...once, ...once])
  assert.deepEqual(listWaste(s.waste), [])
})

test('a read without input details cannot be compared: counted apart, not reported', () => {
  const s = run([main, ...call('main', 'Read', undefined), ...call('main', 'Read', undefined)])
  assert.deepEqual(listWaste(s.waste), [])
  assert.equal(wasteSummary(s.waste).uncompared, 2)
})

test('a tool whose summary drops arguments (Grep) is never compared', () => {
  const g = () => call('main', 'Grep', { pattern: 'x', path: '/src' })
  const s = run([main, ...g(), ...g()])
  assert.deepEqual(listWaste(s.waste), [])
  assert.equal(wasteSummary(s.waste).uncompared, 0, 'not a tool we compare, so nothing to flag as skipped')
})

test('identical Glob calls with no edit in between are repeats; an edit excuses them', () => {
  const g = () => call('main', 'Glob', { pattern: '**/*.ts', path: '/src' })
  const item = only(run([main, ...g(), ...g()]))
  assert.equal(item.kind, 'identical')
  assert.equal(item.toolName, 'Glob')
  assert.equal(listWaste(run([main, ...g(), ...edit('main', '/src/a.ts'), ...g()]).waste).length, 0)
})

test('the same Bash command twice in a row is an identical call; another call in between breaks the run', () => {
  const b = () => call('main', 'Bash', { command: 'git status', description: '' })
  const item = only(run([main, ...b(), ...b()]))
  assert.equal(item.kind, 'identical')
  assert.equal(item.target, 'git status')
  assert.equal(listWaste(run([main, ...b(), ...read('main', '/a.ts'), ...b()]).waste).length, 0)
})

test('different commands are not repeats', () => {
  const s = run([main, ...call('main', 'Bash', { command: 'git status' }), ...call('main', 'Bash', { command: 'git diff' })])
  assert.deepEqual(listWaste(s.waste), [])
})

test('tokens of the repeats only: the first read is not waste', () => {
  const s = run([main, ...read('main', '/a.ts', {}, { tokenCost: 500, tokenSource: 'reported' }), ...read('main', '/a.ts', {}, { tokenCost: 120, tokenSource: 'reported' }), ...read('main', '/a.ts', {}, { tokenCost: 80, tokenSource: 'reported' })])
  const item = only(s)
  assert.deepEqual(wasteUsage(item), { value: 200, status: 'available', estimated: false })
  assert.equal(formatTokenUsage(wasteUsage(item)), '200')
})

test('a repeat without reported cost: not 0 - unavailable, or a lower bound when some are known', () => {
  const none = only(run([main, ...read('main', '/a.ts'), ...read('main', '/a.ts')]))
  assert.deepEqual(wasteUsage(none), { value: null, status: 'unavailable', estimated: false })
  assert.equal(formatTokenUsage(wasteUsage(none)), 'not reported')
  const some = only(run([main, ...read('main', '/a.ts'), ...read('main', '/a.ts', {}, { tokenCost: 300, tokenSource: 'reported' }), ...read('main', '/a.ts')]))
  assert.deepEqual(wasteUsage(some), { value: 300, status: 'partial', estimated: false })
  assert.equal(formatTokenUsage(wasteUsage(some)), 'at least 300')
})

test('an explicit zero is a value, not a gap', () => {
  const item = only(run([main, ...read('main', '/a.ts'), ...read('main', '/a.ts', {}, { tokenCost: 0, tokenSource: 'reported' })]))
  assert.deepEqual(wasteUsage(item), { value: 0, status: 'available', estimated: false })
})

test('an estimated cost is flagged estimated', () => {
  const item = only(run([main, ...read('main', '/a.ts'), ...read('main', '/a.ts', {}, { tokenCost: 90, tokenSource: 'estimated' })]))
  assert.equal(formatTokenUsage(wasteUsage(item)), '90 estimated')
})

test('a repeat whose end was never seen stays unknown until its cost arrives', () => {
  const s = run([main, ...read('main', '/a.ts'), { type: 'tool_call_start', payload: { agent: 'main', tool: 'Read', args: 'x', inputData: { file_path: '/a.ts' }, toolUseId: 'late' } }])
  assert.deepEqual(wasteUsage(only(s)), { value: null, status: 'unavailable', estimated: false })
  const done = processEvent({ time: 99, type: 'tool_call_end', payload: { agent: 'main', tool: 'Read', result: 'ok', toolUseId: 'late', tokenCost: 40, tokenSource: 'reported' } }, { ...s, currentTime: 99 }, ctx)
  assert.deepEqual(wasteUsage(only(done)), { value: 40, status: 'available', estimated: false })
})

test('findings are sorted by known tokens, then repeats', () => {
  const s = run([
    main,
    ...read('main', '/small.ts'), ...read('main', '/small.ts', {}, { tokenCost: 10, tokenSource: 'reported' }),
    ...read('main', '/big.ts'), ...read('main', '/big.ts', {}, { tokenCost: 900, tokenSource: 'reported' }),
    ...read('main', '/none.ts'), ...read('main', '/none.ts'), ...read('main', '/none.ts'),
  ])
  assert.deepEqual(listWaste(s.waste).map(i => i.target), ['/big.ts', '/small.ts', '/none.ts'])
  assert.equal(wasteSummary(s.waste).repeats, 1 + 1 + 2)
})

test('the ledger is bounded: past the limit new calls are not tracked and the summary says it is a lower bound', () => {
  const reads: Ev[] = []
  for (let i = 0; i < MAX_WASTE_TRACKED + 5; i++) reads.push(...read('main', `/f${i}.ts`))
  const s = run([main, ...reads])
  assert.equal(wasteSummary(s.waste).limitReached, true)
  assert.ok(s.waste.seen.size <= MAX_WASTE_TRACKED)
})

test('processing an event that is not a tool call keeps the same ledger reference (no re-render)', () => {
  const s = run([main, ...read('main', '/a.ts')])
  const again = processEvent({ time: 500, type: 'message', payload: { agent: 'main', role: 'assistant', content: 'hi' } }, { ...s, currentTime: 500 }, ctx)
  assert.equal(again.waste, s.waste)
})
