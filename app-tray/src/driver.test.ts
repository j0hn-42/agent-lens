// #335, increment 2: the driver, tested with a fake relay and a fake native binary (no real binary, no GUI).
import '../../scripts/all-locales' // #662: the tables are loaded on demand, every one is loaded before the tests
import { afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import childProcess from 'node:child_process'
import { translate } from '../../web/lib/messages'
import { parseRelayUrlLine, probeStatus, startDriver, type DriverHandle, type DriverOptions } from './driver'

const FAKE_RELAY = path.resolve(__dirname, '../test/fake-relay.mjs')
const FAKE_TRAY = path.resolve(__dirname, '../test/fake-tray-binary.mjs')
const tr = (key: Parameters<typeof translate>[1], p?: Parameters<typeof translate>[2]) => translate('fr', key, p)
const click = (id: string, extra: object = {}) => JSON.stringify({ v: 1, type: 'click', id, ...extra })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timeout waiting for condition')
    await sleep(20)
  }
}

const dirs: string[] = []
const handles: DriverHandle[] = []
const pids: number[] = []
afterEach(async () => {
  const open = handles.splice(0)
  for (const h of open) h.stop()
  await Promise.allSettled(open.map(h => h.done))
  for (const pid of pids.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

interface Rig {
  handle: DriverHandle
  logs: string[]
  opened: Array<[string, number]>
  copied: Array<[string, number]>
  mark: string
  received(): Array<Record<string, unknown>>
  menus(): Array<{ tooltip: string; items: Array<{ id: string; label: string; enabled: boolean }> }>
  lastMenu(): { tooltip: string; items: Array<{ id: string; label: string; enabled: boolean }> } | undefined
}

function rig(relayEnv: Record<string, string> = {}, trayEnv: Record<string, string> = {}, over: Partial<DriverOptions> = {}, stopChannel?: 'ipc'): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tray-driver-'))
  dirs.push(dir)
  const log = path.join(dir, 'tray.log')
  const mark = path.join(dir, 'relay.mark')
  const logs: string[] = []
  const opened: Array<[string, number]> = []
  const copied: Array<[string, number]> = []
  const handle = startDriver({
    relay: { spawn: { file: process.execPath, args: stopChannel === 'ipc' ? [FAKE_RELAY, '--ipc-stop'] : [FAKE_RELAY], env: { ...process.env, FAKE_RELAY_MARK: mark, ...relayEnv }, ...(stopChannel ? { stopChannel } : {}) } },
    tray: { file: process.execPath, args: [FAKE_TRAY], env: { ...process.env, FAKE_TRAY_LOG: log, ...trayEnv } },
    locale: 'fr',
    pollIntervalMs: 40,
    probeTimeoutMs: 500,
    startupTimeoutMs: 3000,
    stopTimeoutMs: 1500,
    log: m => { logs.push(m); const pid = /PID is (\d+)/.exec(m); if (pid) pids.push(Number(pid[1])) },
    open: async (u, p) => { opened.push([u, p]); return true },
    copy: async (u, p) => { copied.push([u, p]); return true },
    ...over,
  })
  handles.push(handle)
  const received = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
  const menus = () => received().filter(m => m.type === 'menu') as ReturnType<Rig['menus']>
  return { handle, logs, opened, copied, mark, received, menus, lastMenu: () => menus().at(-1) }
}
const state = (r: Rig) => r.lastMenu()?.items.find(i => i.id === 'state')?.label

describe('parseRelayUrlLine: only an exact loopback URL line', () => {
  it('reads the port', () => {
    assert.equal(parseRelayUrlLine('Server running at http://127.0.0.1:3001'), 3001)
    assert.equal(parseRelayUrlLine('Server running at http://127.0.0.1:65535'), 65535)
  })
  it('refuses everything else', () => {
    for (const l of [
      '', 'Waiting for agent events...', 'Server running at http://0.0.0.0:3001', 'Server running at http://localhost:3001',
      'Server running at http://192.168.1.5:3001', 'Server running at http://127.0.0.1:0', 'Server running at http://127.0.0.1:65536',
      'Server running at http://127.0.0.1:3001/x', 'Server running at http://127.0.0.1:3001 extra', ' Server running at http://127.0.0.1:3001',
      'Server running at https://127.0.0.1:3001', 'Server running at http://127.0.0.1:03001', 'Server running at http://127.0.0.1:123456',
    ]) assert.equal(parseRelayUrlLine(l), null, l)
  })
})

describe('probeStatus: every failure is a kind, never a value', () => {
  const o = (f: typeof fetch, timeoutMs = 100) => ({ fetch: f, timeoutMs, now: () => 42 })
  const json = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch
  it('ok carries the body and the receive time', async () => {
    assert.deepEqual(await probeStatus(3001, o(json('{"a":1}'))), { kind: 'ok', body: { a: 1 }, receivedAt: 42 })
  })
  it('classifies failures', async () => {
    assert.deepEqual(await probeStatus(3001, o(json('x', 500))), { kind: 'http-error' })
    assert.deepEqual(await probeStatus(3001, o(json('{nope'))), { kind: 'invalid-json' })
    assert.deepEqual(await probeStatus(3001, o((async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch)), { kind: 'unreachable' })
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch
    assert.deepEqual(await probeStatus(3001, o(hang, 30)), { kind: 'timeout' })
  })
  it('does not read a body over the cap', async () => {
    assert.deepEqual(await probeStatus(3001, o(json(`{"p":"${'x'.repeat(100_000)}"}`))), { kind: 'invalid-json' })
  })
  it('only requests the loopback /status of the given port, without following redirects', async () => {
    const seen: Array<[string, RequestInit]> = []
    const f = (async (u: string, init: RequestInit) => { seen.push([u, init]); return new Response('{}') }) as unknown as typeof fetch
    await probeStatus(3456, o(f))
    assert.equal(seen[0][0], 'http://127.0.0.1:3456/status')
    assert.equal(seen[0][1].redirect, 'error')
  })
  it('reads a body of exactly 64 KiB, refuses one byte more', async () => {
    const body = (size: number) => { const head = '{"p":"'; return `${head}${'x'.repeat(size - head.length - 2)}"}` }
    assert.equal(body(64 * 1024).length, 64 * 1024)
    assert.equal((await probeStatus(3001, o(json(body(64 * 1024))))).kind, 'ok')
    assert.deepEqual(await probeStatus(3001, o(json(body(64 * 1024 + 1)))), { kind: 'invalid-json' })
  })
  it('refuses a redirect, even to another loopback path that answers valid JSON', async () => {
    const hits: string[] = []
    const server = http.createServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url === '/status') { res.writeHead(302, { location: '/elsewhere' }).end(); return }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"relayVersion":"0.10.0","sessionCount":7}')
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    try {
      const { port } = server.address() as AddressInfo
      assert.deepEqual(await probeStatus(port, { fetch, timeoutMs: 2000, now: () => 42 }), { kind: 'unreachable' })
      assert.deepEqual(hits, ['/status'], 'the redirect target is never requested')
    } finally {
      await new Promise(r => server.close(r))
    }
  })
})

describe('startDriver with a fake relay and a fake binary', () => {
  it('shows the proven count, then stops the relay with SIGTERM on quit', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify([click('quit')]) })
    await until(() => state(r) === tr('tray.sessions.many', { n: 2 }))
    assert.equal(r.lastMenu()?.items.find(i => i.id === 'skipped')?.label, tr('tray.skipped', { k: 1 }))
    assert.equal(r.lastMenu()?.items.find(i => i.id === 'quit')?.label, tr('tray.quit.stopRelay'))
    assert.equal(await r.handle.done, 0)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
    assert.ok(r.received().some(m => m.type === 'quit'), 'the binary is told to quit')
  })

  it('answers the first menu before the first probe, with unknown', async () => {
    const r = rig({}, {}, { pollIntervalMs: 40 })
    const first = await until(() => r.menus()[0])
    assert.ok([tr('tray.sessions.unknown'), tr('tray.sessions.many', { n: 2 })].includes(first.items.find(i => i.id === 'state')!.label))
  })

  it('says unknown, never a number, when /status fails or is foreign', async () => {
    for (const mode of ['status-500', 'status-bad-json', 'status-foreign', 'status-huge']) {
      const r = rig({ FAKE_RELAY_MODE: mode })
      await until(() => r.menus().length >= 1)
      await sleep(250)
      assert.ok(r.menus().every(m => m.items.find(i => i.id === 'state')!.label === tr('tray.sessions.unknown')), mode)
      assert.equal(r.menus().some(m => m.items.some(i => i.id === 'skipped')), false, mode)
      r.handle.stop()
      await r.handle.done
    }
  })

  it('times out a hanging /status and says unknown', async () => {
    const r = rig({ FAKE_RELAY_MODE: 'status-hang' }, {}, { probeTimeoutMs: 80 })
    await until(() => r.menus().length >= 1)
    await sleep(300)
    assert.ok(r.menus().every(m => m.items.find(i => i.id === 'state')!.label === tr('tray.sessions.unknown')))
  })

  it('goes back to unknown, not the last value, as soon as a probe fails', async () => {
    let calls = 0
    const flaky = ((u: string, init: RequestInit) => (++calls <= 2 ? fetch(u, init) : Promise.reject(new TypeError('down')))) as unknown as typeof fetch
    const r = rig({}, {}, { fetch: flaky })
    // Read the history of menus, not the current one: the count only lasts two polls (80 ms), and a loaded machine
    // can sample the current menu too late to ever see it.
    const states = () => r.menus().map(m => m.items.find(i => i.id === 'state')?.label)
    await until(() => states().includes(tr('tray.sessions.many', { n: 2 })))
    await until(() => states().slice(states().indexOf(tr('tray.sessions.many', { n: 2 }))).includes(tr('tray.sessions.unknown')))
  })

  it('logs one fixed line per change of probe state, never one per probe', async () => {
    let calls = 0
    // ok, ok, 6 failures, then ok again
    const flaky = ((u: string, init: RequestInit) => (++calls <= 2 || calls > 8 ? fetch(u, init) : Promise.reject(new TypeError('connect ECONNREFUSED 127.0.0.1:1234')))) as unknown as typeof fetch
    const r = rig({}, {}, { fetch: flaky })
    await until(() => calls > 10)
    const probeLogs = r.logs.filter(l => l.includes('/status'))
    assert.deepEqual(probeLogs, ['/status probe failed: unreachable', '/status probe answers again'])
  })

  it('names each failure kind once, without the raw answer', async () => {
    for (const [mode, kind] of [['status-500', 'http-error'], ['status-bad-json', 'invalid-json']]) {
      const r = rig({ FAKE_RELAY_MODE: mode })
      await sleep(400)
      assert.deepEqual(r.logs.filter(l => l.includes('/status')), [`/status probe failed: ${kind}`], mode)
      r.handle.stop()
      await r.handle.done
    }
    const r = rig({ FAKE_RELAY_MODE: 'status-hang' }, {}, { probeTimeoutMs: 60 })
    await sleep(500)
    assert.deepEqual(r.logs.filter(l => l.includes('/status')), ['/status probe failed: timeout'])
  })

  it('opens and copies the URL built from the relay port, nothing else', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify([click('open'), click('copyUrl')]) })
    await until(() => r.opened.length === 1 && r.copied.length === 1)
    const [url, port] = r.opened[0]
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(url, `http://127.0.0.1:${port}`)
    assert.deepEqual(r.copied[0], [url, port])
  })

  it('starts at most one opener per second for a burst of clicks', async () => {
    const burst = [...Array.from({ length: 50 }, () => click('open')), ...Array.from({ length: 50 }, () => click('copyUrl'))]
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify(burst) })
    await until(() => r.opened.length >= 1)
    await sleep(3500) // 100 clicks, 30 ms apart
    assert.ok(r.opened.length >= 1 && r.opened.length <= 3, `open ran ${r.opened.length} times`)
    assert.ok(r.copied.length >= 1 && r.copied.length <= 3, `copy ran ${r.copied.length} times`)
  })

  it('never runs a second opener while the first one is still running', async () => {
    let calls = 0
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify(Array.from({ length: 20 }, () => click('open'))) },
      { clickCooldownMs: 0, open: () => { calls++; return new Promise<boolean>(() => {}) } })
    await until(() => calls >= 1)
    await sleep(800)
    assert.equal(calls, 1)
    r.handle.stop()
  })

  it('logs, without crashing, when the browser or the clipboard is not available', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify([click('open'), click('copyUrl'), click('quit')]) },
      { open: async () => false, copy: async () => false })
    assert.equal(await r.handle.done, 0)
    assert.ok(r.logs.some(l => l.includes('could not open')))
    assert.ok(r.logs.some(l => l.includes('could not copy')))
  })

  it('ignores clicks on disabled items, unknown ids and clicks carrying extra data', async () => {
    const r = rig({}, {
      FAKE_TRAY_SEND: JSON.stringify([
        click('state'), click('skipped'), click('rm -rf'), click('open', { url: 'http://evil.example' }),
        click('open', { cmd: 'calc' }), 'garbage', 'x'.repeat(5000), click('open'),
      ]),
    })
    await until(() => r.opened.length >= 1)
    await sleep(150)
    assert.equal(r.opened.length, 1, 'only the clean click acted')
    assert.match(r.opened[0][0], /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.ok(r.logs.filter(l => l.startsWith('ignored a line')).length >= 4)
  })

  it('stops the binary and the relay after too many invalid lines', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify(Array.from({ length: 25 }, () => 'garbage')) })
    assert.equal(await r.handle.done, 1)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
  })

  it('stops the relay it started when the icon is closed', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify(['{"v":1,"type":"closed"}']) })
    assert.equal(await r.handle.done, 0)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
  })

  it('ends cleanly, stopping the relay, when the binary dies', async () => {
    const r = rig({}, { FAKE_TRAY_DIE: 'after-menu' })
    assert.equal(await r.handle.done, 1)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
  })

  it('ends with an error when the binary cannot be started', async () => {
    const r = rig({}, {}, { tray: { file: '/nonexistent/agent-lens-tray', args: [] } })
    assert.equal(await r.handle.done, 1)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
    assert.ok(r.logs.some(l => l.includes('cannot start the tray binary')))
  })

  it('resends the menu when the binary says ready again', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify(['{"v":1,"type":"ready"}']) })
    const n = await until(() => r.menus().length >= 2 && r.menus().length)
    assert.ok(n >= 2)
  })

  it('keeps its output bounded when the binary floods "ready" and never reads', async () => {
    const r = rig({}, { FAKE_TRAY_FLOOD_READY: '3000', FAKE_TRAY_NO_READ: '1' })
    let max = 0
    const end = Date.now() + 1500
    while (Date.now() < end) { max = Math.max(max, r.handle.pendingWriteBytes()); await sleep(5) }
    assert.ok(max <= 64 * 1024, `at most 64 KiB waiting for the binary, saw ${max} bytes`)
    assert.equal(r.logs.some(l => l.includes('does not read')), false, 'refreshes are merged, the cap is not reached')
    r.handle.stop()
    assert.equal(await r.handle.done, 0)
  })

  it('stops the binary with an error, never growing silently, past the output cap', async () => {
    const r = rig({}, { FAKE_TRAY_FLOOD_READY: '3000', FAKE_TRAY_NO_READ: '1' }, { maxPendingWriteBytes: 100 })
    assert.equal(await Promise.race([r.handle.done, sleep(8000).then(() => 'still running')]), 1)
    assert.equal(r.logs.filter(l => l.includes('does not read')).length, 1)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
  })

  it('ends with an error when the relay prints no URL', async () => {
    const r = rig({ FAKE_RELAY_MODE: 'no-url' }, {}, { startupTimeoutMs: 300 })
    assert.equal(await r.handle.done, 1)
    assert.ok(r.logs.some(l => l.includes('no URL')))
    assert.equal(r.received().length, 0, 'no icon without a proven URL')
  })

  it('trusts no relay line other than the exact loopback URL line', async () => {
    const r = rig({ FAKE_RELAY_MODE: 'foreign-url' }, {}, { startupTimeoutMs: 500 })
    assert.equal(await Promise.race([r.handle.done, sleep(3000).then(() => 'still running')]), 1)
    assert.ok(r.logs.some(l => l.includes('no URL')))
    assert.equal(r.received().length, 0, 'no icon for a foreign host, path, scheme or padded line')
  })

  it('ends with an error when the relay dies', async () => {
    const r = rig({ FAKE_RELAY_EXIT_AFTER_MS: '400' })
    assert.equal(await r.handle.done, 1)
    assert.ok(r.logs.some(l => l.includes('the relay exited')))
  })

  it('does not kill a relay that ignores SIGTERM: says so and exits 1', async () => {
    const r = rig({ FAKE_RELAY_MODE: 'ignore-term' }, { FAKE_TRAY_SEND: JSON.stringify([click('quit')]) }, { stopTimeoutMs: 200 })
    assert.equal(await r.handle.done, 1)
    assert.ok(r.logs.some(l => l.includes('did not stop after SIGTERM')))
  })

  it('stop() while the relay is starting is not reported as a startup failure', async () => {
    const r = rig({ FAKE_RELAY_MODE: 'no-url' }, {}, { startupTimeoutMs: 3000 })
    await sleep(200)
    r.handle.stop()
    // (no check of the SIGTERM mark: under load the fake relay may not have installed its handler yet)
    assert.equal(await r.handle.done, 0)
    assert.deepEqual(r.logs, [], 'no "the relay exited before printing its URL"')
    assert.equal(r.received().length, 0, 'no icon')
  })

  it('stop() follows the quit path', async () => {
    const r = rig()
    await until(() => state(r))
    r.handle.stop()
    assert.equal(await r.handle.done, 0)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
  })
})

describe('startDriver attached to a relay it did not start', () => {
  it('only closes the icon: the label says so and no signal is sent', async () => {
    const { spawn } = await import('node:child_process')
    const relay = spawn(process.execPath, [FAKE_RELAY], { stdio: ['ignore', 'pipe', 'inherit'] })
    pids.push(relay.pid!)
    const port = await new Promise<number>(res => relay.stdout.on('data', d => { const p = parseRelayUrlLine(String(d).split('\n')[0]); if (p) res(p) }))
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify([click('quit')]) }, { relay: { attach: port } })
    await until(() => state(r) === tr('tray.sessions.many', { n: 2 }))
    assert.equal(r.lastMenu()?.items.find(i => i.id === 'quit')?.label, tr('tray.quit.closeIcon'))
    assert.equal(await r.handle.done, 0)
    assert.equal(relay.exitCode, null, 'the relay still runs')
    assert.equal(relay.signalCode, null)
  })

  it('refuses an invalid port', async () => {
    const r = rig({}, {}, { relay: { attach: 70000 } })
    assert.equal(await r.handle.done, 1)
  })
})

describe('startDriver: stop over the IPC channel instead of SIGTERM (#513)', () => {
  it('quit sends the stop message, not SIGTERM, and the relay runs its clean-up', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify([click('quit')]) }, {}, 'ipc')
    assert.equal(await r.handle.done, 0)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'IPC')
  })

  it('stop() and a closed icon follow the same path', async () => {
    const a = rig({}, {}, {}, 'ipc')
    await until(() => state(a))
    a.handle.stop()
    assert.equal(await a.handle.done, 0)
    assert.equal(fs.readFileSync(a.mark, 'utf8'), 'IPC')
    const b = rig({}, { FAKE_TRAY_SEND: JSON.stringify(['{"v":1,"type":"closed"}']) }, {}, 'ipc')
    assert.equal(await b.handle.done, 0)
    assert.equal(fs.readFileSync(b.mark, 'utf8'), 'IPC')
  })

  it('a relay that ignores the stop message is never signalled: the driver says so and exits 1', async () => {
    const r = rig({ FAKE_RELAY_MODE: 'ignore-ipc' }, { FAKE_TRAY_SEND: JSON.stringify([click('quit')]) }, { stopTimeoutMs: 300 }, 'ipc')
    assert.equal(await r.handle.done, 1)
    assert.ok(r.logs.some(l => l.includes('did not stop after the stop message')), r.logs.join(' | '))
    assert.equal(fs.existsSync(r.mark), false, 'no SIGTERM was sent')
  })

  it('a channel already closed: nothing is sent, the driver waits, then says the relay did not stop (never SIGTERM)', async () => {
    const r = rig({ FAKE_RELAY_MODE: 'disconnect-ipc' }, {}, { stopTimeoutMs: 300 }, 'ipc')
    await until(() => state(r))
    await sleep(300)
    r.handle.stop()
    assert.equal(await r.handle.done, 1)
    assert.ok(r.logs.some(l => l.includes('did not stop after the stop message')), r.logs.join(' | '))
    assert.equal(fs.existsSync(r.mark), false, 'no SIGTERM was sent')
  })

  for (const how of ['callback', 'throw'] as const) {
    it(`a send that fails (${how}) is logged without detail, and the driver still ends`, async () => {
      const realSpawn = childProcess.spawn
      const spawnMock = mock.method(childProcess, 'spawn', ((...args: Parameters<typeof realSpawn>) => {
        const child = realSpawn(...args)
        if (child.channel) {
          child.send = ((_m: unknown, cb?: (e: Error | null) => void) => {
            if (how === 'throw') throw new Error('secret-detail')
            cb?.(new Error('secret-detail'))
            return false
          }) as typeof child.send
        }
        return child
      }) as typeof realSpawn)
      try {
        const r = rig({}, {}, { stopTimeoutMs: 300 }, 'ipc')
        await until(() => state(r))
        r.handle.stop()
        assert.equal(await r.handle.done, 1)
        assert.ok(r.logs.some(l => l.includes('could not send the stop message to the relay')), r.logs.join(' | '))
        assert.ok(r.logs.every(l => !l.includes('secret-detail')))
        assert.equal(fs.existsSync(r.mark), false, 'no SIGTERM was sent')
      } finally {
        spawnMock.mock.restore()
      }
    })
  }

  it('without stopChannel, the relay gets no IPC channel and is still stopped with SIGTERM', async () => {
    const r = rig({}, { FAKE_TRAY_SEND: JSON.stringify([click('quit')]) })
    assert.equal(await r.handle.done, 0)
    assert.equal(fs.readFileSync(r.mark, 'utf8'), 'SIGTERM')
  })
})

// #613: the test double behaves like the real relay (app/src/parent-stop.ts): with --ipc-stop, a channel closed by
// its parent (the driver killed) ends it, so no fake relay is left running after a test.
describe('fake relay double (#613)', () => {
  it('exits when its parent closes the IPC channel, like the real relay', async () => {
    const child = childProcess.spawn(process.execPath, [FAKE_RELAY, '--ipc-stop'], { stdio: ['ignore', 'pipe', 'ignore', 'ipc'] })
    pids.push(child.pid!)
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
    await new Promise<void>(resolve => child.stdout!.on('data', d => { if (String(d).includes('Server running at')) resolve() }))
    child.disconnect()
    const code = await Promise.race([exited, sleep(3000).then(() => 'still running' as const)])
    assert.equal(code, 0)
  })
})
