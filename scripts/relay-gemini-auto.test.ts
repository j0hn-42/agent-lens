/**
 * Relay + Gemini CLI runtime (#238): an unknown AGENT_LENS_RUNTIME falls back to 'auto', which
 * watches Gemini too. Own file: createRelay() runs once per process.
 */
import { fakeHome, makeWorkspaceWithGeminiSession, statusOf } from './relay-gemini-fixture'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'

describe('unknown AGENT_LENS_RUNTIME', () => {
  let workspace = ''
  before(() => {
    process.env.AGENT_LENS_RUNTIME = 'cursor'
    workspace = makeWorkspaceWithGeminiSession()
  })
  after(() => {
    delete process.env.AGENT_LENS_RUNTIME
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it("falls back to 'auto': several runtimes, Gemini among them", async () => {
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace })
    try {
      const { runtimes, sessionCount } = await statusOf(relay)
      assert.ok(runtimes.includes('gemini'))
      assert.ok(runtimes.length > 1)
      assert.ok(sessionCount >= 1)
    } finally { relay.dispose() }
  })
})
