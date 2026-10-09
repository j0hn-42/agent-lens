/**
 * extension/scripts/uninstall.js run in a temporary HOME (#217): never touches the real ~/.claude.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const UNINSTALL = path.join(__dirname, '..', 'scripts', 'uninstall.js')

const winHook = { type: 'command', command: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\x\\.claude\\agent-lens\\hook.js"', timeout: 2 }
const posixHook = { type: 'command', command: '"/usr/bin/node" "/home/x/.claude/agent-lens/hook.js"', timeout: 2 }
const legacyHook = { type: 'command', command: 'node /home/x/.claude/agent-flow/hook.js' }
const userHttp = { type: 'http', url: 'http://127.0.0.1:8080/audit' }
const userCmd = { type: 'command', command: 'echo mine' }

describe('uninstall.js', () => {
  let home: string
  let second: string
  let third: string
  let workspace: string
  const unreadable = '{ "hooks": { "Stop": [ '
  const read = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8'))
  const write = (p: string, v: unknown) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  }

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'al-uninstall-'))
    second = path.join(home, 'acct2')
    third = path.join(home, 'acct3')
    workspace = path.join(home, 'ws')
    const lensDir = path.join(home, '.claude', 'agent-lens')

    // Default account: Windows-format hook next to a user hook in the same entry + a user http hook.
    write(path.join(home, '.claude', 'settings.json'), {
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [userCmd, winHook] }, { hooks: [userHttp] }],
        PreToolUse: [{ hooks: [winHook] }],
        Notification: [{ hooks: [legacyHook] }],
      },
    })
    // Account from CLAUDE_CONFIG_DIR: only our hooks -> file emptied and removed.
    write(path.join(second, 'settings.json'), { hooks: { Stop: [{ hooks: [posixHook] }] } })
    // Account recorded at write time (CLAUDE_CONFIG_DIR not set when uninstalling).
    write(path.join(third, 'settings.json'), { env: { A: '1' }, hooks: { Stop: [{ hooks: [posixHook] }] } })
    // Unreadable account settings: left byte-identical.
    write(path.join(home, 'broken', 'settings.json'), unreadable)
    write(path.join(workspace, '.claude', 'settings.local.json'), { hooks: { Stop: [{ hooks: [posixHook] }], PreToolUse: [{ hooks: [userCmd] }] } })
    write(path.join(lensDir, 'workspaces.json'), [workspace])
    write(path.join(lensDir, 'settings-paths.txt'), [path.join(third, 'settings.json'), path.join(home, 'broken', 'settings.json')].join('\n') + '\n')
    write(path.join(lensDir, 'hook.js'), '// hook')

    const res = spawnSync(process.execPath, [UNINSTALL], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: second },
      encoding: 'utf-8',
    })
    assert.equal(res.status, 0, res.stderr)
  })
  after(() => fs.rmSync(home, { recursive: true, force: true }))

  it('removes Windows-format hooks and keeps the user hooks of the same entry', () => {
    const s = read(path.join(home, '.claude', 'settings.json'))
    assert.equal(s.model, 'opus')
    assert.deepEqual(s.hooks, { Stop: [{ hooks: [userCmd] }, { hooks: [userHttp] }] })
  })

  it('cleans the CLAUDE_CONFIG_DIR account and recorded accounts', () => {
    assert.equal(fs.existsSync(path.join(second, 'settings.json')), false)
    assert.deepEqual(read(path.join(third, 'settings.json')), { env: { A: '1' } })
  })

  it('cleans workspace settings.local.json files', () => {
    assert.deepEqual(read(path.join(workspace, '.claude', 'settings.local.json')), { hooks: { PreToolUse: [{ hooks: [userCmd] }] } })
  })

  it('leaves an unreadable settings file untouched', () => {
    assert.equal(fs.readFileSync(path.join(home, 'broken', 'settings.json'), 'utf-8'), unreadable)
    assert.deepEqual(fs.readdirSync(path.join(home, 'broken')), ['settings.json'])
  })

  it('deletes the agent-lens directory', () => {
    assert.equal(fs.existsSync(path.join(home, '.claude', 'agent-lens')), false)
  })
})
