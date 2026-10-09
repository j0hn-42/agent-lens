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

describe('setup.js mode, symlink and outdated hook.js', () => {
  const hookPath = path.join(fakeHome, '.claude', 'agent-lens', 'hook.js')
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fakeHome, 'mode-')) })

  it('keeps the 0600 mode of settings.json', { skip: process.platform === 'win32' }, () => {
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, '{"env":{"K":"secret"}}', { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    setup.configureHooks({ settingsPath: file, hookCommand: HOOK })
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })

  it('writes through a symlinked settings.json', { skip: process.platform === 'win32' }, () => {
    const real = path.join(dir, 'dotfiles.json')
    const link = path.join(dir, 'settings.json')
    fs.writeFileSync(real, '{"model":"opus"}')
    fs.symlinkSync(real, link)
    setup.configureHooks({ settingsPath: link, hookCommand: HOOK })
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    assert.ok(JSON.parse(fs.readFileSync(real, 'utf-8')).hooks.Stop)
  })

  it('redeploys an outdated hook.js for an already configured user', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
    setup.ensureSetup()
    assert.equal(setup.isAlreadySetup(), true)
    fs.writeFileSync(hookPath, '// hook.js v3')
    assert.equal(setup.isAlreadySetup(), false, 'a stale hook.js is not "set up"')
    setup.ensureSetup()
    assert.notEqual(fs.readFileSync(hookPath, 'utf8'), '// hook.js v3')
    assert.equal(setup.isAlreadySetup(), true)
    fs.rmSync(path.join(fakeHome, '.claude', 'settings.json'))
  })
})

describe('hook detection parity: setup.js, uninstall.js, claude-settings.ts (#199, #217)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const uninstall = require('../extension/scripts/uninstall.js') as { isAgentLensHook: (e: unknown) => boolean }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ext = require('../extension/src/claude-settings') as { isAgentLensHook: (e: unknown) => boolean }
  const setupDetect = (setup as unknown as { isAgentLensHook: (e: unknown) => boolean }).isAgentLensHook

  const cases: Array<[string, unknown, boolean]> = [
    ['POSIX command', { type: 'command', command: '"/usr/bin/node" "/home/x/.claude/agent-lens/hook.js"' }, true],
    ['Windows command', { type: 'command', command: '"C:\\node.exe" "C:\\Users\\x\\.claude\\agent-lens\\hook.js"' }, true],
    ['legacy agent-flow command', { type: 'command', command: 'node /home/x/.claude/agent-flow/hook.js' }, true],
    ['legacy agent-flow Windows command', { type: 'command', command: 'node C:\\Users\\x\\.claude\\agent-flow\\hook.js' }, true],
    ['user http hook on 127.0.0.1', { type: 'http', url: 'http://127.0.0.1:8080/xyz' }, false],
    ['user command', { type: 'command', command: 'echo hi' }, false],
  ]
  for (const [label, hook, expected] of cases) {
    it(`${label}: ${expected ? 'recognised' : 'ignored'} by all three`, () => {
      const entry = { hooks: [hook] }
      assert.equal(setupDetect(entry), expected, 'setup.js')
      assert.equal(uninstall.isAgentLensHook(entry), expected, 'uninstall.js')
      assert.equal(ext.isAgentLensHook(entry), expected, 'claude-settings.ts')
    })
  }
})

describe('setup.js with user http hooks and legacy agent-flow hooks (#175, #199)', () => {
  let file: string
  beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(fakeHome, 'legacy-')), 'settings.json') })
  const userHttp = { type: 'http', url: 'http://127.0.0.1:8080/audit' }
  const userCmd = { type: 'command', command: 'echo mine' }
  const legacy = { type: 'command', command: 'node /h/.claude/agent-flow/hook.js' }

  it('keeps a user http hook to 127.0.0.1 and its sibling hooks on --force', () => {
    fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [userHttp, userCmd] }] } }))
    setup.configureHooks({ settingsPath: file, hookCommand: HOOK })
    const stop = JSON.parse(fs.readFileSync(file, 'utf-8')).hooks.Stop
    assert.deepEqual(stop[0], { hooks: [userHttp, userCmd] })
    assert.equal(stop[1].hooks[0].command, HOOK)
    assert.equal(stop.length, 2)
  })

  it('replaces legacy agent-flow hooks and keeps the user hooks of the same entry', () => {
    fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [legacy, userCmd] }], Notification: [{ hooks: [legacy] }] } }))
    setup.configureHooks({ settingsPath: file, hookCommand: HOOK })
    const hooks = JSON.parse(fs.readFileSync(file, 'utf-8')).hooks
    assert.deepEqual(hooks.Stop[0], { hooks: [userCmd] })
    assert.equal(hooks.Stop.length, 2)
    assert.equal(hooks.Notification.length, 1)
    assert.equal(hooks.Notification[0].hooks[0].command, HOOK)
    assert.doesNotMatch(JSON.stringify(hooks), /agent-flow/)
  })

  it('a settings.json with only legacy hooks is not "already set up", and ensureSetup migrates it', () => {
    delete process.env.CLAUDE_CONFIG_DIR
    const settings = path.join(fakeHome, '.claude', 'settings.json')
    fs.rmSync(path.join(fakeHome, '.claude'), { recursive: true, force: true })
    setup.ensureSetup() // installs the current hook.js
    fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [legacy] }] } }))
    assert.equal(setup.isAlreadySetup(), false)
    setup.ensureSetup()
    assert.equal(setup.isAlreadySetup(), true)
    assert.doesNotMatch(fs.readFileSync(settings, 'utf-8'), /agent-flow/)
    fs.rmSync(settings)
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
