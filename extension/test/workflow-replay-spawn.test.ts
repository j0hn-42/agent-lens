/**
 * #79: the webview replay (replaySessionStart) must re-announce a workflow agent with the same
 * teamKind as the live agent_spawn, otherwise a reconnecting webview shows the group as a "Team".
 */
import './helpers/alias-vscode'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'
import { scanSubagentsDir } from '../src/subagent-watcher'
import {
  tmpDir, makeSession, makeHarness, ofType, writeJsonl, userText, assistantText,
} from './helpers/teams-fixtures'

describe('webview replay of workflow agents', () => {
  let dir = ''
  let closeWatchers: () => void = () => {}
  afterEach(() => {
    closeWatchers()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('forwards teamKind in the replayed agent_spawn', async () => {
    dir = tmpDir('agent-lens-replay-')
    const subDir = path.join(dir, 'sess', 'subagents')
    const wfDir = path.join(subDir, 'workflows', 'wf_test0002-xyz')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.mkdirSync(path.join(dir, 'sess', 'workflows', 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sess', 'workflows', 'scripts', 'demo-flow-wf_test0002-xyz.js'), '')
    writeJsonl(path.join(wfDir, 'agent-aaa00001.jsonl'), [userText('go'), assistantText('ok')])
    fs.writeFileSync(path.join(wfDir, 'agent-aaa00001.meta.json'), JSON.stringify({ description: 'impl:a', workflowPhase: 'Implement' }))

    const session = makeSession({ subagentsDir: subDir })
    const h = makeHarness(session)
    closeWatchers = h.closeWatchers
    scanSubagentsDir(h.delegate, h.parser, 's1')
    const live = ofType(h.events, 'agent_spawn').find(e => e.payload.kind === 'teammate')
    assert.equal(live?.payload.teamKind, 'workflow', 'live spawn carries the kind')

    const { SessionWatcher } = await import('../src/session-watcher')
    const watcher = new SessionWatcher()
    const replayed: AgentEvent[] = []
    watcher.onEvent(e => { replayed.push(e) })
    ;(watcher as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', session)
    watcher.replaySessionStart(['s1'])
    const again = ofType(replayed, 'agent_spawn').find(e => e.payload.kind === 'teammate')
    assert.ok(again, 'the teammate is replayed')
    assert.equal(again.payload.teamKind, 'workflow')
    assert.equal(again.payload.teamName, 'demo-flow')
  })
})
