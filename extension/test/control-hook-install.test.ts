/**
 * Installing and removing the optional PermissionRequest hook (#240, PR 3): a separate command, a separate script,
 * its own 60 s timeout; the observation hooks are never changed by it, and it survives their reconfiguration.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-ctlinstall-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

const settingsFile = path.join(fakeHome, '.claude', 'settings.json')
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number; type: string }> }>> }

type Cfg = typeof import('../src/hooks-config')
let cfg: Cfg

describe('control hook install', () => {
  before(async () => { cfg = await import('../src/hooks-config') })
  after(() => fs.rmSync(fakeHome, { recursive: true, force: true }))

  it('is not installed on a fresh machine', () => {
    assert.equal(cfg.isControlHookInstalled(), false)
  })

  it('writes one PermissionRequest hook with a 60 s timeout, and its own owner-executable script', async () => {
    await cfg.installControlHook()
    const entries = readSettings().hooks?.PermissionRequest ?? []
    assert.equal(entries.length, 1)
    const hook = entries[0].hooks[0]
    assert.equal(hook.type, 'command')
    assert.equal(hook.timeout, 60)
    assert.match(hook.command.replace(/\\/g, '/'), /agent-lens\/permission-hook\.js"$/)
    const script = path.join(fakeHome, '.claude', 'agent-lens', 'permission-hook.js')
    assert.ok(fs.existsSync(script))
    if (process.platform !== 'win32') assert.ok((fs.statSync(script).mode & 0o100) !== 0)
    assert.equal(cfg.isControlHookInstalled(), true)
    assert.equal(readSettings().hooks?.PreToolUse, undefined, 'the observation hooks are not touched')
  })

  it('is idempotent', async () => {
    await cfg.installControlHook()
    assert.equal(readSettings().hooks?.PermissionRequest?.length, 1)
  })

  it('survives the observation hooks being (re)configured, and leaves the user hooks alone', async () => {
    const s = readSettings() as Record<string, unknown> & { hooks: Record<string, unknown[]> }
    s.hooks.PermissionRequest = [{ hooks: [{ type: 'command', command: 'echo mine' }] }, ...s.hooks.PermissionRequest]
    fs.writeFileSync(settingsFile, JSON.stringify(s))
    await cfg.configureClaudeHooks()
    const after = readSettings().hooks ?? {}
    assert.equal(after.PermissionRequest.length, 2)
    assert.ok(after.PreToolUse, 'the observation hooks are in place')
    assert.equal(cfg.isControlHookInstalled(), true)
  })

  it('removal takes out only the control hook', async () => {
    await cfg.removeControlHook()
    const hooks = readSettings().hooks ?? {}
    assert.deepEqual(hooks.PermissionRequest?.map(e => e.hooks[0].command), ['echo mine'])
    assert.ok(hooks.PreToolUse)
    assert.equal(cfg.isControlHookInstalled(), false)
  })
})
