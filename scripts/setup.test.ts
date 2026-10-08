/**
 * Standalone installer: never overwrite an unreadable settings.json (#137) and honour CLAUDE_CONFIG_DIR (#138).
 * HOME is faked before loading setup.js so nothing touches the real ~/.claude.
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'al-setup-'))
process.env.HOME = fakeHome
process.env.USERPROFILE = fakeHome
delete process.env.CLAUDE_CONFIG_DIR

// eslint-disable-next-line @typescript-eslint/no-require-imports
const setup = require('./setup.js') as {
  ensureSetup: () => void
  isAlreadySetup: () => boolean
  configureHooks: (o?: { settingsPath?: string; hookCommand?: string }) => void
  claudeConfigDir: (env?: NodeJS.ProcessEnv, home?: string) => string
  SettingsUnreadableError: new (...a: never[]) => Error
}

const HOOK = '"node" "/h/.claude/agent-lens/hook.js"'

describe('setup.js configureHooks', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fakeHome, 'case-'))
    file = path.join(dir, 'settings.json')
  })

  for (const [label, content] of [
    ['a comment', '{\n // c\n "env": {"A":"1"}\n}'],
    ['an empty file', ''],
    ['a truncated file', '{ "hooks": { "Stop": [ '],
  ] as const) {
    it(`refuses and leaves a file with ${label} untouched`, () => {
      fs.writeFileSync(file, content)
      assert.throws(() => setup.configureHooks({ settingsPath: file, hookCommand: HOOK }), (e: Error) => e instanceof setup.SettingsUnreadableError)
      assert.equal(fs.readFileSync(file, 'utf-8'), content)
      assert.deepEqual(fs.readdirSync(dir), ['settings.json'])
    })
  }

  it('merges into a valid file that already has other hooks, with a .bak of the original', () => {
    const original = JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } })
    fs.writeFileSync(file, original)
    setup.configureHooks({ settingsPath: file, hookCommand: HOOK })
    const after = JSON.parse(fs.readFileSync(file, 'utf-8'))
    assert.equal(after.model, 'opus')
    assert.equal(after.hooks.Stop.length, 2)
    assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo mine')
    assert.equal(after.hooks.PreToolUse.length, 1)
    assert.equal(fs.readFileSync(`${file}.bak`, 'utf-8'), original)
    assert.deepEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.bak'])

    // idempotent: re-running does not duplicate our hooks
    setup.configureHooks({ settingsPath: file, hookCommand: HOOK })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).hooks.Stop.length, 2)
  })
})

describe('setup.js with CLAUDE_CONFIG_DIR', () => {
  after(() => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('resolves the config dir from the environment', () => {
    assert.equal(setup.claudeConfigDir({}, '/h'), path.join('/h', '.claude'))
    assert.equal(setup.claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/.acct' }, '/h'), path.join('/h', '.acct'))
  })

  it('ensureSetup writes the second account settings.json, not ~/.claude, and never throws on an unreadable one', () => {
    const second = path.join(fakeHome, 'second-account')
    fs.mkdirSync(second)
    process.env.CLAUDE_CONFIG_DIR = second

    fs.writeFileSync(path.join(second, 'settings.json'), '{ nope')
    setup.ensureSetup()
    assert.equal(fs.readFileSync(path.join(second, 'settings.json'), 'utf-8'), '{ nope')
    assert.equal(setup.isAlreadySetup(), false)

    fs.rmSync(path.join(second, 'settings.json'))
    setup.ensureSetup()
    const written = JSON.parse(fs.readFileSync(path.join(second, 'settings.json'), 'utf-8'))
    assert.ok(written.hooks.SessionStart)
    assert.equal(fs.existsSync(path.join(fakeHome, '.claude', 'settings.json')), false)
    assert.equal(setup.isAlreadySetup(), true)
  })
})
