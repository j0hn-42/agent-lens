/**
 * #138 : the module-level roots (transcript root, SessionWatcher) follow CLAUDE_CONFIG_DIR.
 * The variable is fixed before the dynamic imports, so a regression to os.homedir()/.claude fails here.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-cfgdir-'))
const configDir = path.join(fakeHome, 'second-account')
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.CLAUDE_CONFIG_DIR = configDir

const SESSION = '77777777-7777-4777-8777-777777777777'

describe('CLAUDE_CONFIG_DIR wiring', () => {
  let transcript = ''
  before(() => {
    const cwd = fs.realpathSync(process.cwd())
    const dir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(dir, { recursive: true })
    transcript = path.join(dir, `${SESSION}.jsonl`)
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } }) + '\n')
  })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('accepts a transcript of the second account and refuses one under ~/.claude', async () => {
    const { DEFAULT_TRANSCRIPT_ROOT, isAllowedTranscriptPath } = await import('../src/transcript-parser')
    assert.equal(DEFAULT_TRANSCRIPT_ROOT, path.join(configDir, 'projects'))
    assert.equal(isAllowedTranscriptPath(transcript), true)
    const other = path.join(fakeHome, '.claude', 'projects', 'p', 'x.jsonl')
    fs.mkdirSync(path.dirname(other), { recursive: true })
    fs.writeFileSync(other, '{}\n')
    assert.equal(isAllowedTranscriptPath(other), false)
  })

  it('SessionWatcher discovers the session stored in the second account', async () => {
    const vscodeShim = require('vscode') as { window: Record<string, unknown> }
    vscodeShim.window.setStatusBarMessage = () => ({ dispose() {} })
    const { SessionWatcher } = await import('../src/session-watcher')
    const watcher = new SessionWatcher()
    watcher.start()
    try {
      assert.ok(watcher.getActiveSessions().some(s => s.id === SESSION))
    } finally { watcher.dispose() }
  })
})
