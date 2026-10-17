/**
 * Tray driver (#335): starts (or attaches to) the relay, probes GET /status, rebuilds the menu with
 * `deriveMenu` and talks to the native menu binary over the JSON line protocol of ./protocol.
 *
 * What the icon shows is never invented: a count comes from a recent /status answer, otherwise the
 * menu says "unknown" (see menu-model.ts). Only loopback is contacted. A signal is only ever sent to
 * the relay process this driver started, never to a PID found elsewhere. When the driver started the
 * relay, the relay lives as long as the driver: every way out (quit, closed icon, dead binary,
 * SIGTERM) stops it; when it only attached to a relay, closing the icon leaves the relay running.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { translate, type Locale } from '../../web/lib/messages'
import { deriveMenu, type MenuItem, type StatusProbe, type TrayMenu } from './menu-model'
import { copyLocalUrl, localRelayUrl, openLocalUrl } from './open-url'
import { MAX_INCOMING_LINE_BYTES, createLineSplitter, encodeMessage, parseBinaryMessage, type DriverMessage } from './protocol'

export interface CommandSpec {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export interface DriverOptions {
  /** `spawn`: start the relay and own it; `attach`: only query a relay already listening on this port */
  relay: { spawn: CommandSpec } | { attach: number }
  /** The native menu binary */
  tray: CommandSpec
  locale: Locale
  /** Seconds between two /status requests: 5 s, well under the limiter of /status (5 per second) */
  pollIntervalMs?: number
  probeTimeoutMs?: number
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  /** Bytes written to the binary and not yet read by it, beyond which the binary is stopped (default 64 KiB) */
  maxPendingWriteBytes?: number
  /** Minimum delay between two runs of the same click action (open, copyUrl); default 1 s */
  clickCooldownMs?: number
  now?: () => number
  fetch?: typeof fetch
  open?: (url: string, port: number) => Promise<boolean>
  copy?: (url: string, port: number) => Promise<boolean>
  /** Diagnostics for the person running the driver (stderr), never shown in the menu */
  log?: (message: string) => void
}

export interface DriverHandle {
  /** Resolves with the exit code once everything the driver started is stopped */
  done: Promise<number>
  /** Same path as the quit item and SIGTERM */
  stop(): void
  /** Bytes written to the binary and not yet taken by it (diagnostics and tests) */
  pendingWriteBytes(): number
}

export const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_PROBE_TIMEOUT_MS = 2000
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_STOP_TIMEOUT_MS = 5000
const DEFAULT_CLICK_COOLDOWN_MS = 1000
/** A /status answer is a small JSON document; anything bigger is not read */
const MAX_STATUS_BYTES = 64 * 1024
const MAX_RELAY_LINE_BYTES = 4096
const MAX_PROTOCOL_VIOLATIONS = 20
/**
 * Output waiting for the binary. A menu is written only once the previous write reached the pipe,
 * refreshes asked in between are merged into one, so at most one menu (and the quit message) wait;
 * reaching this cap means the binary does not read and is stopped, never a silent growth.
 */
const MAX_PENDING_WRITE_BYTES = 64 * 1024
/** The only line of the relay stdout the driver trusts: an exact loopback URL with a port */
const RELAY_URL_LINE = /^Server running at http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/

/** Port of the relay from its stdout line, or null. */
export function parseRelayUrlLine(line: string): number | null {
  const m = RELAY_URL_LINE.exec(line)
  if (!m) return null
  const port = Number(m[1])
  return port <= 65535 ? port : null
}

/** Probe GET /status on loopback. Never throws; every failure is a probe kind, never a value. */
export async function probeStatus(port: number, o: { fetch: typeof fetch; timeoutMs: number; now: () => number; signal?: AbortSignal }): Promise<StatusProbe> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, o.timeoutMs)
  const onAbort = () => controller.abort()
  o.signal?.addEventListener('abort', onAbort)
  try {
    const res = await o.fetch(`http://127.0.0.1:${port}/status`, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } })
    if (res.status !== 200) { void res.body?.cancel().catch(() => {}); return { kind: 'http-error' } }
    const text = await readCapped(res, MAX_STATUS_BYTES)
    if (text === null) return { kind: 'invalid-json' }
    try {
      return { kind: 'ok', body: JSON.parse(text), receivedAt: o.now() }
    } catch {
      return { kind: 'invalid-json' }
    }
  } catch {
    return { kind: timedOut ? 'timeout' : 'unreachable' }
  } finally {
    clearTimeout(timer)
    o.signal?.removeEventListener('abort', onAbort)
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) { void reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Wait for a child to exit; false if it did not within `ms`. */
function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false) }, ms)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    child.once('exit', onExit)
  })
}

export function startDriver(opts: DriverOptions): DriverHandle {
  const log = opts.log ?? (() => {})
  const now = opts.now ?? Date.now
  const doFetch = opts.fetch ?? globalThis.fetch
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(opts.locale, key, params)
  const open = opts.open ?? ((url, port) => openLocalUrl(url, port))
  const copy = opts.copy ?? ((url, port) => copyLocalUrl(url, port))
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const stopMs = opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  const ownsRelay = 'spawn' in opts.relay
  let port: number | null = 'attach' in opts.relay ? opts.relay.attach : null
  let relay: ChildProcess | null = null
  let tray: ChildProcess | null = null
  let probe: StatusProbe = { kind: 'not-started' }
  let lastMenu: TrayMenu | null = null
  let lastSent = ''
  let stopping = false
  let exitCode = 0
  let pollTimer: NodeJS.Timeout | undefined
  const abort = new AbortController()
  let violations = 0
  let resolveDone!: (code: number) => void
  const done = new Promise<number>(r => { resolveDone = r })

  const maxPending = opts.maxPendingWriteBytes ?? MAX_PENDING_WRITE_BYTES
  // Back-pressure: while a write has not reached the pipe, menus are not written but merged into one,
  // sent with the latest state once the write is done (the high-water mark of the stream, 64 KiB on
  // recent Node, would let about 160 menus pile up before write() says false)
  let writesInFlight = 0
  let menuPending = false

  const send = (message: DriverMessage) => {
    const stdin = tray?.stdin
    if (!stdin || stdin.destroyed || !stdin.writable) return
    writesInFlight++
    stdin.write(encodeMessage(message), () => {
      writesInFlight--
      if (writesInFlight === 0 && menuPending) { menuPending = false; refreshMenu(true) }
    })
    if (!stopping && stdin.writableLength > maxPending) {
      fail(`the tray binary does not read its input (more than ${maxPending} bytes waiting); stopping`)
    }
  }

  function refreshMenu(force = false) {
    if (stopping) return
    lastMenu = deriveMenu({ probe, now: now(), port, ownsRelay, t })
    const encoded = encodeMessage({ type: 'menu', tooltip: lastMenu.tooltip, items: lastMenu.items })
    if (!force && encoded === lastSent) return
    // Previous write not done: remember that a menu is due; the latest state is sent when it is
    if (writesInFlight > 0) { menuPending = true; return }
    lastSent = encoded
    send({ type: 'menu', tooltip: lastMenu.tooltip, items: lastMenu.items })
  }

  async function shutdown(code: number): Promise<void> {
    if (stopping) return
    stopping = true
    exitCode = code
    if (pollTimer) clearTimeout(pollTimer)
    abort.abort()
    if (tray && tray.exitCode === null && tray.signalCode === null) {
      send({ type: 'quit' })
      tray.stdin?.end()
      if (!(await waitExit(tray, 2000))) tray.kill('SIGTERM')
    }
    // Only the child this driver started: never a PID discovered elsewhere
    if (ownsRelay && relay && relay.exitCode === null && relay.signalCode === null) {
      relay.kill('SIGTERM')
      if (!(await waitExit(relay, stopMs))) {
        log('the relay did not stop after SIGTERM; it is left running (its PID is ' + String(relay.pid) + ')')
        exitCode = 1
      } else if (relay.exitCode !== null && relay.exitCode !== 0) {
        log(`the relay exited with code ${relay.exitCode}`)
        exitCode = 1
      }
    }
    resolveDone(exitCode)
  }

  const fail = (message: string) => { log(message); void shutdown(1) }

  // Each open or copy starts a process (openers are detached): one run at a time per action, and a
  // minimum delay between two, so a binary repeating a click cannot start a process per line
  const cooldownMs = opts.clickCooldownMs ?? DEFAULT_CLICK_COOLDOWN_MS
  const actionsRunning = new Set<MenuItem['id']>()
  const lastActionAt = new Map<MenuItem['id'], number>()

  async function onClick(id: MenuItem['id']) {
    const item = lastMenu?.items.find(i => i.id === id)
    if (!item || !item.enabled) return
    if (id === 'quit') { void shutdown(0); return }
    const url = port === null ? null : localRelayUrl(port)
    if (url === null || port === null) return
    if (id !== 'open' && id !== 'copyUrl') return
    const at = now()
    const last = lastActionAt.get(id)
    if (actionsRunning.has(id) || (last !== undefined && at - last < cooldownMs)) return
    actionsRunning.add(id)
    lastActionAt.set(id, at)
    try {
      if (id === 'open') {
        if (!(await open(url, port))) log('could not open the browser; open ' + url + ' by hand')
      } else if (!(await copy(url, port))) {
        log('could not copy to the clipboard (no clipboard tool found?); the URL is ' + url)
      }
    } finally {
      actionsRunning.delete(id)
    }
  }

  function startTray() {
    const child = nodeSpawn(opts.tray.file, opts.tray.args, { stdio: ['pipe', 'pipe', 'inherit'], shell: false, env: opts.tray.env ?? process.env })
    tray = child
    child.stdin.on('error', () => {})
    child.on('error', err => fail(`cannot start the tray binary: ${err.message}`))
    child.on('exit', code => {
      if (stopping) return
      log(`the tray binary exited (code ${String(code)}); stopping`)
      void shutdown(1)
    })
    const splitter = createLineSplitter(MAX_INCOMING_LINE_BYTES, event => {
      if (stopping) return
      if ('overflow' in event) return violation('line too long')
      const parsed = parseBinaryMessage(event.line)
      if (!parsed.ok) return violation(parsed.reason)
      const msg = parsed.message
      if (msg.type === 'ready') refreshMenu(true)
      else if (msg.type === 'click') void onClick(msg.id)
      else { log('the icon was closed'); void shutdown(0) }
    })
    child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk))
  }

  function violation(reason: string) {
    violations++
    log(`ignored a line from the tray binary: ${reason}`)
    if (violations >= MAX_PROTOCOL_VIOLATIONS) fail('too many invalid lines from the tray binary; stopping')
  }

  async function poll() {
    if (stopping || port === null) return
    probe = await probeStatus(port, { fetch: doFetch, timeoutMs: opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, now, signal: abort.signal })
    if (stopping) return
    refreshMenu()
    // No overlapping requests: the next one is scheduled when this one is over
    pollTimer = setTimeout(() => { void poll() }, pollMs)
  }

  function startRelay(spec: CommandSpec): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn(spec.file, spec.args, { stdio: ['ignore', 'pipe', 'inherit'], shell: false, env: spec.env ?? process.env })
      relay = child
      let found = false
      const timer = setTimeout(() => reject(new Error('the relay printed no URL in time')), opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)
      child.on('error', err => { clearTimeout(timer); reject(new Error(`cannot start the relay: ${err.message}`)) })
      child.on('exit', code => {
        clearTimeout(timer)
        if (!found) reject(new Error(`the relay exited (code ${String(code)}) before printing its URL`))
        else if (!stopping) fail(`the relay exited (code ${String(code)}); stopping`)
      })
      const splitter = createLineSplitter(MAX_RELAY_LINE_BYTES, event => {
        if (found || 'overflow' in event) return
        const p = parseRelayUrlLine(event.line)
        if (p !== null) { found = true; clearTimeout(timer); resolve(p) }
      })
      // Keep draining after the URL so the relay never blocks on a full pipe
      child.stdout.on('data', (chunk: Buffer) => splitter.push(chunk))
    })
  }

  void (async () => {
    try {
      if ('spawn' in opts.relay) port = await startRelay(opts.relay.spawn)
      else if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new Error('invalid relay port')
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
      return
    }
    if (stopping) return
    startTray()
    refreshMenu()
    void poll()
  })()

  return { done, stop: () => { void shutdown(0) }, pendingWriteBytes: () => tray?.stdin?.writableLength ?? 0 }
}
