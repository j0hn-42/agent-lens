/**
 * Stale discovery files (#144): hook.js falls back to the next workspace match when the most specific
 * one refuses the connection, and the extension/relay purge dead files at startup.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { getHookScriptContent } from '../src/discovery'
import { purgeStaleDiscoveryFiles, probePort, isPidGone } from '../src/discovery-purge'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const setupJs = require('../../scripts/setup.js') as { getHookScriptContent: () => string }

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function runHook(scriptPath: string, home: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('exit', () => resolve())
    child.on('error', reject)
    child.stdin.end(JSON.stringify({ cwd, hook_event_name: 'Stop' }))
  })
}

describe('hook.js stale discovery fallback', () => {
  let root: string
  let received: string[]
  let server: http.Server
  let livePort: number

  before(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-stale-')))
    received = []
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => { received.push(body); res.end('ok') })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    livePort = (server.address() as net.AddressInfo).port
  })
  after(() => {
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const variants: Array<[string, () => string]> = [
    ['extension script', getHookScriptContent],
    ['standalone script', setupJs.getHookScriptContent],
  ]

  for (const [label, content] of variants) {
    it(`${label}: a stale /proj/sub file does not capture the hook of the live /proj instance`, async () => {
      const home = fs.mkdtempSync(path.join(root, 'home-'))
      const dir = path.join(home, '.claude', 'agent-lens')
      fs.mkdirSync(dir, { recursive: true })
      const ws = path.join(root, `proj-${label.split(' ')[0]}`)
      fs.mkdirSync(path.join(ws, 'sub', 'x'), { recursive: true })

      const deadPort = await closedPort()
      // pid is alive (this test process), as on Windows where liveness cannot be checked by pid.
      fs.writeFileSync(path.join(dir, `stale-${process.pid}.json`), JSON.stringify({ port: deadPort, pid: process.pid, workspace: path.join(ws, 'sub') }))
      fs.writeFileSync(path.join(dir, `live-${process.pid}.json`), JSON.stringify({ port: livePort, pid: process.pid, workspace: ws }))
      const script = path.join(dir, 'hook.js')
      fs.writeFileSync(script, content())

      received.length = 0
      await runHook(script, home, path.join(ws, 'sub', 'x'))

      assert.equal(received.length, 1)
      assert.equal(JSON.parse(received[0]).hook_event_name, 'Stop')
      assert.equal(fs.existsSync(path.join(dir, `stale-${process.pid}.json`)), false, 'stale file removed')
      assert.equal(fs.existsSync(path.join(dir, `live-${process.pid}.json`)), true)
    })

    it(`${label}: still prefers the most specific live instance`, async () => {
      const home = fs.mkdtempSync(path.join(root, 'home-'))
      const dir = path.join(home, '.claude', 'agent-lens')
      fs.mkdirSync(dir, { recursive: true })
      const ws = path.join(root, `pref-${label.split(' ')[0]}`)
      fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
      const parentPort = await closedPort() // would be refused: must not even be tried
      fs.writeFileSync(path.join(dir, `p-${process.pid}.json`), JSON.stringify({ port: parentPort, pid: process.pid, workspace: ws }))
      fs.writeFileSync(path.join(dir, `s-${process.pid}.json`), JSON.stringify({ port: livePort, pid: process.pid, workspace: path.join(ws, 'sub') }))
      const script = path.join(dir, 'hook.js')
      fs.writeFileSync(script, content())

      received.length = 0
      await runHook(script, home, path.join(ws, 'sub'))
      assert.equal(received.length, 1)
      assert.equal(fs.existsSync(path.join(dir, `p-${process.pid}.json`)), true, 'less specific file untouched')
    })
  }
})

describe('purgeStaleDiscoveryFiles', () => {
  let dir: string
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-purge-')) })
  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const put = (name: string, data: unknown) => fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : JSON.stringify(data))

  it('removes dead pids and refused ports, keeps live, unknown, corrupt, own and manifest files', async () => {
    put('deadpid-1.json', { port: 1111, pid: 111, workspace: '/a' })
    put('refused-2.json', { port: 2222, pid: 222, workspace: '/b' })
    put('live-3.json', { port: 3333, pid: 333, workspace: '/c' })
    put('slow-4.json', { port: 4444, pid: 444, workspace: '/d' })
    put('own-5.json', { port: 5555, pid: 555, workspace: '/e' })
    put('corrupt-6.json', '{ nope')
    put('workspaces.json', ['/x'])
    const probed: number[] = []
    const removed = await purgeStaleDiscoveryFiles({
      dir, selfPid: 555, platform: 'linux',
      pidGone: pid => pid === 111,
      probe: async port => { probed.push(port); return port === 2222 ? 'refused' : port === 4444 ? 'unknown' : 'open' },
    })
    assert.deepEqual(removed.sort(), ['deadpid-1.json', 'refused-2.json'])
    assert.deepEqual(fs.readdirSync(dir).sort(), ['corrupt-6.json', 'live-3.json', 'own-5.json', 'slow-4.json', 'workspaces.json'])
    assert.ok(!probed.includes(1111) && !probed.includes(5555))
  })

  it('on Windows ignores the pid check and relies on the port alone', async () => {
    put('w-gone-7.json', { port: 7777, pid: 777, workspace: '/w' })
    put('w-refused-8.json', { port: 8888, pid: 888, workspace: '/w2' })
    const removed = await purgeStaleDiscoveryFiles({
      dir, selfPid: 1, platform: 'win32',
      pidGone: () => true, // would delete everything if it were consulted
      probe: async port => (port === 8888 ? 'refused' : 'open'),
    })
    assert.deepEqual(removed, ['w-refused-8.json'])
    assert.ok(fs.existsSync(path.join(dir, 'w-gone-7.json')))
  })

  it('returns nothing for a missing directory', async () => {
    assert.deepEqual(await purgeStaleDiscoveryFiles({ dir: path.join(dir, 'nope') }), [])
  })

  it('probePort tells a refused port from an open one, and isPidGone a dead pid from this one', async () => {
    const srv = net.createServer(s => s.destroy())
    await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
    const { port } = srv.address() as net.AddressInfo
    assert.equal(await probePort(port), 'open')
    await new Promise<void>(r => srv.close(() => r()))
    assert.equal(await probePort(port), 'refused')
    assert.equal(isPidGone(process.pid), false)
    assert.equal(isPidGone(2 ** 22 + 12345), true)
  })
})
