// #335: command line of the tray driver, and SIGTERM on the driver process stops the relay it started.
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { localeFromEnv, parseCliArgs } from './cli'

const CLI = path.resolve(__dirname, 'cli.ts')
const FAKE_RELAY = path.resolve(__dirname, '../test/fake-relay.mjs')
const FAKE_TRAY = path.resolve(__dirname, '../test/fake-tray-binary.mjs')

describe('parseCliArgs', () => {
  it('needs a tray binary, from the option or AGENT_LENS_TRAY_BIN', () => {
    assert.equal(parseCliArgs([], {}).ok, false)
    assert.deepEqual(parseCliArgs(['--tray-bin', '/x/tray'], {}), { ok: true, trayBin: '/x/tray', attach: null, relayEntry: undefined })
    assert.equal((parseCliArgs([], { AGENT_LENS_TRAY_BIN: '/y/tray' }) as { trayBin: string }).trayBin, '/y/tray')
  })
  it('reads --attach as a port and --relay-entry', () => {
    const r = parseCliArgs(['--tray-bin', 't', '--attach', '3001', '--relay-entry', 'r.js'], {})
    assert.deepEqual(r, { ok: true, trayBin: 't', attach: 3001, relayEntry: 'r.js' })
  })
  it('refuses a bad port, a missing value, an unknown option', () => {
    for (const argv of [['--tray-bin', 't', '--attach', '0'], ['--tray-bin', 't', '--attach', '70000'], ['--tray-bin', 't', '--attach', 'x'],
      ['--tray-bin'], ['--tray-bin', 't', '--attach'], ['--tray-bin', 't', '--host', '0.0.0.0'], ['--tray-bin', 't', '--tray-bin', '--attach']]) {
      assert.equal(parseCliArgs(argv, {}).ok, false, argv.join(' '))
    }
  })
})

describe('localeFromEnv', () => {
  it('French when the system says so, else English', () => {
    assert.equal(localeFromEnv({ LANG: 'fr_FR.UTF-8' }), 'fr')
    assert.equal(localeFromEnv({ LC_ALL: 'fr_CA', LANG: 'en_US' }), 'fr')
    assert.equal(localeFromEnv({ LANG: 'en_US.UTF-8' }), 'en')
    assert.equal(localeFromEnv({}), 'en')
  })
})

describe('the driver process', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  it('stops the relay it started and exits 0 on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-cli-'))
    dirs.push(dir)
    const mark = path.join(dir, 'relay.mark')
    const log = path.join(dir, 'tray.log')
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, '--tray-bin', FAKE_TRAY, '--relay-entry', FAKE_RELAY], {
      env: { ...process.env, FAKE_RELAY_MARK: mark, FAKE_TRAY_LOG: log },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const exited = new Promise<number | null>(res => child.on('exit', code => res(code)))
    const end = Date.now() + 8000
    while (!(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"menu"'))) {
      if (Date.now() > end) { child.kill('SIGKILL'); assert.fail('the menu never reached the binary') }
      await new Promise(r => setTimeout(r, 50))
    }
    child.kill('SIGTERM')
    assert.equal(await exited, 0)
    assert.equal(fs.readFileSync(mark, 'utf8'), 'SIGTERM')
  })

  it('exits 2 with a usage message, without starting anything, on a bad command line', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', d => { err += String(d) })
    const code = await new Promise<number | null>(res => child.on('exit', c => res(c)))
    assert.equal(code, 2)
    assert.match(err, /--tray-bin/)
  })
})
