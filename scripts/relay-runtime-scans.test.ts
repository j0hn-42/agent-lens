/**
 * The scans of the other runtimes (Codex, Copilot, Pi, Gemini, OpenCode) run through a shared ticker, like the
 * Claude scan: without an SSE client no one-second interval is left running (#654). The relay is a per-process
 * singleton, so this lives in its own test file.
 */
import '../extension/test/helpers/alias-vscode'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { SCAN_INTERVAL_MS } from '../extension/src/constants'

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-relay-rt-'))
process.env.HOME = fakeHome
delete process.env.CLAUDE_CONFIG_DIR
process.env.USERPROFILE = fakeHome
delete process.env.AGENT_LENS_ALL_WORKSPACES

let relay: Awaited<ReturnType<typeof import('./relay').createRelay>>
let server: http.Server
let port = 0

// One-second intervals created and not yet cleared, whoever owns them
const liveScanIntervals = new Set<unknown>()
const realSet = global.setInterval
const realClear = global.clearInterval

async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 20)) }
  return pred()
}

describe('scans of the other runtimes stop without a client (#654)', () => {
  before(async () => {
    global.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
      const t = (realSet as (...a: unknown[]) => unknown)(fn, ms, ...args)
      if (ms === SCAN_INTERVAL_MS) liveScanIntervals.add(t)
      return t
    }) as typeof setInterval
    global.clearInterval = ((t: unknown) => { liveScanIntervals.delete(t); return (realClear as (t: unknown) => void)(t) }) as typeof clearInterval

    const ws = path.join(fakeHome, 'my-workspace')
    fs.mkdirSync(ws, { recursive: true })
    const { createRelay } = await import('./relay')
    relay = await createRelay({ workspace: ws, runtime: 'auto' })
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/events')) return relay.handleSSE(req, res)
      res.writeHead(404); res.end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    port = (server.address() as { port: number }).port
  })

  after(() => {
    global.setInterval = realSet
    global.clearInterval = realClear
    relay.dispose()
    server.close()
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('no one-second scan interval runs in auto mode while nobody is connected', () => {
    assert.equal(liveScanIntervals.size, 0, 'neither the Claude scan nor the other runtimes')
    assert.equal(relay.debugState().runtimeScanTimerActive, false)
  })

  it('a client starts the shared runtime scan, the last one leaving stops it', async () => {
    const a = http.get({ host: '127.0.0.1', port, path: '/events', agent: false })
    const b = http.get({ host: '127.0.0.1', port, path: '/events', agent: false })
    a.on('error', () => {}); b.on('error', () => {})
    assert.ok(await waitFor(() => relay.debugState().sseClients === 2))
    assert.equal(relay.debugState().runtimeScanTimerActive, true)
    assert.equal(liveScanIntervals.size, 2, 'the Claude scan and ONE shared scan for the five other runtimes')

    a.destroy()
    assert.ok(await waitFor(() => relay.debugState().sseClients === 1))
    assert.equal(relay.debugState().runtimeScanTimerActive, true, 'still one client')

    b.destroy()
    assert.ok(await waitFor(() => relay.debugState().sseClients === 0))
    assert.equal(relay.debugState().runtimeScanTimerActive, false)
    assert.equal(liveScanIntervals.size, 0)
  })
})
