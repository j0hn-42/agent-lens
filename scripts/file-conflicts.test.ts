import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent, FileAttention } from '../web/lib/agent-types'
import { deriveFileConflicts, conflictPath, MAX_FILE_CONFLICTS } from '../web/lib/file-conflicts'
import { fileConflictSegments } from '../web/components/agent-visualizer/canvas/file-conflict-model'
import { buildA11yModel } from '../web/components/agent-visualizer/canvas/a11y-model'
import { LEGEND_ENTRIES } from '../web/lib/legend-entries'
import { DESCRIBED_ONLY } from '../web/lib/guided-steps'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { sessionId?: string; time?: number }

function run(events: Ev[]): SimulationState {
  let state = createEmptyState()
  let t = 0
  for (const e of events) {
    const time = e.time ?? ++t
    state = processEvent({ time, type: e.type, payload: e.payload, sessionId: e.sessionId }, { ...state, currentTime: time }, ctx)
  }
  return state
}

const spawn = (sessionId: string, name = 'main'): Ev => ({ sessionId, type: 'agent_spawn', payload: { name, isMain: true } })
const start = (sessionId: string, tool: string, file: string, agent = 'main', id?: string): Ev =>
  ({ sessionId, type: 'tool_call_start', payload: { agent, tool, args: file, inputData: { file_path: file }, ...(id ? { toolUseId: id } : {}) } })
const end = (sessionId: string, tool: string, extra: Record<string, unknown> = {}, agent = 'main'): Ev =>
  ({ sessionId, type: 'tool_call_end', payload: { agent, tool, result: 'ok', ...extra } })

/** Two sessions, each one editing `file` once, both edits succeeding. */
const twoSuccessfulEdits = (file = '/repo/src/a.ts'): Ev[] => [
  spawn('s1'), spawn('s2'),
  start('s1', 'Edit', file), end('s1', 'Edit'),
  start('s2', 'Write', file), end('s2', 'Write'),
]

// ─── Simulation: what an edit proves ─────────────────────────────────────────

test('a successful Edit / Write is recorded per agent on the file', () => {
  const s = run(twoSuccessfulEdits())
  const f = s.fileAttention.get('/repo/src/a.ts')!
  assert.deepEqual(f.editors?.map(e => [e.agent, e.started, e.succeeded]), [['s1:main', 1, 1], ['s2:main', 1, 1]])
})

test('two agents of two sessions whose edits of the same absolute file both succeeded are a conflict', () => {
  const conflicts = deriveFileConflicts(run(twoSuccessfulEdits()).fileAttention)
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].path, '/repo/src/a.ts')
  assert.deepEqual(conflicts[0].editors.map(e => [e.agent, e.edits]), [['s1:main', 1], ['s2:main', 1]])
})

test('two agents of one session (main and sub-agent) also conflict', () => {
  const s = run([
    spawn('s1'),
    { sessionId: 's1', type: 'agent_spawn', payload: { name: 'helper', parent: 'main' } },
    start('s1', 'Edit', '/repo/a.ts'), end('s1', 'Edit'),
    start('s1', 'Edit', '/repo/a.ts', 'helper'), end('s1', 'Edit', {}, 'helper'),
  ])
  assert.equal(deriveFileConflicts(s.fileAttention).length, 1)
})

test('a failed, cancelled or unfinished edit proves nothing', () => {
  const base = [spawn('s1'), spawn('s2'), start('s1', 'Edit', '/repo/a.ts'), end('s1', 'Edit')]
  assert.deepEqual(deriveFileConflicts(run([...base, start('s2', 'Edit', '/repo/a.ts'), end('s2', 'Edit', { isError: true })]).fileAttention), [])
  assert.deepEqual(deriveFileConflicts(run([...base, start('s2', 'Edit', '/repo/a.ts'), end('s2', 'Edit', { outcome: 'cancelled' })]).fileAttention), [])
  assert.deepEqual(deriveFileConflicts(run([...base, start('s2', 'Edit', '/repo/a.ts')]).fileAttention), [])
  const pending = run([...base, start('s2', 'Edit', '/repo/a.ts')]).fileAttention.get('/repo/a.ts')!
  assert.deepEqual(pending.editors?.map(e => [e.agent, e.started, e.succeeded]), [['s1:main', 1, 1], ['s2:main', 1, 0]])
})

test('reads, one agent editing twice, or two different files are not conflicts', () => {
  assert.deepEqual(deriveFileConflicts(run([
    spawn('s1'), spawn('s2'),
    start('s1', 'Edit', '/repo/a.ts'), end('s1', 'Edit'),
    start('s2', 'Read', '/repo/a.ts'), end('s2', 'Read'),
  ]).fileAttention), [])
  assert.deepEqual(deriveFileConflicts(run([
    spawn('s1'),
    start('s1', 'Edit', '/repo/a.ts'), end('s1', 'Edit'),
    start('s1', 'Edit', '/repo/a.ts'), end('s1', 'Edit'),
  ]).fileAttention), [])
  assert.deepEqual(deriveFileConflicts(run([
    spawn('s1'), spawn('s2'),
    start('s1', 'Edit', '/repo/a.ts'), end('s1', 'Edit'),
    start('s2', 'Edit', '/repo/b.ts'), end('s2', 'Edit'),
  ]).fileAttention), [])
})

test('a relative path cannot prove two agents touched the same file', () => {
  assert.deepEqual(deriveFileConflicts(run(twoSuccessfulEdits('src/a.ts')).fileAttention), [])
})

test('MultiEdit and NotebookEdit (notebook_path) count as edits', () => {
  const s = run([
    spawn('s1'), spawn('s2'),
    start('s1', 'MultiEdit', '/repo/n.ipynb'), end('s1', 'MultiEdit'),
    { sessionId: 's2', type: 'tool_call_start', payload: { agent: 'main', tool: 'NotebookEdit', args: '', inputData: { notebook_path: '/repo/n.ipynb' } } },
    end('s2', 'NotebookEdit'),
  ])
  assert.equal(deriveFileConflicts(s.fileAttention).length, 1)
})

test('the end closes the edit it belongs to, not an older call of the same tool', () => {
  const s = run([
    spawn('s1'), spawn('s2'),
    start('s1', 'Edit', '/repo/old.ts', 'main', 'tu1'), end('s1', 'Edit', { toolUseId: 'tu1' }),
    start('s1', 'Edit', '/repo/a.ts', 'main', 'tu2'), end('s1', 'Edit', { toolUseId: 'tu2' }),
    start('s2', 'Edit', '/repo/a.ts'), end('s2', 'Edit'),
  ])
  assert.deepEqual(s.fileAttention.get('/repo/old.ts')!.editors?.map(e => e.succeeded), [1])
  assert.deepEqual(deriveFileConflicts(s.fileAttention).map(c => c.path), ['/repo/a.ts'])
})

// ─── Pure derivation ─────────────────────────────────────────────────────────

test('conflictPath keeps absolute paths only, normalised', () => {
  assert.equal(conflictPath('/repo/./src//a.ts'), '/repo/src/a.ts')
  assert.equal(conflictPath('/repo/b/../a.ts'), '/repo/a.ts')
  assert.equal(conflictPath('C:\\Repo\\a.ts'), 'c:/Repo/a.ts')
  assert.equal(conflictPath('src/a.ts'), undefined)
  assert.equal(conflictPath(''), undefined)
  assert.equal(conflictPath('/../etc'), undefined)
})

const fa = (path: string, editors: Array<[string, number, number, number?]>): [string, FileAttention] => [path, {
  path, reads: 0, edits: editors.length, totalTokens: 0, lastAccessed: 0, agents: editors.map(e => e[0]),
  editors: editors.map(([agent, started, succeeded, last]) => ({ agent, started, succeeded, ...(last !== undefined ? { lastEditTime: last } : {}) })),
}]

test('two spellings of one absolute file are merged', () => {
  const conflicts = deriveFileConflicts(new Map([fa('/repo/a.ts', [['s1:main', 1, 1, 5]]), fa('/repo/./a.ts', [['s2:main', 1, 1, 7]])]))
  assert.equal(conflicts.length, 1)
  assert.deepEqual(conflicts[0].editors.map(e => e.agent), ['s1:main', 's2:main'])
  assert.equal(conflicts[0].lastEditTime, 7)
})

test('conflicts are sorted by most recent edit and bounded', () => {
  const many = new Map(Array.from({ length: MAX_FILE_CONFLICTS + 5 }, (_, i) => fa(`/r/${i}.ts`, [['a', 1, 1, i], ['b', 1, 1, i]])))
  const out = deriveFileConflicts(many)
  assert.equal(out.length, MAX_FILE_CONFLICTS)
  assert.equal(out[0].path, `/r/${MAX_FILE_CONFLICTS + 4}.ts`)
})

test('legacy entries without editors yield nothing', () => {
  assert.deepEqual(deriveFileConflicts(new Map([['/a', { path: '/a', reads: 0, edits: 3, totalTokens: 0, lastAccessed: 0, agents: ['x', 'y'] }]])), [])
})

// ─── Canvas geometry and accessible mirror ───────────────────────────────────

const pos = (id: string, x: number, y: number, name = id) => [id, { id, name, x, y }] as const

test('one segment per pair of agents on screen, with the files it covers', () => {
  const conflicts = deriveFileConflicts(new Map([
    fa('/r/a.ts', [['s1:main', 1, 1, 1], ['s2:main', 1, 1, 2]]),
    fa('/r/b.ts', [['s2:main', 1, 1, 3], ['s1:main', 1, 1, 4]]),
  ]))
  const segs = fileConflictSegments(conflicts, new Map([pos('s1:main', 0, 0), pos('s2:main', 100, 0)]))
  assert.equal(segs.length, 1)
  assert.deepEqual([segs[0].x1, segs[0].y1, segs[0].x2, segs[0].y2], [0, 0, 100, 0])
  assert.deepEqual([...segs[0].paths].sort(), ['/r/a.ts', '/r/b.ts'])
})

test('no segment when an agent is not on screen or the geometry is not finite', () => {
  const conflicts = deriveFileConflicts(new Map([fa('/r/a.ts', [['s1:main', 1, 1], ['s2:main', 1, 1]])]))
  assert.deepEqual(fileConflictSegments(conflicts, new Map([pos('s1:main', 0, 0)])), [])
  assert.deepEqual(fileConflictSegments(conflicts, new Map([pos('s1:main', 0, 0), pos('s2:main', NaN, 0)])), [])
  assert.deepEqual(fileConflictSegments([], new Map([pos('s1:main', 0, 0), pos('s2:main', 1, 0)])), [])
})

/* eslint-disable @typescript-eslint/no-explicit-any */
function agent(id: string, sessionId: string, x: number, name = 'main'): any {
  return {
    id, agentKey: id, sessionId, localId: 'main', displayName: name, name, sessionLabel: sessionId,
    state: 'idle', parentId: null, parentKey: null, tokensUsed: 0, tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x, y: 0, vx: 0, vy: 0, pinned: false, isMain: true, kind: 'main',
    spawnTime: 0, lastActiveTime: 0, currentTool: undefined, opacity: 1,
  }
}

test('the outline lists each conflict with the agents, their sessions and their successful edits', () => {
  const agents = new Map([['s1:main', agent('s1:main', 's1', 0, 'alpha')], ['s2:main', agent('s2:main', 's2', 400, 'beta')]])
  const fileAttention = new Map([fa('/repo/a.ts', [['s1:main', 2, 2, 1], ['s2:main', 1, 1, 2]])])
  const model = buildA11yModel(agents, new Map(), [], new Map(), {
    sessions: new Map([['s1', { label: 'Main' }], ['s2', { label: 'Fix' }]]), fileAttention,
  })
  assert.equal(model.fileConflicts.length, 1)
  assert.equal(model.fileConflicts[0].text, '/repo/a.ts edited by alpha (session Main): 2 successful edits; beta (session Fix): 1 successful edit')
  // Without the file data, nothing is claimed
  assert.deepEqual(buildA11yModel(agents, new Map(), [], new Map()).fileConflicts, [])
})

test('the outline names an agent that is not on screen by its key, never drops it silently', () => {
  const agents = new Map([['s1:main', agent('s1:main', 's1', 0, 'alpha')]])
  const fileAttention = new Map([fa('/repo/a.ts', [['s1:main', 1, 1], ['s2:main', 1, 1]])])
  const model = buildA11yModel(agents, new Map(), [], new Map(), { fileAttention })
  assert.match(model.fileConflicts[0].text, /alpha \(session s1\): 1 successful edit; s2:main \(not on screen\): 1 successful edit$/)
})

test('the conflict edge has a legend entry, described in the guided tour', () => {
  assert.ok((LEGEND_ENTRIES.edges as readonly string[]).includes('edge-file-conflict'))
  assert.ok((DESCRIBED_ONLY as readonly string[]).includes('edge-file-conflict'))
})
