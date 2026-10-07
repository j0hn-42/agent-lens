/**
 * Hardening primitives shared by the dev relay (scripts/dev-relay.ts), the standalone app
 * (app/src/server.ts) and the relay itself (scripts/relay.ts). Issue #68.
 *
 *  - loopback-only listening with an optional EPHEMERAL port (port 0 -> the OS picks, the chosen port is returned)
 *  - GET / HEAD / OPTIONS only (405 + Allow otherwise)
 *  - strict headers on every response (CSP, no-store, nosniff, no-referrer)
 *  - session id query parameter validation (400)
 *  - KeyedCoalescer: ONE in-flight refresh per key (concurrent callers share it)
 *  - SharedTicker: ONE interval for all clients, stopped when the last one leaves
 *
 * Pure of relay state, so every piece is unit-testable with node:http on 127.0.0.1.
 */
import * as http from 'http'
import type { AddressInfo } from 'net'
import {
  CSP_API, CSP_STATIC_APP, ENV_AGENT_LENS_PORT, EPHEMERAL_PORT, LOOPBACK_HOST, SERVER_ALLOWED_METHODS,
} from '../extension/src/constants'
import { isValidSessionId } from '../extension/src/relay-guards'

// ─── Headers ─────────────────────────────────────────────────────────────────

export type ResponseKind = 'api' | 'static'

/** Security headers for a response kind. API/SSE/error responses get a CSP that forbids everything. */
export function securityHeaders(kind: ResponseKind): Record<string, string> {
  return {
    'Content-Security-Policy': kind === 'static' ? CSP_STATIC_APP : CSP_API,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
}

/** Set the security headers (res.writeHead later merges its own headers on top of them). */
export function applySecurityHeaders(res: http.ServerResponse, kind: ResponseKind): void {
  for (const [name, value] of Object.entries(securityHeaders(kind))) res.setHeader(name, value)
}

// ─── Port ────────────────────────────────────────────────────────────────────

/**
 * Port to listen on. The default (or the explicit one) is kept unless AGENT_LENS_PORT=0 asks for an
 * ephemeral port; any other AGENT_LENS_PORT value is ignored so existing dev scripts keep working.
 */
export function resolveListenPort(defaultPort: number, env: NodeJS.ProcessEnv = process.env): number {
  return env[ENV_AGENT_LENS_PORT]?.trim() === String(EPHEMERAL_PORT) ? EPHEMERAL_PORT : defaultPort
}

/** Listen on 127.0.0.1 only; resolves with the port actually bound (the real one when `port` is 0). */
export function listenLoopback(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e)
    server.once('error', onError)
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', onError)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

// ─── Request guard ───────────────────────────────────────────────────────────

const ALLOW = SERVER_ALLOWED_METHODS.join(', ')

function plain(res: http.ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extra })
  res.end(body)
}

/** Validate `session` / `sessionId` query parameters: absent, or exactly one safe value. */
export function hasValidSessionQuery(url: string | undefined): boolean {
  if (!url) return true
  let parsed: URL
  try { parsed = new URL(url, 'http://localhost') } catch { return false }
  for (const name of ['session', 'sessionId']) {
    const all = parsed.searchParams.getAll(name)
    if (all.length === 0) continue
    if (all.length > 1 || !isValidSessionId(all[0])) return false
  }
  return true
}

function pathOf(url: string | undefined): string {
  try { return new URL(url ?? '/', 'http://localhost').pathname } catch { return '' }
}

export interface GuardOptions {
  kind: ResponseKind
  /** Answer OPTIONS with 204 (CORS preflight is handled by the caller's headers). Default true. */
  answerOptions?: boolean
}

/**
 * First stage of every request: security headers, method allow-list, session parameter validation.
 * Returns true when the request was fully answered (405 / 204 / 400 / HEAD on the stream) and the
 * caller must stop; false when routing may continue.
 */
export function guardRequest(req: http.IncomingMessage, res: http.ServerResponse, opts: GuardOptions): boolean {
  applySecurityHeaders(res, opts.kind)
  const method = req.method ?? ''
  if (!(SERVER_ALLOWED_METHODS as readonly string[]).includes(method)) {
    plain(res, 405, 'Method not allowed', { Allow: ALLOW })
    return true
  }
  if (method === 'OPTIONS' && opts.answerOptions !== false) {
    res.writeHead(204, { Allow: ALLOW })
    res.end()
    return true
  }
  if (!hasValidSessionQuery(req.url)) {
    plain(res, 400, 'Invalid session parameter')
    return true
  }
  if (method === 'HEAD' && pathOf(req.url) === '/events') {
    // A HEAD must never open a stream: answer the headers of the stream and close
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end()
    return true
  }
  return false
}

// ─── Coalescing ──────────────────────────────────────────────────────────────

/** ONE in-flight execution per key: callers arriving while it runs share its promise. */
export class KeyedCoalescer<T> {
  private readonly inflight = new Map<string, Promise<T>>()
  private executions = 0

  /** Number of times the work function really ran. */
  get runs(): number { return this.executions }
  /** Number of keys currently in flight. */
  get pending(): number { return this.inflight.size }

  run(key: string, work: () => Promise<T> | T): Promise<T> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    this.executions++
    const p = (async () => work())().finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key)
    })
    this.inflight.set(key, p)
    return p
  }
}

// ─── Shared interval ─────────────────────────────────────────────────────────

/**
 * One shared interval for all clients. The first acquire() starts it, the release of the last
 * client stops it (no timer left behind). Each release function is idempotent.
 */
export class SharedTicker {
  private timer: NodeJS.Timeout | null = null
  private clients = 0

  constructor(private readonly tick: () => void, private readonly intervalMs: number) {}

  get active(): boolean { return this.timer !== null }
  get clientCount(): number { return this.clients }

  acquire(): () => void {
    this.clients++
    if (!this.timer) this.timer = setInterval(() => { try { this.tick() } catch { /* a failing tick must not kill the timer */ } }, this.intervalMs)
    let released = false
    return () => {
      if (released) return
      released = true
      this.clients--
      if (this.clients <= 0) this.stop()
    }
  }

  /** Stop unconditionally (dispose). */
  stop(): void {
    this.clients = 0
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
