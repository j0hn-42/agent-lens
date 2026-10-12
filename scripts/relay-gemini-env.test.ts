/**
 * Relay + Gemini CLI runtime (#238): AGENT_LENS_RUNTIME=gemini is honoured when no runtime is given.
 * Own file: createRelay() runs once per process.
 */
import { fakeHome, makeWorkspaceWithGeminiSession, statusOf } from './relay-gemini-fixture'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'

describe('AGENT_LENS_RUNTIME=gemini', () => {
  let workspace = ''
  before(() => {
    process.env.AGENT_LENS_RUNTIME = 'gemini'
    workspace = makeWorkspaceWithGeminiSession()
  })
  after(() => {
    delete process.env.AGENT_LENS_RUNTIME
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('selects the Gemini runtime alone', async () => {
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace })
    try {
      const s = await statusOf(relay)
      assert.deepEqual(s.runtimes, ['gemini'])
      assert.equal(s.sessionCount, 1)
    } finally { relay.dispose() }
  })
})
