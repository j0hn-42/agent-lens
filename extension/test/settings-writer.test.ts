/**
 * Never overwrite an unreadable settings.json (#137).
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readSettingsStrict, updateSettings, SettingsUnreadableError } from '../src/settings-writer'

describe('updateSettings', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-writer-'))
    file = path.join(dir, 'settings.json')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const addHook = (s: Record<string, unknown>) => { s.hooks = { Stop: [{ hooks: [{ command: 'x' }] }] } }

  for (const [label, content] of [
    ['a comment', '{\n  // my model\n  "model": "opus"\n}'],
    ['a trailing comma', '{ "model": "opus", }'],
    ['an empty file', ''],
    ['a whitespace-only file', '  \n'],
    ['a truncated file', '{ "permissions": { "allow": ["Bash(ls'],
    ['a non-object JSON', '[1,2]'],
  ] as const) {
    it(`refuses and leaves the file byte-identical when it contains ${label}`, () => {
      fs.writeFileSync(file, content)
      assert.throws(() => updateSettings(file, addHook), SettingsUnreadableError)
      assert.equal(fs.readFileSync(file, 'utf-8'), content)
      assert.equal(fs.existsSync(`${file}.bak`), false)
      assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
    })
  }

  it('refuses a directory in place of the file', () => {
    fs.mkdirSync(file)
    assert.throws(() => updateSettings(file, addHook), SettingsUnreadableError)
  })

  it('creates the file (and its folder) when missing, without a backup', () => {
    const nested = path.join(dir, 'acct', 'settings.json')
    assert.equal(updateSettings(nested, addHook), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(nested, 'utf-8')).hooks.Stop.length, 1)
    assert.equal(fs.existsSync(`${nested}.bak`), false)
  })

  it('keeps other settings and other hooks, backs up the original once, leaves no tmp file', () => {
    const original = JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      env: { A: '1' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }, null, 2)
    fs.writeFileSync(file, original)

    const addOurs = (s: Record<string, unknown>) => {
      const hooks = s.hooks as Record<string, unknown[]>
      hooks.Stop = [...hooks.Stop, { hooks: [{ command: 'agent-lens/hook.js' }] }]
    }
    assert.equal(updateSettings(file, addOurs), true)
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'))
    assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] })
    assert.deepEqual(after.env, { A: '1' })
    assert.equal(after.hooks.Stop.length, 2)
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf-8'), original)

    // A second modification must not replace the backup of the original.
    assert.equal(updateSettings(file, s => { s.model = 'opus' }), true)
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf-8'), original)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.bak'])
  })

  it('does not rewrite the file when nothing changes', () => {
    fs.writeFileSync(file, '{"model":"opus"}')
    assert.equal(updateSettings(file, () => {}), false)
    assert.equal(fs.readFileSync(file, 'utf-8'), '{"model":"opus"}')
    assert.equal(fs.existsSync(`${file}.bak`), false)
  })
})

describe('updateSettings: mode and symlink', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-writer-mode-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
  const add = (s: Record<string, unknown>) => { s.hooks = { Stop: [] } }

  it('keeps the 0600 mode of the original file', { skip: process.platform === 'win32' }, () => {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, '{"env":{"K":"secret"}}', { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    updateSettings(file, add)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it('writes through a symlink instead of replacing it', { skip: process.platform === 'win32' }, () => {
    const real = path.join(dir, 'dotfiles.json')
    const link = path.join(dir, 'settings.json')
    fs.writeFileSync(real, '{"model":"opus"}')
    fs.symlinkSync(real, link)
    updateSettings(link, add)
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link')
    assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf-8')), { model: 'opus', hooks: { Stop: [] } })
  })
})

describe('readSettingsStrict', () => {
  it('returns null for a missing file', () => {
    assert.equal(readSettingsStrict(path.join(os.tmpdir(), 'al-no-such-dir', 'settings.json')), null)
  })
})
