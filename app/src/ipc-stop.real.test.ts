/**
 * #513: the stop channel of the REAL standalone app (app/src/app.ts), started as a child process with a
 * throw-away HOME, the way the tray driver starts it. Proves on Linux that the stop message runs the same
 * clean-up as SIGTERM (exit code 0, discovery file removed), that a dead parent does not leave an orphan
 * relay, that hostile messages are ignored, and that without --ipc-stop nothing changes.
 * It cannot prove the Windows behaviour (named pipes instead of a socketpair): see docs/tray.md.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(__dirname, '../..')
const TSX_LOADER = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'af-ipc-stop-')))
const home = path.join(base, 'home')
const workspace = path.join(base, 'workspace')
const discovery = path.join(home, '.claude', 'agent-lens')
const entry = path.join(base, 'entry-app.ts')
const READY = /Server running at http:\/\/127\.0\.0\.1:(\d+)/
const running: ChildProcess[] = []
const strayPids: number[] = []

const env = (): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home }
  delete e.CLAUDE_CONFIG_DIR
  delete e.AGENT_LENS_PORT
  return e
}
const appArgs = (extra: string[]) => ['--import', TSX_LOADER, entry, '--port', '0', '--no-open', ...extra]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(fn: () => T | undefined | false, ms = 20_000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await sleep(50)
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const discoveryFileOf = (pid: number) => path.join(discovery, fs.existsSync(discovery) ? (fs.readdirSync(discovery).find(f => f.endsWith(`-${pid}.json`)) ?? 'none') : 'none')

interface Started { child: ChildProcess; port: number; out: () => string }
function start(extra: string[], withIpc: boolean): Promise<Started> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, appArgs(extra), { cwd: workspace, env: env(), stdio: withIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] })
    running.push(child)
    let out = ''
    const timer = setTimeout(() => reject(new Error(`the app did not start:\n${out}`)), 30_000)
    const onData = (c: Buffer) => {
      out += c.toString()
      const m = READY.exec(out)
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), out: () => out }) }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`the app exited early (${code}):\n${out}`)) })
  })
}
const exitOf = (child: ChildProcess, ms = 15_000) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode })
  const timer = setTimeout(() => reject(new Error('the app did not exit')), ms)
  child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
})
const statusOf = async (port: number) => (await fetch(`http://127.0.0.1:${port}/status`)).status

describe('real app: stop over the IPC channel of the parent (#513)', () => {
  before(() => {
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })
    // The extension code requires 'vscode': the alias the other real-server tests load first
    fs.writeFileSync(entry, `import ${JSON.stringify(path.join(ROOT, 'extension/test/helpers/alias-vscode'))}\nimport ${JSON.stringify(path.join(ROOT, 'app/src/app.ts'))}\n`)
  })

  after(async () => {
    await Promise.all(running.map(c => new Promise<void>(resolve => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve()
      c.once('exit', () => resolve())
      c.kill('SIGKILL')
    })))
    for (const c of running) { c.stdout?.destroy(); c.stderr?.destroy() }
    for (const pid of strayPids) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('with --ipc-stop: hostile messages are ignored, the stop message runs the clean-up and exits 0', async () => {
    const app = await start(['--ipc-stop'], true)
    const pid = app.child.pid!
    const file = await until(() => { const f = discoveryFileOf(pid); return fs.existsSync(f) && f }, 20_000, 'the discovery file')
    for (const m of ['stop', { type: 'stop' }, { v: 2, type: 'stop' }, { v: 1, type: 'stop', extra: true }, { v: 1, type: 'stop', pad: 'x'.repeat(200_000) }, [{ v: 1, type: 'stop' }]]) {
      app.child.send(m)
    }
    await sleep(500)
    assert.equal(app.child.exitCode, null, 'still running after hostile messages')
    assert.equal(await statusOf(app.port), 200)
    assert.ok(fs.existsSync(file))
    app.child.send({ v: 1, type: 'stop' })
    assert.deepEqual(await exitOf(app.child), { code: 0, signal: null })
    assert.equal(fs.existsSync(file), false, 'the clean-up removed the discovery file')
    assert.ok(!app.out().includes('x'.repeat(64)), 'the content of a hostile message is never printed')
  })

  it('with --ipc-stop: a stop sent before the server listens is kept and runs the clean-up once it listens', async () => {
    // The message is written right after the spawn: the relay needs far longer (tsx, telemetry, relay) to listen
    const child = spawn(process.execPath, appArgs(['--ipc-stop']), { cwd: workspace, env: env(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    running.push(child)
    let out = ''
    child.stdout!.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr!.on('data', (c: Buffer) => { out += c.toString() })
    const pid = child.pid!
    child.send({ v: 1, type: 'stop' })
    assert.ok(!READY.test(out), 'the stop was sent before the server listened')
    assert.deepEqual(await exitOf(child, 30_000), { code: 0, signal: null }, out)
    assert.match(out, READY, 'the stop ran after the server listened, not instead of the start')
    assert.equal(fs.existsSync(discoveryFileOf(pid)), false, 'the clean-up removed the discovery file')
  })

  it('with --ipc-stop: a parent killed with SIGKILL leaves no orphan relay, and the clean-up runs', async () => {
    // An intermediate parent opens the IPC channel, then dies without a word. The relay output goes to a file,
    // not a pipe, so the relay cannot die from a broken pipe instead of the channel.
    const log = path.join(base, 'orphan.log')
    const parentScript = path.join(base, 'parent.cjs')
    fs.writeFileSync(parentScript, `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const fd = fs.openSync(${JSON.stringify(log)}, 'w')
const child = spawn(process.execPath, ${JSON.stringify(appArgs(['--ipc-stop']))}, { cwd: ${JSON.stringify(workspace)}, stdio: ['ignore', fd, fd, 'ipc'] })
process.stdout.write(String(child.pid) + '\\n')
setInterval(() => {}, 1000)
`)
    const parent = spawn(process.execPath, [parentScript], { env: env(), stdio: ['ignore', 'pipe', 'inherit'] })
    running.push(parent)
    let pidText = ''
    parent.stdout!.on('data', (c: Buffer) => { pidText += c.toString() })
    const pid = await until(() => /^(\d+)\n/.exec(pidText)?.[1], 10_000, 'the relay pid').then(Number)
    strayPids.push(pid)
    await until(() => fs.existsSync(log) && READY.test(fs.readFileSync(log, 'utf8')), 30_000, 'the relay URL line')
    const file = await until(() => { const f = discoveryFileOf(pid); return fs.existsSync(f) && f }, 20_000, 'the discovery file')
    parent.kill('SIGKILL')
    await until(() => !alive(pid), 15_000, 'the relay to exit after its parent died')
    assert.equal(fs.existsSync(file), false, 'the clean-up removed the discovery file')
  })

  it('without --ipc-stop: the stop message changes nothing, SIGTERM still runs the clean-up', async () => {
    const app = await start([], true)
    const pid = app.child.pid!
    const file = await until(() => { const f = discoveryFileOf(pid); return fs.existsSync(f) && f }, 20_000, 'the discovery file')
    app.child.send({ v: 1, type: 'stop' })
    await sleep(800)
    assert.equal(app.child.exitCode, null, 'the message is not read without the flag')
    assert.equal(await statusOf(app.port), 200)
    app.child.kill('SIGTERM')
    assert.deepEqual(await exitOf(app.child), { code: 0, signal: null })
    assert.equal(fs.existsSync(file), false)
  })

  it('--ipc-stop without an IPC channel from the parent refuses to start (exit 2), before listening', async () => {
    const child = spawn(process.execPath, appArgs(['--ipc-stop']), { cwd: workspace, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })
    running.push(child)
    let out = ''
    child.stdout!.on('data', (c: Buffer) => { out += c.toString() })
    child.stderr!.on('data', (c: Buffer) => { out += c.toString() })
    const r = await exitOf(child, 30_000)
    assert.equal(r.code, 2, out)
    assert.match(out, /--ipc-stop/)
    assert.doesNotMatch(out, /Server running/)
  })
})
