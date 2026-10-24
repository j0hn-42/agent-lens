/**
 * Relay + OpenCode runtime (#346): AGENT_LENS_RUNTIME=opencode is honoured when no runtime is given,
 * and a missing database gives a valid /status with no session (no crash) that says the database is not found.
 * Own file: createRelay() runs once per process.
 */
import { fakeHome, makeWorkspace, statusOf } from './relay-opencode-fixture'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('AGENT_LENS_RUNTIME=opencode', () => {
  let workspace = ''
  before(() => {
    process.env.AGENT_LENS_RUNTIME = 'opencode'
    process.env.OPENCODE_DB = path.join(fakeHome, 'absent', 'opencode.db')
    workspace = makeWorkspace()
  })
  after(() => {
    delete process.env.AGENT_LENS_RUNTIME
    delete process.env.OPENCODE_DB
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('selects the OpenCode runtime alone, and survives a missing database', async () => {
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace })
    try {
      const s = await statusOf(relay)
      assert.deepEqual(s.runtimes, ['opencode'])
      assert.equal(s.sessionCount, 0)
      assert.equal(JSON.stringify(s).includes('absent'), false, '/status must not expose the database path')
      // #420: the missing database is a proved state, said on /status (never deduced from an empty count)
      assert.deepEqual((s as { runtimeProblems?: unknown }).runtimeProblems, [{ runtime: 'opencode', message: 'OpenCode: database not found.' }])
    } finally { relay.dispose() }
  })
})
