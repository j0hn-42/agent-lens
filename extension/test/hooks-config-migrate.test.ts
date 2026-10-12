/**
 * migrateLegacyHooks() of hooks-config: the activation step that rewrites the user's own settings files
 * (global settings.json under CLAUDE_CONFIG_DIR and the workspace's settings.local.json), #175, #199, #192.
 * The per-file mechanics are in claude-settings.test.ts; here the wiring is checked on a fake config dir.
 */
import './helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'al-migrate-cfg-'))
const fakeHome = path.join(root, 'home')
const configDir = path.join(root, 'claude-config')
const workspace = path.join(root, 'ws')
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
process.env.CLAUDE_CONFIG_DIR = configDir

const globalFile = path.join(configDir, 'settings.json')
const localFile = path.join(workspace, '.claude', 'settings.local.json')
const legacy = { hooks: [{ type: 'command', command: 'node /h/.claude/agent-flow/hook.js' }] }
const userHook = { hooks: [{ type: 'command', command: 'echo mine', timeout: 9 }] }
const userHttp = { hooks: [{ type: 'http', url: 'http://127.0.0.1:8080/xyz' }] }

const write = (file: string, content: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as { model?: string; hooks: Record<string, unknown[]> }

type Cfg = typeof import('../src/hooks-config')
let cfg: Cfg

describe('hooks-config migrateLegacyHooks (#192)', () => {
  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const shim = require('../../scripts/vscode-shim.js') as { workspace: { workspaceFolders: unknown } }
    shim.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }]
    cfg = await import('../src/hooks-config')
    // the caller writes the hook script before the migration (see the doc of migrateLegacyHooks)
    ;(await import('../src/discovery')).ensureHookScript()
  })
  after(() => fs.rmSync(root, { recursive: true, force: true }))

  it('migrates the legacy hook in both files with the default timeout, keeps every other entry and key', () => {
    write(globalFile, { model: 'opus', hooks: { Stop: [legacy, userHook], PreToolUse: [userHttp], Notification: [userHook] } })
    write(localFile, { hooks: { SessionStart: [legacy] } })

    cfg.migrateLegacyHooks()

    const global = read(globalFile)
    assert.equal(global.model, 'opus')
    const stop = global.hooks.Stop as Array<{ hooks: Array<{ command: string; timeout?: number }> }>
    assert.equal(stop.length, 2)
    assert.deepEqual(stop[0], userHook, 'the user hook keeps its place and its own timeout')
    const migrated = stop[1].hooks[0]
    assert.match(migrated.command.replace(/\\/g, '/'), /agent-lens\/hook\.js"$/)
    assert.equal(migrated.timeout, 2, 'default hook timeout (HOOK_TIMEOUT_S)')
    assert.deepEqual(global.hooks.PreToolUse, [userHttp], 'a user http hook is never rewritten')
    assert.deepEqual(global.hooks.Notification, [userHook], 'events without a legacy hook are untouched')

    const local = read(localFile)
    assert.equal(local.hooks.SessionStart.length, 1)
    assert.match(JSON.stringify(local.hooks.SessionStart), /agent-lens/)
    assert.doesNotMatch(JSON.stringify(local), /agent-flow/)
  })

  it('records the workspace in the manifest for the uninstaller', () => {
    const manifest = path.join(fakeHome, '.claude', 'agent-lens', 'workspaces.json')
    const workspaces = JSON.parse(fs.readFileSync(manifest, 'utf8')) as string[]
    assert.ok(workspaces.some(w => w.endsWith(`${path.sep}ws`)))
  })

  it('is idempotent: a second run changes nothing', () => {
    const snapshot = [fs.readFileSync(globalFile, 'utf8'), fs.readFileSync(localFile, 'utf8')]
    cfg.migrateLegacyHooks()
    assert.deepEqual([fs.readFileSync(globalFile, 'utf8'), fs.readFileSync(localFile, 'utf8')], snapshot)
  })

  it('leaves an unreadable settings file byte for byte, and still migrates the other one', () => {
    write(globalFile, '{ not json')
    write(localFile, { hooks: { Stop: [legacy] } })
    cfg.migrateLegacyHooks()
    assert.equal(fs.readFileSync(globalFile, 'utf8'), '{ not json')
    assert.match(JSON.stringify(read(localFile)), /agent-lens/)
  })

  it('does not create a missing settings file', () => {
    fs.rmSync(globalFile)
    fs.rmSync(localFile)
    cfg.migrateLegacyHooks()
    assert.equal(fs.existsSync(globalFile), false)
    assert.equal(fs.existsSync(localFile), false)
  })
})
