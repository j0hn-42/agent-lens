/**
 * Defensive reading of ~/.claude/settings.json for the hooks-configured flag (#30).
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  isAgentLensHook, settingsHaveAgentLensHooks, readSettingsFile, claudeSettingsPaths, isHooksConfigured,
} from '../src/claude-settings'

const ourHook = { hooks: [{ type: 'command', command: 'node /home/u/.claude/agent-lens/hook.js', timeout: 2 }] }
const otherHook = { hooks: [{ type: 'command', command: 'echo hi' }] }

describe('settingsHaveAgentLensHooks', () => {
  it('detects command hooks, legacy markers, legacy http hooks and Windows paths', () => {
    assert.equal(settingsHaveAgentLensHooks({ hooks: { PreToolUse: [otherHook, ourHook] } }), true)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [{ command: 'node /h/.claude/agent-flow/hook.js' }] }] } }), true)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:4000/hook' }] }] } }), true)
    assert.equal(settingsHaveAgentLensHooks({ hooks: { Stop: [{ hooks: [{ command: 'node C:\\Users\\me\\.claude\\agent-lens\\hook.js' }] }] } }), true)
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
