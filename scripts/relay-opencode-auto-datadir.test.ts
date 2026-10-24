/**
 * Relay in auto mode (#420): the OpenCode data directory exists but holds no database. OpenCode is used on
 * this machine and its sessions cannot be read: that one is a real problem, said on /status.
 * Own file: createRelay() runs once per process.
 */
import { fakeHome, makeWorkspace, statusOf } from './relay-opencode-fixture'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('auto mode, OpenCode data directory without its database', () => {
  let workspace = ''
  before(() => {
    delete process.env.AGENT_LENS_RUNTIME
    delete process.env.OPENCODE_DB
    workspace = makeWorkspace()
    fs.mkdirSync(path.join(fakeHome, '.local', 'share', 'opencode'), { recursive: true })
  })
  after(() => { fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('reports the missing database, without its path', async () => {
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace })
    try {
      const s = await statusOf(relay)
      assert.ok(s.runtimes.includes('opencode'))
      assert.deepEqual((s as { runtimeProblems?: unknown }).runtimeProblems, [{ runtime: 'opencode', message: 'OpenCode: database not found.' }])
      assert.equal(JSON.stringify(s).includes('.local'), false, '/status must not expose the data directory')
    } finally { relay.dispose() }
  })
})
