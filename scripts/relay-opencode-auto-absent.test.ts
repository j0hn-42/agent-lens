/**
 * Relay in auto mode for someone who never installed OpenCode (#420): a Claude Code session alone, no
 * OpenCode data directory. The missing OpenCode database is the normal state there, not a problem: /status
 * says nothing about it (a user saw "OpenCode: database not found." while using Claude Code only).
 * Own file: createRelay() runs once per process.
 */
import { fakeHome, makeWorkspace, statusOf } from './relay-opencode-fixture'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const SESSION = '42042042-0420-4420-8420-420420420420'

async function waitFor(cond: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cond()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return cond()
}

describe('auto mode, no OpenCode data directory, a Claude Code session', () => {
  let workspace = ''
  before(() => {
    delete process.env.AGENT_LENS_RUNTIME
    delete process.env.OPENCODE_DB
    workspace = makeWorkspace()
    const projectDir = path.join(fakeHome, '.claude', 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), JSON.stringify({
      type: 'user', cwd: workspace, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Run the build' },
    }) + '\n')
  })
  after(() => { fs.rmSync(fakeHome, { recursive: true, force: true }) })

  it('publishes no OpenCode notice', async () => {
    assert.equal(fs.existsSync(path.join(fakeHome, '.local', 'share', 'opencode')), false)
    const { createRelay } = await import('./relay')
    const relay = await createRelay({ workspace })
    try {
      assert.ok(await waitFor(async () => (await statusOf(relay)).sessionCount >= 1), 'the Claude Code session is followed')
      const s = await statusOf(relay)
      assert.ok(s.runtimes.includes('claude') && s.runtimes.includes('opencode'), `auto mode watches both: ${s.runtimes}`)
      assert.equal((s as { runtimeProblems?: unknown }).runtimeProblems, undefined, 'no OpenCode in use: nothing to report')
    } finally { relay.dispose() }
  })
})
