// Starts the demo app (next dev, NEXT_PUBLIC_DEMO=1) on a free port for the browser tests and stops it
// afterwards, so `pnpm --dir web run test:e2e` needs no server started by hand and never touches the
// ports a developer's own servers use (3000 / 3001). E2E_BASE_URL still points the tests at a server
// that is already running; nothing is started then.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const WEB_DIR = path.resolve(__dirname, '..', '..')
const LOG_FILE = path.join(WEB_DIR, 'test-results', 'demo-server.log')
const START_TIMEOUT_MS = 180_000

/** Own build directory, so the demo server never contends for `.next/dev/lock` with a developer's `next dev`. */
export const E2E_DIST_DIR = '.next-e2e'

export function demoServerEnv<T extends Record<string, string | undefined>>(base: T): T & Record<"NEXT_DIST_DIR" | "NEXT_PUBLIC_DEMO" | "NEXT_TELEMETRY_DISABLED", string> {
  return { ...base, NEXT_PUBLIC_DEMO: '1', NEXT_TELEMETRY_DISABLED: '1', NEXT_DIST_DIR: E2E_DIST_DIR }
}

/**
 * Spawns a detached process group and makes sure it dies with this process, including on Ctrl+C or a
 * kill that skips the test hooks (the SIGINT of a terminal only reaches the foreground group).
 */
export function spawnGuarded(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, args, { ...options, detached: true })
  const killGroup = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
  const onSigint = () => { killGroup(); process.kill(process.pid, 'SIGINT') }
  const onSigterm = () => { killGroup(); process.kill(process.pid, 'SIGTERM') }
  process.once('exit', killGroup)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  child.once('exit', () => {
    process.off('exit', killGroup)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  })
  return child
}

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

/** The server process ended before it answered (port taken, crash at startup): another attempt on a new port can succeed. */
export class StartExitedError extends Error {}

/**
 * Runs `attempt` (1-based) up to `max` times while it fails with StartExitedError. Any other failure (the server
 * is alive but silent past the deadline) is thrown at once, and so is the last StartExitedError: nothing is hidden.
 */
export async function startWithRetries<T>(attempt: (n: number) => Promise<T>, max: number): Promise<T> {
  for (let n = 1; ; n++) {
    try { return await attempt(n) } catch (err) {
      if (!(err instanceof StartExitedError) || n >= max) throw err
    }
  }
}

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true } catch { return false }
}

/**
 * Stops the whole process group of `child` and returns only once no member is left. Waiting for the leader
 * (`pnpm`) alone is not enough: it exits at once while `next dev` and `next-server` keep running for seconds
 * (more under load), still holding .next-e2e, while the next test file already starts its own server (#440).
 */
export async function stopProcessGroup(child: ChildProcess, graceMs = 10_000): Promise<void> {
  const pgid = child.pid
  if (!pgid) return
  const signal = (sig: NodeJS.Signals) => { try { process.kill(-pgid, sig) } catch { /* already gone */ } }
  signal('SIGTERM')
  const deadline = Date.now() + graceMs
  while (groupAlive(pgid)) {
    if (Date.now() > deadline) signal('SIGKILL')
    await new Promise(r => setTimeout(r, 50))
  }
}

async function waitUntilServing(url: string, child: ChildProcess, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let last = 'no answer yet'
  while (Date.now() < deadline) {
    if (exited()) throw new StartExitedError(`the demo server exited before answering (see ${LOG_FILE})`)
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

const START_ATTEMPTS = 3

async function startOnce(attempt: number): Promise<DemoServer> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  // Appended, not truncated: every server of a run keeps its output, so a server that died mid-suite leaves a trace.
  const log = fs.openSync(LOG_FILE, 'a')
  fs.writeSync(log, `\n=== demo server runner pid ${process.pid}, attempt ${attempt}, port ${port}, ${new Date().toISOString()} ===\n`)
  // Own process group so the whole next dev tree (pnpm, next, its workers) is stopped with one signal.
  const child = spawnGuarded('pnpm', ['exec', 'next', 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: WEB_DIR,
    env: demoServerEnv(process.env),
    stdio: ['ignore', log, log],
  })
  let hasExited = false
  child.once('exit', () => { hasExited = true })
  const stop = async () => {
    await stopProcessGroup(child)
    try { fs.closeSync(log) } catch { /* already closed */ }
  }
  try {
    await waitUntilServing(url, child, () => hasExited)
  } catch (err) {
    await stop()
    throw err
  }
  return { url, stop }
}

export async function startDemoServer(): Promise<DemoServer> {
  const configured = process.env.E2E_BASE_URL
  if (configured) {
    const res = await fetch(configured).catch(err => { throw new Error(`E2E_BASE_URL ${configured} is not reachable: ${String(err)}`) })
    if (!res.ok) throw new Error(`E2E_BASE_URL ${configured} answered HTTP ${res.status}`)
    return { url: configured, stop: async () => {} }
  }
  return startWithRetries(startOnce, START_ATTEMPTS)
}
