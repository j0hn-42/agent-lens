/**
 * Shared hook detection / settings writing (extension/scripts/claude-hooks.js): #175, #199, #217.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  hookKind, isAgentLensHook, settingsHaveAgentLensHooks, settingsHaveLegacyHooks,
  removeAgentLensHooks, applyAgentLensHooks, migrateLegacyHooks,
  writeFileAtomic, updateSettings, recordSettingsPath, readSettingsPaths,
} from '../scripts/claude-hooks'

const ours = { type: 'command', command: '"node" "/h/.claude/agent-lens/hook.js"', timeout: 2 }
const oursWin = { type: 'command', command: '"C:\\node.exe" "C:\\Users\\x\\.claude\\agent-lens\\hook.js"' }
const legacy = { type: 'command', command: 'node /h/.claude/agent-flow/hook.js' }
const userHttp = { type: 'http', url: 'http://127.0.0.1:8080/audit' }
const userCmd = { type: 'command', command: 'echo mine' }
const fresh = { hooks: [ours] }

describe('hookKind', () => {
  it('classifies by command marker only, Windows paths included', () => {
    assert.equal(hookKind(ours), 'current')
    assert.equal(hookKind(oursWin), 'current')
    assert.equal(hookKind(legacy), 'legacy')
    assert.equal(hookKind({ command: 'node C:\\h\\.claude\\agent-flow\\hook.js' }), 'legacy')
    assert.equal(hookKind(userHttp), null, 'a user http hook on 127.0.0.1 is not ours (#199)')
    assert.equal(hookKind({ type: 'http', url: 'http://127.0.0.1:4000/' }), null)
    for (const v of [userCmd, null, undefined, 7, 'x', {}, { command: 7 }]) assert.equal(hookKind(v), null)
  })
})

describe('configured vs legacy (#175)', () => {
  it('only current hooks count as configured; legacy ones are still recognised for replacement', () => {
    const legacyOnly = { hooks: { Stop: [{ hooks: [legacy] }] } }
    assert.equal(settingsHaveAgentLensHooks(legacyOnly), false)
    assert.equal(settingsHaveLegacyHooks(legacyOnly), true)
    assert.equal(isAgentLensHook({ hooks: [legacy] }), true)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [oursWin] }] } }), true)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [userHttp] }] } }), false)
  })
})

describe('removeAgentLensHooks (#199)', () => {
  it('keeps sibling user hooks in the same entry and drops only emptied entries/events', () => {
    const settings: Record<string, unknown> = {
      model: 'opus',
      hooks: {
        Stop: [{ matcher: '', hooks: [userHttp, ours] }, { hooks: [legacy] }],
        PreToolUse: [{ hooks: [ours] }],
        Custom: 'not-an-array',
      },
    }
    assert.equal(removeAgentLensHooks(settings), true)
    assert.deepEqual(settings.hooks, { Stop: [{ matcher: '', hooks: [userHttp] }], Custom: 'not-an-array' })
    assert.equal(removeAgentLensHooks(settings), false)
  })
  it('deletes an emptied hooks section', () => {
    const settings: Record<string, unknown> = { hooks: { Stop: [{ hooks: [ours] }] } }
    removeAgentLensHooks(settings)
    assert.deepEqual(settings, {})
  })
})

describe('applyAgentLensHooks', () => {
  it('replaces current and legacy hooks, keeps user http hooks and siblings', () => {
    const settings: Record<string, unknown> = {
      hooks: { Stop: [{ hooks: [userCmd, legacy] }, { hooks: [userHttp] }], Notification: [{ hooks: [legacy] }] },
    }
    applyAgentLensHooks(settings, { Stop: [fresh], PreToolUse: [fresh] })
    assert.deepEqual(settings.hooks, {
      Stop: [{ hooks: [userCmd] }, { hooks: [userHttp] }, fresh],
      PreToolUse: [fresh],
    })
  })
  it('tolerates a missing or malformed hooks section', () => {
    for (const hooks of [undefined, null, 'x', 4, []]) {
      const settings: Record<string, unknown> = { hooks }
      applyAgentLensHooks(settings, { Stop: [fresh] })
      assert.deepEqual(settings.hooks, { Stop: [fresh] })
    }
  })
})

describe('migrateLegacyHooks (#175, #199)', () => {
  it('rewrites agent-flow hooks to Agent Lens, never touches a user http hook', () => {
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [{ hooks: [legacy, userCmd] }],
        PreToolUse: [{ hooks: [userHttp] }],
      },
    }
    assert.equal(migrateLegacyHooks(settings, fresh), true)
    assert.deepEqual(settings.hooks, { Stop: [{ hooks: [userCmd] }, fresh], PreToolUse: [{ hooks: [userHttp] }] })
    assert.equal(settingsHaveAgentLensHooks(settings), true)
    assert.equal(migrateLegacyHooks(settings, fresh), false, 'idempotent')
  })
  it('leaves settings with only a user http hook to 127.0.0.1 unchanged', () => {
    const settings = { hooks: { PostToolUse: [{ hooks: [{ ...userHttp }] }] } }
    const before = JSON.stringify(settings)
    assert.equal(migrateLegacyHooks(settings, fresh), false)
    assert.equal(JSON.stringify(settings), before)
  })
})

describe('writeFileAtomic / updateSettings', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-hooks-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes a new file 0600, keeps the mode of an existing one, leaves no temp file', { skip: process.platform === 'win32' }, () => {
    const f = path.join(dir, 'sub', 'a.json')
    writeFileAtomic(f, 'one')
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    fs.chmodSync(f, 0o640)
    writeFileAtomic(f, 'two')
    assert.equal(fs.readFileSync(f, 'utf-8'), 'two')
    assert.equal(fs.statSync(f).mode & 0o777, 0o640)
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['a.json'])
  })

  it('deleteIfEmpty removes a settings file emptied by the mutation (after a .bak)', () => {
    const f = path.join(dir, 'settings.json')
    fs.writeFileSync(f, JSON.stringify({ hooks: { Stop: [fresh] } }))
    assert.equal(updateSettings(f, removeAgentLensHooks, { deleteIfEmpty: true }), true)
    assert.equal(fs.existsSync(f), false)
    assert.ok(fs.existsSync(`${f}.bak`))
  })

  it('does not create a missing file for a no-op mutation', () => {
    const f = path.join(dir, 'missing.json')
    assert.equal(updateSettings(f, removeAgentLensHooks), false)
    assert.equal(fs.existsSync(f), false)
  })

  it('records each settings path once', () => {
    recordSettingsPath(dir, '/a/settings.json')
    recordSettingsPath(dir, '/a/settings.json')
    recordSettingsPath(dir, '/b/settings.json')
    assert.deepEqual(readSettingsPaths(dir), [path.resolve('/a/settings.json'), path.resolve('/b/settings.json')])
    assert.deepEqual(readSettingsPaths(path.join(dir, 'none')), [])
  })
})
