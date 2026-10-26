/**
 * One fs.watch per ACTIVE subagent file (#654). The poll (POLL_FALLBACK_MS) already re-reads every
 * subagent file, so the watcher of a finished one only costs an inotify slot: it is closed, and a
 * subagent that resumes after its end is still seen (by the poll, which also re-arms its watcher).
 */
import './helpers/alias-vscode'
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import fsModule from 'node:fs'
import * as path from 'node:path'
import { scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'
import { SUBAGENT_WATCH_IDLE_MS } from '../src/constants'
import {
  tmpDir, makeSession, writeJsonl, makeHarness, ofType, userText, assistantText, assistantToolUse, toolResult, writeTeammate,
} from './helpers/teams-fixtures'

const jl = (o: unknown) => JSON.stringify(o) + '\n'
const OLD = () => Date.now() - SUBAGENT_WATCH_IDLE_MS - 60_000

describe('subagent file watchers are held by active subagents only (#654)', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  const live = (session: ReturnType<typeof makeSession>) =>
    [...session.subagentWatchers.values()].filter(s => s.watcher !== null).length

  function setup(finished: number, recent: number) {
    dir = tmpDir()
    for (let i = 0; i < finished; i++) {
      writeTeammate(dir, {
        agentId: `old${String(i).padStart(3, '0')}`, meta: null, mtimeMs: OLD(),
        entries: [userText('audit'), assistantToolUse(`t${i}`, 'Read', { file_path: '/a.ts' }), toolResult(`t${i}`), assistantText('done')],
      })
    }
    for (let i = 0; i < recent; i++) {
      writeTeammate(dir, {
        agentId: `new${String(i).padStart(3, '0')}`, meta: null,
        entries: [userText('work'), assistantToolUse(`n${i}`, 'Bash', { command: 'sleep 1' })],
      })
    }
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    return { session, h }
  }

  it('after a scan, 40 finished subagents hold no watcher and the 2 active ones hold one each', () => {
    const { session, h } = setup(40, 2)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    scanSubagentsDir(h.delegate, h.parser, 's1') // the poll runs the scan again
    try {
      assert.equal(session.subagentWatchers.size, 42, 'every file stays tracked (offset, dedup)')
      assert.equal(live(session), 2)
    } finally { h.closeWatchers() }
  })

  it('a subagent that resumes after its end is read by the poll and watched again', () => {
    const { session, h } = setup(1, 0)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    const [file, state] = [...session.subagentWatchers.entries()][0]
    assert.equal(state.watcher, null)
    const before = h.events.length
    fs.appendFileSync(file, jl(userText('Resuming agent')) + jl(assistantToolUse('r1', 'Bash', { command: 'pnpm test' })))
    // What the 3 s poll of the pipeline does for every tracked subagent file
    readSubagentNewLines(h.delegate, h.parser, file, 's1')
    try {
      const starts = ofType(h.events.slice(before), 'tool_call_start')
      assert.equal(starts.length, 1, 'the resumed work is seen')
      assert.equal(starts[0].payload.toolUseId, 'r1')
      assert.notEqual(state.watcher, null, 'its watcher is armed again')
    } finally { h.closeWatchers() }
  })

  it('a watch that fails (ENOSPC) is not tried again at every read with new bytes (#613)', () => {
    const { session, h } = setup(1, 0)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    const [file, state] = [...session.subagentWatchers.entries()][0]
    assert.equal(state.watcher, null)
    const watch = mock.method(fsModule, 'watch', () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) })
    try {
      for (let i = 0; i < 3; i++) {
        fs.appendFileSync(file, jl(assistantToolUse(`f${i}`, 'Bash', { command: 'true' })))
        readSubagentNewLines(h.delegate, h.parser, file, 's1')
      }
    } finally { watch.mock.restore(); h.closeWatchers() }
    assert.equal(watch.mock.callCount(), 1, 'one attempt, then the failure is remembered')
    assert.equal(state.watchFailed, true)
  })

  it('a failure remembered at the first arming is forgotten once the subagent is idle: a later write is watched again (#613)', () => {
    const { session, h } = setup(1, 0)
    const watch = mock.method(fsModule, 'watch', () => { throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }) })
    try { scanSubagentsDir(h.delegate, h.parser, 's1') } finally { watch.mock.restore() }
    assert.ok(watch.mock.callCount() >= 1, 'the arming failed at the first scan')
    // The same scan releases the idle subagent: its failure is forgotten with its watcher
    const [file, state] = [...session.subagentWatchers.entries()][0]
    try {
      assert.equal(state.watchFailed, false)
      fs.appendFileSync(file, jl(assistantToolUse('again', 'Bash', { command: 'true' })))
      readSubagentNewLines(h.delegate, h.parser, file, 's1')
      assert.notEqual(state.watcher, null, 'the watcher is armed again')
    } finally { h.closeWatchers() }
  })

  it('a subagent whose dispatch is still open keeps its watcher however old its file is', () => {
    dir = tmpDir()
    writeTeammate(dir, {
      agentId: 'slow01', meta: null, mtimeMs: OLD(),
      entries: [userText('think'), assistantToolUse('s1', 'Read', { file_path: '/a.ts' })],
    })
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    const reg = h.parser.getSubagentRegistry('s1')
    const rec = reg.registerDispatch('toolu_open', 'slow', 'main')
    reg.bindFileKey(rec, 'slow01')
    session.pendingToolCalls.set('toolu_open', { name: 'Agent' } as never)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    scanSubagentsDir(h.delegate, h.parser, 's1')
    try {
      assert.equal(live(session), 1)
    } finally { h.closeWatchers() }
  })

  it('finished workflow agents and finished teammates release their watcher, the working ones keep it (#654)', () => {
    dir = tmpDir('agent-lens-wfrel-')
    const sub = path.join(dir, 'sess', 'subagents')
    const wfDir = path.join(sub, 'workflows', 'wf_a')
    fs.mkdirSync(wfDir, { recursive: true })
    const journal: unknown[] = []
    for (let i = 0; i < 40; i++) {
      const id = `w${String(i).padStart(3, '0')}`
      const file = path.join(wfDir, `agent-${id}.jsonl`)
      writeJsonl(file, [userText('task'), assistantText('done')], OLD())
      fs.writeFileSync(path.join(wfDir, `agent-${id}.meta.json`), JSON.stringify({
        agentType: 'workflow-subagent', description: `impl:${id}`, workflowPhase: 'Implement', spawnDepth: 1, requestShape: 'foreground',
      }))
      journal.push({ type: 'started', key: `v2:${id}`, agentId: id, label: `impl:${id}`, phase: 'Implement' })
      journal.push({ type: 'result', key: `v2:${id}`, agentId: id, result: { summary: 'ok' } })
    }
    // One workflow agent still working: open tool call, recent write
    const liveFile = path.join(wfDir, 'agent-live01.jsonl')
    writeJsonl(liveFile, [userText('task'), assistantToolUse('lv', 'Bash', { command: 'sleep 1' })])
    fs.writeFileSync(path.join(wfDir, 'agent-live01.meta.json'), JSON.stringify({
      agentType: 'workflow-subagent', description: 'impl:live01', workflowPhase: 'Implement', spawnDepth: 1, requestShape: 'foreground',
    }))
    fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), journal.map(e => JSON.stringify(e)).join('\n') + '\n')
    // A finished plain teammate
    writeTeammate(sub, { agentId: 'tm001', mtimeMs: OLD(), entries: [userText('x'), assistantText('done')] })

    const session = makeSession({ subagentsDir: sub })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    scanSubagentsDir(h.delegate, h.parser, 's1')
    try {
      assert.equal(session.subagentWatchers.size, 42, 'every file stays tracked')
      assert.equal(live(session), 1, 'only the working workflow agent holds a watcher')
      assert.notEqual(session.subagentWatchers.get(liveFile)?.watcher, null)
    } finally { h.closeWatchers() }
  })
})
