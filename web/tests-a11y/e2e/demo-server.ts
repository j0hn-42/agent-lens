// Starts the demo app (next dev, NEXT_PUBLIC_DEMO=1) on a free port for the browser tests and stops it
// afterwards, so `pnpm --dir web run test:e2e` needs no server started by hand and never touches the
// ports a developer's own servers use (3000 / 3001). E2E_BASE_URL still points the tests at a server
// that is already running; nothing is started then.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const WEB_DIR = path.resolve(__dirname, '..', '..')
const LOG_FILE = path.join(WEB_DIR, 'test-results', 'demo-server.log')
const START_TIMEOUT_MS = 180_000

export interface DemoServer {
  url: string
  stop(): Promise<void>
}

/** Port the OS hands out for an ephemeral listener, released right away. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

async function waitUntilServing(url: string, child: ChildProcess, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let last = 'no answer yet'
  while (Date.now() < deadline) {
    if (exited()) throw new Error(`the demo server exited before answering (see ${LOG_FILE})`)
    try {
      const res = await fetch(url)
      if (res.ok) return
      last = `HTTP ${res.status}`
    } catch (err) { last = String(err) }
    await new Promise(r => setTimeout(r, 500))
  }
  child.kill('SIGTERM')
  throw new Error(`the demo server did not answer at ${url} within ${START_TIMEOUT_MS / 1000} s (${last}; see ${LOG_FILE})`)
}

export async function startDemoServer(): Promise<DemoServer> {
  const configured = process.env.E2E_BASE_URL
  if (configured) {
    const res = await fetch(configured).catch(err => { throw new Error(`E2E_BASE_URL ${configured} is not reachable: ${String(err)}`) })
    if (!res.ok) throw new Error(`E2E_BASE_URL ${configured} answered HTTP ${res.status}`)
    return { url: configured, stop: async () => {} }
  }

  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  const log = fs.openSync(LOG_FILE, 'w')
  // Own process group so the whole next dev tree (pnpm, next, its workers) is stopped with one signal.
  const child = spawn('pnpm', ['exec', 'next', 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_DIR,
    env: { ...process.env, NEXT_PUBLIC_DEMO: '1', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', log, log],
    detached: true,
  })
  let hasExited = false
  const closed = new Promise<void>(resolve => child.once('exit', () => { hasExited = true; resolve() }))
  const stop = async () => {
    if (!hasExited && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      const forced = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already gone */ } }, 10_000)
      await closed
      clearTimeout(forced)
    }
    fs.closeSync(log)
  }
  try {
    await waitUntilServing(url, child, () => hasExited)
  } catch (err) {
    await stop()
    throw err
  }
  return { url, stop }
}
