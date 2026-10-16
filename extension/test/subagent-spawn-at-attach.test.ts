/**
 * A subagent launched BEFORE the relay attached and still working (#446). The prescan of the lead
 * transcript registers its dispatch without emitting anything, and the subagent file watcher took that
 * registration for an emitted spawn: no agent_spawn was ever sent, and the web dropped all its events.
 *
 * Rule: at attach, the missing agent_spawn is emitted only for a dispatch proven in the history, with no
 * end observed (no final tool_result, no terminal <task-notification>) and a subagent file on disk. At most
 * SUBAGENT_CATCH_UP_SPAWNS_MAX at once, in dispatch order; the others are announced on their first new line.
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'
import { scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'
import { SUBAGENT_CATCH_UP_SPAWNS_MAX } from '../src/constants'
import {
  tmpDir, makeSession, makeHarness, ofType, userText, assistantText, assistantToolUse, toolResult, writeJsonl,
} from './helpers/teams-fixtures'

const jl = (o: unknown) => JSON.stringify(o) + '\n'

/** The Agent dispatch of the lead (tool_use) */
const dispatch = (id: string, description: string, background = true) => ({
  type: 'assistant', uuid: `a-${id}`,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'x', ...(background ? { run_in_background: true } : {}) } }] },
})
/** The launch receipt of a background dispatch */
const receipt = (id: string, agentId: string) => ({
  type: 'user', uuid: `u-${id}`, toolUseResult: { isAsync: true, status: 'async_launched', agentId },
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'Async agent launched' }] },
})
/** The terminal notification of a background subagent */
const notice = (id: string, agentId: string, status = 'completed') => userText(
  `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n<result>Report.</result>\n</task-notification>`,
  { uuid: `n-${id}` },
)

interface SubFile {
  agentId: string
  /** Written in the meta when set */
  toolUseId?: string
  description: string
  entries?: unknown[]
  /** Extra meta fields (stoppedByUser, parentAgentId, ...) */
  meta?: Record<string, unknown>
  /** File mtime (ms); default: now */
  mtimeMs?: number
}

describe('a subagent already running when the relay attaches (#446)', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  /** Attach as the pipeline does: prescan, catch-up of the current turn, scan of the subagent files. */
  function attach(history: unknown[], subs: SubFile[]) {
    dir = tmpDir()
    const main = path.join(dir, 's1.jsonl')
    const subDir = path.join(dir, 's1', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    writeJsonl(main, history)
    const files = new Map<string, string>()
    for (const s of subs) {
      fs.writeFileSync(path.join(subDir, `agent-${s.agentId}.meta.json`), JSON.stringify({
        agentType: 'general-purpose', description: s.description, ...(s.toolUseId ? { toolUseId: s.toolUseId } : {}), ...s.meta,
      }))
      const file = path.join(subDir, `agent-${s.agentId}.jsonl`)
      // Between two calls: its last call already answered
      writeJsonl(file, s.entries ?? [userText('Do it'), assistantToolUse(`${s.agentId}-t1`, 'Read', { file_path: '/a.ts' }), toolResult(`${s.agentId}-t1`)], s.mtimeMs)
      files.set(s.agentId, file)
    }
    const session = makeSession({ filePath: main, subagentsDir: subDir })
    const h = makeHarness(session)
    const entries = h.parser.prescanExistingContent(main, fs.statSync(main).size, session)
    h.parser.emitCatchUpEntries(entries, session, 's1')
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    const atAttach = h.events.length
    /** The subagent keeps working after the attach */
    const grow = (agentId: string, n = 2) => {
      const file = files.get(agentId)!
      fs.appendFileSync(file, jl(assistantText(`step ${n}`)) + jl(assistantToolUse(`${agentId}-t${n}`, 'Bash', { command: 'pnpm test' })))
      readSubagentNewLines(h.delegate, h.parser, file, 's1')
    }
    /** A new line of the lead transcript, read as the session watcher reads it */
    const lead = (entry: unknown) => {
      fs.appendFileSync(main, jl(entry))
      h.parser.processTranscriptLine(JSON.stringify(entry), 'orchestrator', session.pendingToolCalls, session.seenToolUseIds, 's1')
    }
    return { h, session, grow, lead, atAttach }
  }

  const spawnNames = (events: AgentEvent[]) => ofType(events, 'agent_spawn').map(e => String(e.payload.name))

  it('an open background launch with its file: one agent_spawn at attach, under the name its later events use', () => {
    const { h, grow, atAttach } = attach(
      [userText('Audit the parser'), dispatch('toolu_bg1', 'Audit parser'), receipt('toolu_bg1', 'a0000000000000001'), userText('je dois m\'absenter')],
      [{ agentId: 'a0000000000000001', toolUseId: 'toolu_bg1', description: 'Audit parser' }],
    )
    assert.deepEqual(spawnNames(h.events.slice(0, atAttach)), ['Audit parser'], 'announced at attach')
    const spawn = ofType(h.events, 'agent_spawn')[0]
    assert.equal(spawn.payload.parent, 'orchestrator')
    assert.equal(spawn.payload.toolUseId, 'toolu_bg1')
    grow('a0000000000000001')
    grow('a0000000000000001', 3)
    const starts = ofType(h.events, 'tool_call_start')
    assert.equal(starts.length, 2)
    assert.ok(starts.every(e => e.payload.agent === 'Audit parser'), 'same name as the spawn')
    assert.ok(h.events.indexOf(spawn) < h.events.indexOf(starts[0]), 'spawn before its first event')
    assert.equal(ofType(h.events, 'agent_spawn').length, 1, 'the lazy spawn of the file watcher does not repeat it')
  })

  it('an open synchronous dispatch (no tool_result yet) is announced at attach', () => {
    const { h, grow } = attach(
      [userText('Audit'), dispatch('toolu_s1', 'Sync audit', false)],
      [{ agentId: 'a0000000000000002', toolUseId: 'toolu_s1', description: 'Sync audit' }],
    )
    assert.deepEqual(spawnNames(h.events), ['Sync audit'])
    grow('a0000000000000002')
    assert.equal(ofType(h.events, 'agent_spawn').length, 1)
    assert.equal(ofType(h.events, 'tool_call_start')[0].payload.agent, 'Sync audit')
  })

  it('a dispatch whose final tool_result is in the history is not brought back, even when its file grows', () => {
    const { h, grow } = attach(
      [userText('Audit'), dispatch('toolu_s2', 'Done audit', false), toolResult('toolu_s2', 'Report.'), userText('next')],
      [{ agentId: 'a0000000000000003', toolUseId: 'toolu_s2', description: 'Done audit' }],
    )
    grow('a0000000000000003')
    assert.deepEqual(spawnNames(h.events), [])
  })

  it('a background launch notified as finished in the history is not brought back, even when its file grows', () => {
    for (const status of ['completed', 'failed', 'killed']) {
      const { h, grow } = attach(
        [userText('Audit'), dispatch('toolu_bg2', 'Old audit'), receipt('toolu_bg2', 'a0000000000000004'), notice('toolu_bg2', 'a0000000000000004', status), userText('next')],
        [{ agentId: 'a0000000000000004', toolUseId: 'toolu_bg2', description: 'Old audit' }],
      )
      grow('a0000000000000004')
      assert.deepEqual(spawnNames(h.events), [], status)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a notification without a terminal status proves no end: the launch is still announced', () => {
    const { h } = attach(
      [userText('Audit'), dispatch('toolu_bg3', 'Restarted audit'), receipt('toolu_bg3', 'a0000000000000005'), notice('toolu_bg3', 'a0000000000000005', '')],
      [{ agentId: 'a0000000000000005', toolUseId: 'toolu_bg3', description: 'Restarted audit' }],
    )
    assert.deepEqual(spawnNames(h.events), ['Restarted audit'])
  })

  it('an open launch with no subagent file emits nothing', () => {
    const { h } = attach([userText('Audit'), dispatch('toolu_bg4', 'No file'), receipt('toolu_bg4', 'a0000000000000006')], [])
    assert.deepEqual(spawnNames(h.events), [])
  })

  it('a launch finished then resumed by SendMessage in the history (#433) is open again: announced once', () => {
    const resume = [
      { type: 'assistant', uuid: 'a-send', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_send', name: 'SendMessage', input: { to: 'a0000000000000007', message: 'Carry on.' } }] } },
      { type: 'user', uuid: 'u-send', toolUseResult: { success: true, message: 'Resuming agent', resumedAgentId: 'a0000000000000007' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: 'Resuming agent' }] } },
    ]
    const { h, grow } = attach(
      [userText('Audit'), dispatch('toolu_bg5', 'Resumed audit'), receipt('toolu_bg5', 'a0000000000000007'), notice('toolu_bg5', 'a0000000000000007'), ...resume],
      [{ agentId: 'a0000000000000007', toolUseId: 'toolu_bg5', description: 'Resumed audit' }],
    )
    grow('a0000000000000007')
    assert.deepEqual(spawnNames(h.events), ['Resumed audit'])
  })

  it(`at most SUBAGENT_CATCH_UP_SPAWNS_MAX at attach, in dispatch order; the others on their first new line`, () => {
    const n = SUBAGENT_CATCH_UP_SPAWNS_MAX + 2
    const history: unknown[] = [userText('Fan out')]
    const subs: SubFile[] = []
    for (let i = 0; i < n; i++) {
      // Agent ids in the reverse order of the dispatches: the order cannot come from the file names
      const agentId = `a${String(n - i).padStart(16, '0')}`
      const id = `toolu_f${i}`
      history.push(dispatch(id, `Task ${i}`), receipt(id, agentId))
      subs.push({ agentId, toolUseId: id, description: `Task ${i}` })
    }
    const { h, grow, atAttach } = attach(history, subs)
    const first = spawnNames(h.events.slice(0, atAttach))
    assert.deepEqual(first, subs.slice(0, SUBAGENT_CATCH_UP_SPAWNS_MAX).map(s => s.description), 'capped, dispatch order')
    const late = subs[subs.length - 1]
    grow(late.agentId)
    const after = h.events.slice(atAttach)
    assert.deepEqual(spawnNames(after), [late.description], 'announced on its first new line')
    assert.ok(after.findIndex(e => e.type === 'agent_spawn') < after.findIndex(e => e.type === 'tool_call_start'))
    // Growth of an agent already announced adds no spawn
    grow(subs[0].agentId)
    assert.equal(ofType(h.events, 'agent_spawn').length, SUBAGENT_CATCH_UP_SPAWNS_MAX + 1)
  })

  it('a background launch the user stopped (meta stoppedByUser) is not drawn, even when its file grows', () => {
    const { h, grow } = attach(
      [userText('Audit'), dispatch('toolu_st1', 'Stopped'), receipt('toolu_st1', 'a0000000000000008'), userText('next')],
      [{ agentId: 'a0000000000000008', toolUseId: 'toolu_st1', description: 'Stopped', meta: { requestShape: 'background', stoppedByUser: true } }],
    )
    assert.deepEqual(spawnNames(h.events), [], 'not at attach')
    grow('a0000000000000008')
    assert.deepEqual(spawnNames(h.events), [], 'not after growth')
  })

  it('a nested subagent with pending work is announced after its parent caught up at attach, under it', () => {
    const { h } = attach(
      [userText('Audit'), dispatch('toolu_p1', 'Parent'), receipt('toolu_p1', 'a00000000000000p1')],
      [
        { agentId: 'a00000000000000p1', toolUseId: 'toolu_p1', description: 'Parent' },
        {
          agentId: 'a00000000000000c1', toolUseId: 'toolu_N', description: 'Child', meta: { parentAgentId: 'a00000000000000p1' },
          // A tool call not answered yet: the file watcher announces it at once
          entries: [userText('Do it'), assistantToolUse('a00000000000000c1-t1', 'Read', { file_path: '/a.ts' })],
        },
      ],
    )
    assert.deepEqual(spawnNames(h.events), ['Parent', 'Child'], 'the parent exists when its child is announced')
    const child = ofType(h.events, 'agent_spawn').find(e => e.payload.name === 'Child')!
    assert.equal(child.payload.parent, 'Parent')
  })
})

