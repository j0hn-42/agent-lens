/**
 * SessionWatcher wiring of the EventReconciler (issue #53): the prescan runs inside withHistory,
 * transcript and hook events share one dedup memory, and that memory follows the session lifecycle.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentEvent } from '../src/protocol'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-watcher-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome

const SESSION = '66666666-6666-4666-8666-666666666666'
const line = (o: unknown) => JSON.stringify(o) + '\n'
const toolStart = (id: string, src: string): AgentEvent =>
  ({ time: 1, type: 'tool_call_start', payload: { agent: 'main', tool: 'Bash', toolUseId: id, src }, sessionId: SESSION })

type Internals = {
  parser: { prescanExistingContent: (...a: unknown[]) => unknown }
  emit: (event: AgentEvent, sessionId?: string) => void
  unwatchSession: (id: string) => void
}

describe('SessionWatcher + EventReconciler', () => {
  let projectDir = ''
  let SessionWatcher: typeof import('../src/session-watcher').SessionWatcher
  before(async () => {
    const vscodeShim = require('vscode') as { window: Record<string, unknown> }
    vscodeShim.window.setStatusBarMessage = () => ({ dispose() {} })
    ;({ SessionWatcher } = await import('../src/session-watcher'))
    const cwd = fs.realpathSync(process.cwd())
    projectDir = path.join(fakeHome, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`),
      line({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the build' } }))
  })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('holds hook events during the prescan and drops the ones the history already reported', () => {
    const watcher = new SessionWatcher()
    const hookOut: AgentEvent[] = []
    watcher.onHookEvent(e => hookOut.push(e))
    const internals = watcher as unknown as Internals
    const original = internals.parser.prescanExistingContent.bind(internals.parser)
    let heldDuringLoad = -1
    let deliveredDuringLoad = -1
    let loadingDuringLoad = false
    internals.parser.prescanExistingContent = (...args: unknown[]) => {
      const result = original(...args)
      // A live hook event arrives while the history is being read
      internals.emit(toolStart('in-history', 'jsonl'), SESSION)
      watcher.submitHookEvent(toolStart('in-history', 'hook')) // copy of what the history reported
      watcher.submitHookEvent(toolStart('live-only', 'hook'))
      loadingDuringLoad = watcher.reconciler.isLoading
      heldDuringLoad = watcher.reconciler.heldCount
      deliveredDuringLoad = hookOut.length
      return result
    }
    watcher.start()
    try {
      assert.equal(loadingDuringLoad, true, 'the prescan runs inside withHistory')
      assert.equal(heldDuringLoad, 3, 'everything is held while the history loads')
      assert.equal(deliveredDuringLoad, 0, 'nothing is delivered before the load ends')
      assert.deepEqual(hookOut.map(e => e.payload.toolUseId), ['live-only'], 'the duplicate is dropped, the live-only event kept')
      assert.equal(watcher.reconciler.heldCount, 0)
    } finally { watcher.dispose() }
  })

  it('forgets a session\'s delivered ids when it is unwatched, and everything on dispose', () => {
    const watcher = new SessionWatcher()
    watcher.start()
    const internals = watcher as unknown as Internals
    assert.equal(watcher.reconciler.rememberedSessions, 1, 'precondition: the watched session is remembered')
    internals.unwatchSession(SESSION)
    assert.equal(watcher.reconciler.rememberedSessions, 0, 'unwatchSession forgets the session')

    internals.emit(toolStart('x', 'jsonl'), 'another-session')
    assert.equal(watcher.reconciler.rememberedSessions, 1)
    watcher.dispose()
    assert.equal(watcher.reconciler.rememberedSessions, 0, 'dispose clears the memory')
  })
})
