/**
 * Relay + Gemini CLI runtime (#238), option `runtime: 'gemini'`: /status lists only Gemini and counts
 * the session found through the project hash of the workspace; dispose releases the watcher.
 * Own file: createRelay() runs once per process (see relay-gemini-env*.test.ts for the variable).
 */
import { fakeHome, makeWorkspaceWithGeminiSession, statusOf } from './relay-gemini-fixture'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { GeminiSessionWatcher } from '../extension/src/gemini-session-watcher'

describe("relay runtime: 'gemini'", () => {
  let workspace = ''
  before(() => {
    delete process.env.AGENT_LENS_RUNTIME
    workspace = makeWorkspaceWithGeminiSession()
  })
  after(() => { fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('watches only Gemini, counts the session of the workspace, and releases the watcher on dispose', async () => {
    const disposeSpy = mock.method(GeminiSessionWatcher.prototype, 'dispose')
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace, runtime: 'gemini' })
    try {
      const s = await statusOf(relay)
      assert.deepEqual(s.runtimes, ['gemini'])
      assert.equal(s.sessionCount, 1)
      assert.equal(disposeSpy.mock.callCount(), 0)
    } finally { relay.dispose() }
    assert.equal(disposeSpy.mock.callCount(), 1)
    disposeSpy.mock.restore()
  })
})
