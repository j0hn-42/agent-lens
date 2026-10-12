/**
 * Defensive reading of ~/.claude/settings.json for the hooks-configured flag (#30).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isAgentLensHook, settingsHaveAgentLensHooks, readSettingsFile, claudeSettingsPaths, isHooksConfigured, applyAgentLensHooks,
  migrateLegacyHookFiles, unreadableSettingsMessage, CONFIGURE_HOOKS_COMMAND_TITLE,
} from '../src/claude-settings'
import { SettingsUnreadableError } from '../src/settings-writer'
import { SETTINGS_FILE_MAX_BYTES } from '../src/constants'
import { SETTINGS_FILE_MAX_BYTES as SHARED_MAX_BYTES } from '../scripts/claude-hooks'

const ourHook = { hooks: [{ type: 'command', command: 'node /home/u/.claude/agent-lens/hook.js', timeout: 2 }] }
const otherHook = { hooks: [{ type: 'command', command: 'echo hi' }] }

describe('settingsHaveAgentLensHooks', () => {
  it('detects current command hooks, Windows paths included', () => {
    assert.equal(settingsHaveAgentLensHooks({ hooks: { PreToolUse: [otherHook, ourHook] } }), true)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [{ command: 'node C:\\Users\\me\\.claude\\agent-lens\\hook.js' }] }] } }), true)
  })
  it('does not count legacy agent-flow hooks (#175) nor user http hooks to 127.0.0.1 (#199)', () => {
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [{ command: 'node /h/.claude/agent-flow/hook.js' }] }] } }), false)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4000/hook' }] }] } }), false)
  })
  it('is false for other hooks and for hostile shapes (never throws)', () => {
    for (const v of [null, undefined, 42, 'x', [], {}, { hooks: null }, { hooks: 'x' }, { hooks: { A: 'x' } }, { hooks: { A: [null, 1, {}, { hooks: 'x' }, { hooks: [null, 5, { command: 7 }] }] } }, { hooks: { PreToolUse: [otherHook] } }]) {
      assert.equal(settingsHaveAgentLensHooks(v), false, JSON.stringify(v))
    }
    assert.equal(isAgentLensHook(undefined), false)
  })
})

describe('reading settings files', () => {
  let home: string
  before(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-settings-')) })
  after(() => fs.rmSync(home, { recursive: true, force: true }))

  const write = (rel: string, content: string) => {
    const p = path.join(home, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    return p
  }

  it('returns false when no settings exist', () => {
    assert.equal(isHooksConfigured(undefined, path.join(home, 'nowhere', '.claude')), false)
  })
  it('reads global settings, and ignores invalid JSON, directories and oversized files', () => {
    const settings = write('.claude/settings.json', '{ not json')
    assert.equal(readSettingsFile(settings), null)
    assert.equal(isHooksConfigured(undefined, path.join(home, '.claude')), false)

    fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [ourHook] } }))
    assert.equal(isHooksConfigured(undefined, path.join(home, '.claude')), true)

    assert.equal(readSettingsFile(settings, 10), null) // over the size cap
    assert.equal(readSettingsFile(path.dirname(settings)), null) // a directory
  })
  it('also checks the workspace settings.local.json', () => {
    const emptyHome = path.join(home, 'h2', '.claude')
    fs.mkdirSync(emptyHome, { recursive: true })
    const ws = path.join(home, 'ws')
    write('ws/.claude/settings.local.json', JSON.stringify({ hooks: { Stop: [ourHook] } }))
    assert.equal(isHooksConfigured(ws, emptyHome), true)
    assert.equal(isHooksConfigured(undefined, emptyHome), false)
    assert.deepEqual(claudeSettingsPaths(ws, emptyHome), [
      path.join(emptyHome, 'settings.json'),
      path.join(ws, '.claude', 'settings.local.json'),
    ])
  })
})

describe('CLAUDE_CONFIG_DIR (second account)', () => {
  it('reads the hooks flag from the injected config dir, not from ~/.claude', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-second-'))
    try {
      const second = path.join(root, 'acct2')
      fs.mkdirSync(second)
      fs.writeFileSync(path.join(second, 'settings.json'), JSON.stringify({ hooks: { Stop: [ourHook] } }))
      assert.equal(isHooksConfigured(undefined, second), true)
      assert.equal(isHooksConfigured(undefined, path.join(root, 'other')), false)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})

describe('applyAgentLensHooks', () => {
  const fresh = { hooks: [{ type: 'command', command: 'node /h/.claude/agent-lens/hook.js', timeout: 2 }] }
  it('keeps the other hooks and other settings, and replaces older Agent Lens entries', () => {
    const settings: Record<string, unknown> = {
      model: 'opus',
      hooks: { Stop: [otherHook, ourHook], Custom: 'not-an-array' },
    }
    applyAgentLensHooks(settings, { Stop: [fresh], PreToolUse: [fresh] })
    const hooks = settings.hooks as Record<string, unknown[]>
    assert.equal(settings.model, 'opus')
    assert.deepEqual(hooks.Stop, [otherHook, fresh])
    assert.deepEqual(hooks.PreToolUse, [fresh])
    assert.equal(hooks.Custom, 'not-an-array')
  })
  it('tolerates a missing or malformed hooks section', () => {
    for (const hooks of [undefined, null, 'x', 4]) {
      const settings: Record<string, unknown> = { hooks }
      applyAgentLensHooks(settings, { Stop: [fresh] })
      assert.deepEqual(settings.hooks, { Stop: [fresh] })
    }
  })
})

describe('migrateLegacyHookFiles (#175, #199)', () => {
  const fresh = { hooks: [{ type: 'command', command: '"node" "/h/.claude/agent-lens/hook.js"', timeout: 2 }] }
  const legacy = { hooks: [{ type: 'command', command: 'node /h/.claude/agent-flow/hook.js' }] }
  const userHttp = { hooks: [{ type: 'http', url: 'http://127.0.0.1:8080/xyz' }] }

  it('legacy-only settings: not configured, then migrated to Agent Lens and configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-migrate-'))
    try {
      const file = path.join(dir, 'settings.json')
      fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [legacy, otherHook] } }))
      assert.equal(isHooksConfigured(undefined, dir), false)
      assert.deepEqual(migrateLegacyHookFiles([file, path.join(dir, 'missing.json')], fresh), [file])
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).hooks.Stop, [otherHook, fresh])
      assert.equal(isHooksConfigured(undefined, dir), true)
      assert.equal(fs.existsSync(path.join(dir, 'missing.json')), false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('never modifies a user http hook to 127.0.0.1, and reports unreadable files without touching them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-migrate-'))
    try {
      const file = path.join(dir, 'settings.json')
      const content = JSON.stringify({ hooks: { PreToolUse: [userHttp] } })
      fs.writeFileSync(file, content)
      const broken = path.join(dir, 'broken.json')
      fs.writeFileSync(broken, '{ nope')
      const errors: string[] = []
      assert.deepEqual(migrateLegacyHookFiles([file, broken], fresh, f => errors.push(f)), [])
      assert.equal(fs.readFileSync(file, 'utf-8'), content)
      assert.equal(fs.readFileSync(broken, 'utf-8'), '{ nope')
      assert.deepEqual(errors, [broken])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('unreadableSettingsMessage (#175)', () => {
  it('uses the real reason and the exact command title', () => {
    const msg = unreadableSettingsMessage(new SettingsUnreadableError('/x/settings.json', 'file too large'))
    assert.match(msg, /file too large/)
    assert.doesNotMatch(msg, /not valid JSON/)
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'))
    const cmd = pkg.contributes.commands.find((c: { command: string }) => c.command === 'agentVisualizer.configureHooks')
    assert.equal(CONFIGURE_HOOKS_COMMAND_TITLE, `${cmd.category}: ${cmd.title}`)
    assert.ok(msg.includes(`"${CONFIGURE_HOOKS_COMMAND_TITLE}"`))
  })
  it('the shared settings size cap matches the extension constant', () => {
    assert.equal(SHARED_MAX_BYTES, SETTINGS_FILE_MAX_BYTES)
  })
})
