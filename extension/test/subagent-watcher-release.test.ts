/**
 * One fs.watch per ACTIVE subagent file (#654). The poll (POLL_FALLBACK_MS) already re-reads every
 * subagent file, so the watcher of a finished one only costs an inotify slot: it is closed, and a
 * subagent that resumes after its end is still seen (by the poll, which also re-arms its watcher).
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'
import { SUBAGENT_WATCH_IDLE_MS } from '../src/constants'
import {
  tmpDir, makeSession, makeHarness, ofType, userText, assistantText, assistantToolUse, toolResult, writeTeammate,
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
})
