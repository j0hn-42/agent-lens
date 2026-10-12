// Delegation report (#233): per sub-agent tokens, files read, duration and result, each one proven or said unknown.
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { processEvent, type ProcessEventContext } from '../web/hooks/simulation/process-event'
import { createEmptyState, type SimulationState } from '../web/hooks/simulation/types'
import type { SimulationEvent } from '../web/lib/agent-types'
import {
  deriveDelegationReport, durationText, resultText, filesReadText, tokensText,
  REPORT_EXCERPT_LEN, FILES_LISTED,
} from '../web/lib/delegation-report'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

type Ev = Pick<SimulationEvent, 'type' | 'payload'> & { replayed?: boolean; imported?: boolean }

function run(events: Ev[], sessionId = 's1'): SimulationState {
  let state = createEmptyState()
  let t = 0
  for (const e of events) {
    const time = ++t
    state = processEvent(
      { time, type: e.type, payload: e.payload, sessionId, ...(e.replayed ? { replayed: true } : {}), ...(e.imported ? { imported: true } : {}) },
      { ...state, currentTime: time }, ctx,
    )
  }
  return state
}

const main: Ev = { type: 'agent_spawn', payload: { name: 'main', isMain: true } }
const dispatch = (child: string, id: string): Ev => ({ type: 'subagent_dispatch', payload: { parent: 'main', child, toolUseId: id, task: `do ${child}` } })
const spawn = (child: string, id: string, extra: Record<string, unknown> = {}): Ev =>
  ({ type: 'agent_spawn', payload: { name: child, parent: 'main', toolUseId: id, subagentType: 'Explore', ...extra } })
const ret = (child: string, id: string, extra: Record<string, unknown> = {}): Ev =>
  ({ type: 'subagent_return', payload: { parent: 'main', child, toolUseId: id, summary: `${child} report`, ...extra } })
const read = (agent: string, file: string): Ev => ({ type: 'tool_call_start', payload: { agent, tool: 'Read', args: file, inputData: { file_path: file } } })
const readEnd = (agent: string, extra: Record<string, unknown> = {}): Ev => ({ type: 'tool_call_end', payload: { agent, tool: 'Read', result: 'ok', ...extra } })
const toolEnd = (agent: string, tokenCost: number, tokenSource = 'reported'): Ev =>
  ({ type: 'tool_call_end', payload: { agent, tool: 'Read', result: 'ok', tokenCost, tokenSource } })

const report = (s: SimulationState, parent = 's1:main') => deriveDelegationReport(parent, s.agents, s.fileAttention, s.edges)

// ─── Simulation: what the events prove ───────────────────────────────────────

test('a live return is kept on the sub-agent: report excerpt, outcome and the duration the runtime reported', () => {
  const s = run([main, dispatch('scout', 't1'), spawn('scout', 't1'), ret('scout', 't1', { durationS: 42.5 })])
  const r = s.agents.get('s1:scout')!.delegationReturn!
  assert.equal(r.excerpt, 'scout report')
  assert.equal(r.truncated, false)
  assert.equal(r.isError, false)
  assert.equal(r.durationS, 42.5)
})

test('a replayed or imported return keeps its report but never its duration (measured at parse time, not while it ran)', () => {
  for (const flag of ['replayed', 'imported'] as const) {
    const s = run([main, spawn('scout', 't1'), { ...ret('scout', 't1', { durationS: 0.1 }), [flag]: true }])
    const r = s.agents.get('s1:scout')!.delegationReturn!
    assert.equal(r.excerpt, 'scout report')
    assert.equal(r.durationS, undefined, `${flag}: duration dropped`)
  }
})

test('an invalid duration is not kept', () => {
  for (const durationS of [-1, Number.NaN, '12', Infinity]) {
    const s = run([main, spawn('scout', 't1'), ret('scout', 't1', { durationS })])
    assert.equal(s.agents.get('s1:scout')!.delegationReturn!.durationS, undefined, String(durationS))
  }
})

test('a long report is cut to an excerpt and says so', () => {
  const long = 'x'.repeat(REPORT_EXCERPT_LEN + 50)
  const s = run([main, spawn('scout', 't1'), ret('scout', 't1', { summary: long })])
  const r = s.agents.get('s1:scout')!.delegationReturn!
  assert.equal(r.excerpt.length, REPORT_EXCERPT_LEN)
  assert.equal(r.truncated, true)
})

test('an error return is kept as an error', () => {
  const s = run([main, spawn('scout', 't1'), ret('scout', 't1', { isError: true, summary: 'boom' })])
  assert.equal(s.agents.get('s1:scout')!.delegationReturn!.isError, true)
})

test('reads are recorded per agent: started, and observed to succeed', () => {
  const s = run([
    main, spawn('scout', 't1'),
    read('scout', '/repo/a.ts'), readEnd('scout'),
    read('scout', '/repo/b.ts'), readEnd('scout', { isError: true }),
    read('main', '/repo/a.ts'),
  ])
  const a = s.fileAttention.get('/repo/a.ts')!
  assert.deepEqual(a.readers?.map(r => [r.agent, r.started, r.succeeded]), [['s1:scout', 1, 1], ['s1:main', 1, 0]])
  const b = s.fileAttention.get('/repo/b.ts')!
  assert.deepEqual(b.readers?.map(r => [r.agent, r.started, r.succeeded]), [['s1:scout', 1, 0]])
})

// ─── The report ──────────────────────────────────────────────────────────────

test('one row per direct sub-agent of the parent, in spawn order; the parent, grandchildren and teammates are not rows', () => {
  const s = run([
    main,
    spawn('scout', 't1'), spawn('fixer', 't2'),
    { type: 'agent_spawn', payload: { name: 'deep', parent: 'scout', toolUseId: 't3' } },
    { type: 'agent_spawn', payload: { name: 'mate', parent: 'main', kind: 'teammate', teamName: 'crew', agentType: 'general-purpose' } },
  ])
  assert.deepEqual(report(s).map(r => r.agentId), ['s1:scout', 's1:fixer'])
  assert.deepEqual(report(s, 's1:scout').map(r => r.agentId), ['s1:deep'])
  assert.deepEqual(report(s, 's1:deep'), [])
})

test('tokens follow the sub-agent counter: unknown is "not reported", partial is "at least", local counts "estimated"', () => {
  const s0 = run([main, spawn('scout', 't1')])
  assert.equal(tokensText(report(s0)[0]), 'not reported')
  const s1 = run([main, spawn('scout', 't1'), read('scout', '/a'), toolEnd('scout', 1200)])
  assert.equal(tokensText(report(s1)[0]), '1.2k')
  const s2 = run([main, spawn('scout', 't1'), read('scout', '/a'), toolEnd('scout', 1200, 'estimated')])
  assert.equal(tokensText(report(s2)[0]), '1.2k estimated')
  const s3 = run([main, spawn('scout', 't1'), read('scout', '/a'), toolEnd('scout', 1200), read('scout', '/b'), readEnd('scout')])
  assert.equal(tokensText(report(s3)[0]), 'at least 1.2k')
})

test('files read: only reads observed to succeed are counted; the others are said not confirmed', () => {
  const s = run([
    main, spawn('scout', 't1'),
    read('scout', '/repo/a.ts'), readEnd('scout'),
    read('scout', '/repo/a.ts'), readEnd('scout'),
    read('scout', '/repo/b.ts'), readEnd('scout', { isError: true }),
    read('scout', '/repo/c.ts'),
    read('main', '/repo/d.ts'), readEnd('main'),
  ])
  const row = report(s)[0]
  assert.deepEqual(row.filesRead, ['/repo/a.ts'])
  assert.equal(row.readsNotConfirmed, 2)
  assert.equal(filesReadText(row), '1 file, 2 not confirmed')
})

test('files read: none observed is said in words, never "0 files"', () => {
  const s = run([main, spawn('scout', 't1')])
  assert.equal(filesReadText(report(s)[0]), 'none observed')
})

test('files read: the list is bounded and keeps the full count', () => {
  const evs: Ev[] = [main, spawn('scout', 't1')]
  for (let i = 0; i < FILES_LISTED + 5; i++) evs.push(read('scout', `/repo/f${String(i).padStart(3, '0')}.ts`), readEnd('scout'))
  const row = report(run(evs))[0]
  assert.equal(row.filesRead.length, FILES_LISTED)
  assert.equal(row.filesReadCount, FILES_LISTED + 5)
  assert.equal(filesReadText(row), `${FILES_LISTED + 5} files`)
})

test('duration: reported by the runtime, else "not reported"; without a return it is not known', () => {
  const live = run([main, spawn('scout', 't1'), ret('scout', 't1', { durationS: 75 })])
  assert.equal(durationText(report(live)[0].duration), '1:15 (reported)')
  const noDuration = run([main, spawn('scout', 't1'), ret('scout', 't1')])
  assert.equal(durationText(report(noDuration)[0].duration), 'not reported')
  const replayed = run([main, spawn('scout', 't1'), { ...ret('scout', 't1', { durationS: 75 }), replayed: true }])
  assert.equal(durationText(report(replayed)[0].duration), 'not reported')
  const running = run([main, spawn('scout', 't1')])
  assert.equal(durationText(report(running)[0].duration), 'no return observed')
})

test('result: the report excerpt, an error said in words, or that no return was observed', () => {
  const ok = run([main, spawn('scout', 't1'), ret('scout', 't1')])
  assert.equal(resultText(report(ok)[0].result), 'scout report')
  const err = run([main, spawn('scout', 't1'), ret('scout', 't1', { isError: true, summary: 'boom' })])
  assert.equal(resultText(report(err)[0].result), 'Error: boom')
  const cut = run([main, spawn('scout', 't1'), ret('scout', 't1', { summary: 'y'.repeat(REPORT_EXCERPT_LEN + 1) })])
  assert.ok(resultText(report(cut)[0].result).endsWith('…'))
  const running = run([main, spawn('scout', 't1')])
  assert.equal(resultText(report(running)[0].result), 'No return observed yet')
  const finished = run([main, spawn('scout', 't1'), { type: 'agent_complete', payload: { name: 'scout' } }])
  assert.equal(resultText(report(finished)[0].result), 'Finished, no return observed')
})

test('a sub-agent whose parent link is not proven is flagged', () => {
  // The spawn names a parent that is not known: the agent hangs on the main agent with an unverified link
  const s = run([main, { type: 'agent_spawn', payload: { name: 'stray', parent: 'ghost' } }])
  const row = report(s).find(r => r.agentId === 's1:stray')!
  assert.equal(row.linkVerified, false)
  const ok = run([main, dispatch('scout', 't1'), spawn('scout', 't1')])
  assert.equal(report(ok)[0].linkVerified, true)
})

test('the inspector of the shell receives the report of the selected agent and can select a sub-agent', () => {
  const shell = fs.readFileSync(path.resolve(__dirname, '..', 'web/components/agent-visualizer/index.tsx'), 'utf8')
  const card = shell.slice(shell.indexOf('<AgentDetailCard'), shell.indexOf('/>', shell.indexOf('<AgentDetailCard')))
  assert.match(card, /delegation=\{/)
  assert.match(card, /onSelectAgent=\{/)
  assert.match(shell, /deriveDelegationReport\(/)
})

// ─── Documentation ───────────────────────────────────────────────────────────

test('the reading guide documents the delegation report and what each column proves', () => {
  const guide = fs.readFileSync(path.resolve(__dirname, '..', 'docs/reading-the-ui.md'), 'utf8')
  assert.match(guide, /## Delegation report/)
  for (const term of ['not confirmed', 'no return observed', '(reported)', 'not reported']) {
    assert.ok(guide.includes(term), `guide should explain "${term}"`)
  }
})
