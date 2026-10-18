/**
 * Relay + OpenCode runtime (#346), option `runtime: 'opencode'`: /status lists only OpenCode and counts
 * the root session of the workspace read from the SQLite database (OPENCODE_DB); dispose releases the watcher.
 * Own file: createRelay() runs once per process (see relay-opencode-env.test.ts for the variable).
 */
import { fakeHome, makeWorkspace, makeDbWithSession, statusOf } from './relay-opencode-fixture'
import { describe, it, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { OpenCodeSessionWatcher } from '../extension/src/opencode-session-watcher'
import { sqliteAvailable } from '../extension/test/helpers/opencode-fixture'

describe("relay runtime: 'opencode'", { skip: !sqliteAvailable() && 'node:sqlite unavailable' }, () => {
  let workspace = ''
  before(() => {
    delete process.env.AGENT_LENS_RUNTIME
    workspace = makeWorkspace()
    process.env.OPENCODE_DB = makeDbWithSession(workspace)
  })
  after(() => {
    delete process.env.OPENCODE_DB
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('watches only OpenCode, counts the session of the workspace, and releases the watcher on dispose', async () => {
    const disposeSpy = mock.method(OpenCodeSessionWatcher.prototype, 'dispose')
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace, runtime: 'opencode' })
    try {
      const s = await statusOf(relay)
      assert.deepEqual(s.runtimes, ['opencode'])
      assert.equal(s.sessionCount, 1)
      assert.equal(JSON.stringify(s).includes('opencode.db'), false, '/status must not expose the database path')
      assert.equal((s as { runtimeProblems?: unknown }).runtimeProblems, undefined, 'a database that reads is no problem (#420)')
      assert.equal((s as { runtimeLosses?: unknown }).runtimeLosses, undefined, 'nothing lost: nothing claimed (#420)')
      // Losses outside the followed sessions reach /status, as counts read when answering (#420)
      const losses = mock.method(OpenCodeSessionWatcher.prototype, 'unattributedLosses', () => ({ unreadableRows: 2, missedUpdates: 3 }))
      try {
        const lossy = await statusOf(relay)
        assert.deepEqual((lossy as { runtimeLosses?: unknown }).runtimeLosses, [{ runtime: 'opencode', unreadableRows: 2, missedUpdates: 3 }])
      } finally { losses.mock.restore() }
      assert.equal(disposeSpy.mock.callCount(), 0)
    } finally { relay.dispose() }
    assert.equal(disposeSpy.mock.callCount(), 1)
    disposeSpy.mock.restore()
  })
})
