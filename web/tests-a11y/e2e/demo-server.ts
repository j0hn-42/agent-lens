// Starts the demo app (next dev, NEXT_PUBLIC_DEMO=1) on a free port for the browser tests and stops it
// afterwards, so `pnpm --dir web run test:e2e` needs no server started by hand and never touches the
// ports a developer's own servers use (3000 / 3001). E2E_BASE_URL still points the tests at a server
// that is already running; nothing is started then.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

const WEB_DIR = path.resolve(__dirname, '..', '..')
const START_TIMEOUT_MS = 180_000

/**
 * Demo server log: one file per e2e file (`demo-server-<name>.log`), from the entry point of the test process
 * (`node --test` runs each file in its own process). Without a known entry point, the shared `demo-server.log`.
 * All of `web/test-results/` is attached to the CI artifacts on failure (#575).
 */
export function demoServerLogPath(entry: string | undefined): string {
  const name = entry ? path.basename(entry).replace(/\.e2e\.(ts|tsx|js|mjs)$|\.(ts|tsx|js|mjs)$/, '') : ''
  return path.join(WEB_DIR, 'test-results', name ? `demo-server-${name}.log` : 'demo-server.log')
}

const LOG_FILE = demoServerLogPath(process.argv[1])

/** Pids (`pid=N`) read in the output of `ss -ltnp`; without a `users` column no pid is proven. */
export function parseListenerPids(output: string): number[] {
  const pids = [...output.matchAll(/pid=(\d+)/g)].map(m => Number(m[1]))
  return [...new Set(pids)]
}

export type ListenerProbe =
  | { status: 'ok'; pids: number[] }
  /** ss works but shows a listener without its pid (not readable, e.g. another user): nothing is proven. */
  | { status: 'unreadable' }
  /** ss is missing or failed. */
  | { status: 'unavailable' }

/** Reads `ss -ltnp` line by line: a single listener without `pid=` makes the whole probe unreadable. */
export function classifySsOutput(output: string): ListenerProbe {
  const lines = output.split('\n').filter(l => l.trim() !== '')
  if (lines.some(l => !/pid=\d+/.test(l))) return { status: 'unreadable' }
  return { status: 'ok', pids: parseListenerPids(output) }
}

/** Probes the TCP listeners of a port with `ss` (`lsof` does not see next-server in the test sandbox: proven). */
export function listenerPidsOnPort(port: number): ListenerProbe {
  const res = spawnSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' })
  if (res.error || res.status !== 0) return { status: 'unavailable' }
  return classifySsOutput(res.stdout)
}

/** Process group (field 5 of /proc/<pid>/stat, or `ps`), `undefined` if the process does not exist or is unreadable. */
export function processGroupOf(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // The name (field 2) is in parentheses and may contain spaces: read after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const pgrp = Number(rest[2])
    return Number.isInteger(pgrp) ? pgrp : undefined
  } catch {
    const res = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
    const pgrp = Number(res.stdout.trim())
    return res.error || !Number.isInteger(pgrp) || res.stdout.trim() === '' ? undefined : pgrp
  }
}

/** Listeners outside the process group we started; an unknown group is not proven, so it is reported. */
export function foreignListeners(listeners: number[], pgid: number, pgidOf: (pid: number) => number | undefined = processGroupOf): number[] {
  return listeners.filter(pid => pgidOf(pid) !== pgid)
}

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

/** Foreign server answering on the port freePort handed out (#575): not ours, so retry on another port. */
export class ForeignServerError extends StartExitedError {}

/**
 * Once the URL answers, proves that what answers is the server we spawned: every pid listening on the port must
 * belong to our process group. The result (or the impossibility to check) is written to the server log.
 */
function verifyServerIdentity(port: number, child: ChildProcess, log: number): void {
  const probe = listenerPidsOnPort(port)
  if (probe.status !== 'ok') {
    const why = probe.status === 'unavailable' ? 'ss unavailable' : 'a listener pid is not readable'
    fs.writeSync(log, `=== identity of the server on port ${port} NOT verified (${why}) ===\n`)
    return
  }
  const listeners = probe.pids
  const foreign = foreignListeners(listeners, child.pid!)
  if (foreign.length > 0 || listeners.length === 0) {
    const msg = listeners.length === 0
      ? `nothing listens on port ${port} although it answered`
      : `pid(s) ${foreign.join(', ')} listening on port ${port} are outside the process group ${child.pid} we started`
    fs.writeSync(log, `=== FOREIGN server suspected: ${msg} ===\n`)
    throw new ForeignServerError(`the answer on http://127.0.0.1:${port} does not come from the server we started: ${msg} (see ${LOG_FILE})`)
  }
  fs.writeSync(log, `=== identity verified: pid(s) ${listeners.join(', ')} listen on port ${port}, in process group ${child.pid} ===\n`)
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
    verifyServerIdentity(port, child, log)
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
