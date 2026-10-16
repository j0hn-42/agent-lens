// File timeline (#385): the ordered steps of a file (read, edited, written), each tied to the call that proved it.
// Only a call observed to succeed makes a step; nothing is ever shown as "committed" without proof.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'
import { FILE_TIMELINE_MAX_STEPS, fileStepKind, recordFileStep, type FileTimeline } from '../web/lib/file-timeline'

// ─── Pure module ─────────────────────────────────────────────────────────────

const step = (n: number, kind: 'read' | 'edited' | 'written' = 'read') =>
  ({ kind, callId: `c${n}`, toolUseId: `u${n}`, agentId: 's:main', time: n })

test('the kind of a step comes from the tool: Read, Edit / MultiEdit / NotebookEdit, Write; any other tool makes none', () => {
  assert.equal(fileStepKind('Read'), 'read')
  assert.equal(fileStepKind('Edit'), 'edited')
  assert.equal(fileStepKind('MultiEdit'), 'edited')
  assert.equal(fileStepKind('NotebookEdit'), 'edited')
  assert.equal(fileStepKind('Write'), 'written')
  assert.equal(fileStepKind('Bash'), null)
  assert.equal(fileStepKind('Grep'), null)
})

test('only a call observed to succeed makes a step: an error or a cancellation leaves the timeline as it was', () => {
  const t0: FileTimeline = { steps: [step(1)], omitted: 0 }
  assert.equal(recordFileStep(t0, step(2), 'error'), t0)
  assert.equal(recordFileStep(t0, step(3), 'cancelled'), t0)
  assert.deepEqual(recordFileStep(t0, step(4), 'complete')?.steps.map(s => s.callId), ['c1', 'c4'])
  assert.equal(recordFileStep(undefined, step(5), 'error'), undefined)
})

test('the same call never makes two steps (same call id, or same tool_use_id)', () => {
  const t1 = recordFileStep(undefined, step(1), 'complete')
  assert.equal(recordFileStep(t1, step(1), 'complete'), t1)
  assert.equal(recordFileStep(t1, { ...step(1), callId: 'other' }, 'complete'), t1)
  // Two calls without tool_use_id are told apart by their call id
  const a = recordFileStep(undefined, { ...step(1), toolUseId: undefined }, 'complete')
  const b = recordFileStep(a, { ...step(2), toolUseId: undefined }, 'complete')
  assert.equal(b?.steps.length, 2)
})

test('the timeline is bounded: the most recent steps are kept and the older ones are counted, never dropped silently', () => {
  let t: FileTimeline | undefined
  for (let i = 1; i <= FILE_TIMELINE_MAX_STEPS + 7; i++) t = recordFileStep(t, step(i), 'complete')
  assert.equal(t?.steps.length, FILE_TIMELINE_MAX_STEPS)
  assert.equal(t?.omitted, 7)
  assert.equal(t?.steps[0].callId, 'c8')
  assert.equal(t?.steps.at(-1)?.callId, `c${FILE_TIMELINE_MAX_STEPS + 7}`)
})

// ─── Through the event pipeline ──────────────────────────────────────────────

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}
type Ev = Pick<SimulationEvent, 'type' | 'payload'>
function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  let t = 0
  for (const e of events) {
    t += 5 // past the start dedup window
    state = processEvent({ time: t, type: e.type, payload: e.payload }, { ...state, currentTime: t }, ctx)
  }
  return state
}
const spawn: Ev = { type: 'agent_spawn', payload: { name: 'main', isMain: true } }
const start = (tool: string, file: string, id: string): Ev =>
  ({ type: 'tool_call_start', payload: { agent: 'main', tool, args: file, inputData: { file_path: file }, toolUseId: id } })
const end = (tool: string, id: string, extra: Record<string, unknown> = {}): Ev =>
  ({ type: 'tool_call_end', payload: { agent: 'main', tool, result: 'ok', toolUseId: id, ...extra } })
const call = (tool: string, file: string, id: string, extra: Record<string, unknown> = {}): Ev[] =>
  [start(tool, file, id), end(tool, id, extra)]
const steps = (s: SimulationState, file: string) =>
  (s.fileAttention.get(file)?.timeline?.steps ?? []).map(x => `${x.kind}:${x.toolUseId}`)

test('repeated reads each make a step, in order, tied to their call', () => {
  const s = run([spawn, ...call('Read', '/r/a.ts', 'u1'), ...call('Read', '/r/a.ts', 'u2')])
  assert.deepEqual(steps(s, '/r/a.ts'), ['read:u1', 'read:u2'])
  const first = s.fileAttention.get('/r/a.ts')?.timeline?.steps[0]
  assert.ok(first?.agentId.endsWith('main'))
  assert.ok(first?.callId && s.toolCalls.has(first.callId), 'the step points at the tool call node')
})

test('an edit after a read, then a write: read, edited, written', () => {
  const s = run([spawn, ...call('Read', '/r/a.ts', 'u1'), ...call('Edit', '/r/a.ts', 'u2'), ...call('Write', '/r/a.ts', 'u3')])
  assert.deepEqual(steps(s, '/r/a.ts'), ['read:u1', 'edited:u2', 'written:u3'])
})

test('a failed or cancelled call makes no step; a call still running makes none yet', () => {
  const s = run([spawn,
    ...call('Edit', '/r/a.ts', 'u1', { isError: true, errorMessage: 'old_string not found' }),
    ...call('Write', '/r/a.ts', 'u2', { outcome: 'cancelled' }),
    start('Read', '/r/a.ts', 'u3'),
  ])
  assert.deepEqual(steps(s, '/r/a.ts'), [])
  // The counters still count the calls started
  assert.equal(s.fileAttention.get('/r/a.ts')?.edits, 2)
})

test('a replayed tool_result of the same call makes no second step', () => {
  const s = run([spawn, start('Edit', '/r/a.ts', 'u1'), end('Edit', 'u1'), end('Edit', 'u1'), end('Edit', 'u1')])
  assert.deepEqual(steps(s, '/r/a.ts'), ['edited:u1'])
})

test('an end whose start was never seen makes no step', () => {
  const s = run([spawn, end('Read', 'ghost')])
  assert.equal(s.fileAttention.size, 0)
})

test('the steps of each file stay apart', () => {
  const s = run([spawn, ...call('Read', '/r/a.ts', 'u1'), ...call('Write', '/r/b.ts', 'u2')])
  assert.deepEqual(steps(s, '/r/a.ts'), ['read:u1'])
  assert.deepEqual(steps(s, '/r/b.ts'), ['written:u2'])
})

test('the pipeline keeps the cap and counts the steps it no longer keeps', () => {
  const evs: Ev[] = [spawn]
  for (let i = 1; i <= FILE_TIMELINE_MAX_STEPS + 3; i++) evs.push(...call('Read', '/r/a.ts', `u${i}`))
  const t = run(evs).fileAttention.get('/r/a.ts')?.timeline
  assert.equal(t?.steps.length, FILE_TIMELINE_MAX_STEPS)
  assert.equal(t?.omitted, 3)
  assert.equal(t?.steps[0].toolUseId, 'u4')
})
