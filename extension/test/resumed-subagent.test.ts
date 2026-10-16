/**
 * A subagent that finished and is resumed (SendMessage "Resuming agent") appends to the same
 * subagents/agent-*.jsonl file (#433). What the extension emits for those lines decides what the web side
 * can know: no second agent_spawn, no agent_complete, but the agent's own tool_call_start and messages.
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { scanSubagentsDir, readSubagentNewLines } from '../src/subagent-watcher'
import {
  tmpDir, makeSession, makeHarness, ofType, userText, assistantText, assistantThinking, assistantToolUse, toolResult, writeTeammate,
} from './helpers/teams-fixtures'

const jl = (o: unknown) => JSON.stringify(o) + '\n'

describe('a resumed subagent keeps writing to its transcript (#433)', () => {
  let dir: string
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  function firstRun() {
    dir = tmpDir()
    const file = writeTeammate(dir, {
      agentId: 'resume01', meta: null,
      entries: [userText('audit the parser'), assistantToolUse('sub-t1', 'Read', { file_path: '/a.ts' })],
    })
    const session = makeSession({ subagentsDir: dir })
    const h = makeHarness(session)
    scanSubagentsDir(h.delegate, h.parser, 's1')
    h.closeWatchers()
    fs.appendFileSync(file, jl(toolResult('sub-t1')) + jl(assistantText('Done, no defect.')))
    readSubagentNewLines(h.delegate, h.parser, file, 's1')
    return { file, h }
  }

  it('the first run announces the subagent once', () => {
    const { h } = firstRun()
    assert.equal(ofType(h.events, 'agent_spawn').length, 1)
  })

  it('on resume: its tool call and messages are emitted under the same name, with no new agent_spawn and no agent_complete', () => {
    const { file, h } = firstRun()
    const name = String(ofType(h.events, 'agent_spawn')[0].payload.name)
    const before = h.events.length

    fs.appendFileSync(file, jl(userText('Resuming agent'))
      + jl(assistantThinking('where was I'))
      + jl(assistantText('picking it up'))
      + jl(assistantToolUse('sub-t2', 'Bash', { command: 'pnpm test' })))
    readSubagentNewLines(h.delegate, h.parser, file, 's1')

    const resumed = h.events.slice(before)
    assert.equal(ofType(resumed, 'agent_spawn').length, 0, 'the spawn is emitted once per subagent')
    assert.equal(ofType(resumed, 'agent_complete').length, 0)
    const starts = ofType(resumed, 'tool_call_start')
    assert.equal(starts.length, 1)
    assert.equal(starts[0].payload.agent, name)
    assert.equal(starts[0].payload.toolUseId, 'sub-t2')
    const roles = ofType(resumed, 'message').map(e => [e.payload.agent, e.payload.role])
    assert.deepEqual(roles, [[name, 'user'], [name, 'thinking'], [name, 'assistant']])
  })
})
