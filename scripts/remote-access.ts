/**
 * Remote access guards, steps 1 and 2 of #241.
 *
 * v1 is "tunnel only": the relay never listens outside 127.0.0.1. A tunnel that exposes a name (Tailscale serve)
 * forwards to it, so its peer is loopback and the only thing that changes is the Host header, which names the
 * tunnel. `--allow-host <name>` adds such a name to an explicit list (no wildcard, no suffix match: DNS rebinding).
 * A request whose Host is on the list only reaches a strict read-only surface (/events, /status, the static
 * app, and POST /pair); /context, /issue-links, /observations, /statusline and POST /scope stay loopback only (403).
 *
 * Step 2 (#475): /events and /status through an allowed Host also need the pairing cookie of POST /pair
 * (remote-pairing.ts), else 401. The static app is served without it: it is the page that pairs, and it holds no
 * data. An allow list and its pairing are bound together by createRelay (bindRemoteAuth); an allow list without a
 * pairing reads nothing (401), so no caller can open the surface by forgetting the token.
 * An SSH -L tunnel is NOT a tunnel Host: the remote browser opens http://localhost:<port>, its Host is loopback. The
 * relay cannot tell it (or an editor's port forward, or a proxy that rewrites Host) from a local tab. So once remote
 * access is on (an allow list exists), a loopback Host needs the pairing cookie too (#517, requiresRemotePairing):
 * only the static app (the page that pairs) and POST /pair answer without it. Without an allow list, loopback is
 * exactly as before: no pairing, no token.
 *
 * The standalone app wires it in (#517): --allow-host needs --token-file, the start prints the pairing URLs (the
 * token on a terminal only, in the URL fragment), and the page consumes /#pair= (web/lib/remote-pairing.ts).
 */
import type * as http from 'http'
import { RELAY_MAX_ALLOWED_HOSTS } from '../extension/src/constants'
import { isLoopbackAddress, isLoopbackHostHeader } from '../extension/src/hook-guards'
import { applySecurityHeaders, type ResponseKind } from './server-hardening'
import { createLogger } from '../extension/src/logger'

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_NAME_LENGTH = 253
const MAX_ECHO = 64

function echo(value: string): string {
  const safe = value.replace(/[^\x20-\x7e]/g, '?')
  return JSON.stringify(safe.length > MAX_ECHO ? `${safe.slice(0, MAX_ECHO)}...` : safe)
}

/** One --allow-host value, lowercased, or the reason it is refused. */
function parseOne(raw: string): { host: string } | { error: string } {
  const value = raw.toLowerCase()
  const m = /^([^:]*)(?::(\d{1,5}))?$/.exec(value)
  if (!m) return { error: `${echo(raw)} is not a host name with an optional port` }
  const [, name, port] = m
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535 || port.startsWith('0'))) return { error: `${echo(raw)}: invalid port` }
  // Browsers leave the default port out of Host: such an entry would never match
  if (port === '80' || port === '443') return { error: `${echo(raw)}: leave out the default port ${port}` }
  if (!name || name.length > MAX_NAME_LENGTH) return { error: `${echo(raw)} is not a host name` }
  const labels = name.split('.')
  if (!labels.every(l => LABEL.test(l))) return { error: `${echo(raw)} is not a host name (no wildcard, IP literal, trailing dot or URL)` }
  // An all-numeric last label is an IP address: a tunnel is named, and an address says nothing about who answers
  if (/^\d+$/.test(labels[labels.length - 1])) return { error: `${echo(raw)}: IP addresses are refused, give the tunnel's name` }
  if (labels[labels.length - 1] === 'localhost') return { error: `${echo(raw)}: loopback names are always accepted` }
  return { host: port === undefined ? name : `${name}:${port}` }
}

/** Validates the --allow-host values: exact names (and port), lowercased, deduplicated, at most RELAY_MAX_ALLOWED_HOSTS. */
export function parseAllowedHosts(values: readonly string[]): { hosts: string[]; errors: string[] } {
  const hosts: string[] = []
  const errors: string[] = []
  for (const raw of values) {
    const r = parseOne(raw)
    if ('error' in r) { errors.push(r.error); continue }
    if (hosts.includes(r.host)) continue
    if (hosts.length >= RELAY_MAX_ALLOWED_HOSTS) { errors.push(`at most ${RELAY_MAX_ALLOWED_HOSTS} names, ${echo(raw)} ignored`); continue }
    hosts.push(r.host)
  }
  return { hosts, errors }
}

export type HostClass = 'loopback' | 'allowed' | 'foreign'

/** Loopback Host, a Host EXACTLY on the allow list (case-insensitive, same port), or foreign (403). */
export function classifyHost(host: string | undefined, allowed: readonly string[]): HostClass {
  if (isLoopbackHostHeader(host)) return 'loopback'
  if (!host || allowed.length === 0) return 'foreign'
  return allowed.includes(host.toLowerCase()) ? 'allowed' : 'foreign'
}

/**
 * Host class of a request. Two Host headers are foreign whatever the first one says: Node keeps the first, a
 * proxy in front may have used the last. Every entry point (app gate, relay guards) goes through this one.
 */
export function requestHostClass(req: Pick<http.IncomingMessage, 'headers' | 'headersDistinct'>, allowed: readonly string[]): HostClass {
  if ((req.headersDistinct?.host?.length ?? 0) > 1) return 'foreign'
  return classifyHost(req.headers.host, allowed)
}

/** Static files the app serves: one path segment ending in .js / .css / .html (see app/src/static.ts), or the root. */
const STATIC_PATH = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css|html))?$/

/** GET/HEAD on a file of the static app (or the root): the page that pairs, it holds no data. */
function isStaticAppRoute(method: string | undefined, url: string | undefined): boolean {
  return (method === 'GET' || method === 'HEAD') && STATIC_PATH.test((url ?? '').split('?')[0])
}

/** The strict read-only surface reachable through an allowed Host: GET/HEAD on /events, /status and the static app. */
export function isRemoteReadOnlyRoute(method: string | undefined, url: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  // The raw path, as serveStatic reads it: no URL normalisation that could turn '//x/a.js' into '/a.js'
  const pathname = (url ?? '').split('?')[0]
  return pathname === '/events' || pathname === '/status' || STATIC_PATH.test(pathname)
}

/** For an allowed Host: any Origin other than https://<that host> is another site (the dev origins included). */
export function isRemoteCrossOrigin(headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] }, host: string): boolean {
  // A sibling subdomain is same-site: its no-cors requests could hold remote SSE slots. Only same-origin or a typed URL.
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true
  const origin = headers.origin
  if (origin === undefined) return false
  if (typeof origin !== 'string') return true
  return origin.toLowerCase() !== `https://${host.toLowerCase()}`
}

/**
 * For POST /pair on a loopback Host (#517): only the page's own http origin, http://<that Host>, or no Origin at all
 * (a typed request); any other site, scheme or port is refused.
 */
export function isLoopbackPairCrossOrigin(headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] }, host: string): boolean {
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return true
  const origin = headers.origin
  if (origin === undefined) return false
  if (typeof origin !== 'string') return true
  return origin.toLowerCase() !== `http://${host.toLowerCase()}`
}

/**
 * True when a request of this Host class must show a live pairing cookie: always through an allowed Host; on a
 * loopback Host as soon as remote access is on (an allow list exists), because an SSH -L tunnel or a port forward
 * also shows a loopback Host (#517). Without an allow list, never: loopback stays as it always was.
 */
export function requiresRemotePairing(cls: HostClass, allowed: readonly string[]): boolean {
  return cls === 'allowed' || (cls === 'loopback' && allowed.length > 0)
}

/** Rate-limit key for an allowed Host: the tunnel peer is always 127.0.0.1, so User-Agent / Origin (chosen by the
 *  client) must not mint new buckets. All clients of one tunnel name share one bucket. */
export function remoteRateKey(host: string): string {
  return `remote|${host.toLowerCase()}`
}

/** What an allow list needs from its pairing (implemented by remote-pairing.ts). */
export interface RemoteAuth {
  handlePair: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
  /** True for a live pairing cookie issued on the request's own Host class (#535). */
  isPaired: (req: Pick<http.IncomingMessage, 'headers' | 'headersDistinct'>) => boolean
}

/** Each validated allow list (by identity) and its pairing. Bound once by createRelay; never from a request. */
const remoteAuths = new WeakMap<readonly string[], RemoteAuth>()

export function bindRemoteAuth(allowed: readonly string[], auth: RemoteAuth): void {
  if (remoteAuths.has(allowed)) throw new Error('remote access: this allow list already has a pairing')
  remoteAuths.set(allowed, auth)
}

/** True only when the allow list has a pairing AND the request carries one of its live cookies (fail closed). */
export function isRemotePaired(req: Pick<http.IncomingMessage, 'headers' | 'headersDistinct'>, allowed: readonly string[]): boolean {
  return remoteAuths.get(allowed)?.isPaired(req) ?? false
}

/** Same channel as the relay's other warnings (shown without --verbose). */
const remoteLog = createLogger('Relay')
/** At most one log line per interval and allow list: anyone who reaches the tunnel can send POST /pair at will. */
const PAIR_FAILURE_LOG_INTERVAL_MS = 60_000
const lastPairFailureLog = new WeakMap<readonly string[], number>()

/**
 * A handlePair rejection is a bug, not a wrong token: the operator must see it. The line is fixed: the step and the
 * error class only (a plain identifier, else "Error"), never its message, the token, a cookie or an address.
 */
function logPairFailure(allowed: readonly string[], err: unknown): void {
  const now = Date.now()
  const last = lastPairFailureLog.get(allowed)
  if (last !== undefined && now - last < PAIR_FAILURE_LOG_INTERVAL_MS) return
  lastPairFailureLog.set(allowed, now)
  const name = err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(err.name) ? err.name : 'Error'
  remoteLog.warn(`POST /pair: the pairing handler failed (${name}), answered 401; further failures are not logged for ${PAIR_FAILURE_LOG_INTERVAL_MS / 1000} s`)
}

/** The data routes of the remote surface: they need the pairing cookie. */
function needsPairing(url: string | undefined): boolean {
  const pathname = (url ?? '').split('?')[0]
  return pathname === '/events' || pathname === '/status'
}

function answer(res: http.ServerResponse, kind: ResponseKind, code: 401 | 403, text: string): true {
  applySecurityHeaders(res, kind)
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(text)
  return true
}

/** POST /pair, answered by the pairing bound to the allow list (403 when there is none). Always true. */
function answerPair(req: http.IncomingMessage, res: http.ServerResponse, allowed: readonly string[]): true {
  const auth = remoteAuths.get(allowed)
  if (!auth) return answer(res, 'api', 403, 'Forbidden')
    // Anyone who reaches the tunnel can send this: a rejection must never become an unhandled one (it would stop the
    // relay). Same 401 as any pairing failure, nothing of the error is sent; one fixed, rate-limited log line.
  auth.handlePair(req, res).catch((err: unknown) => {
    try { logPairFailure(allowed, err) } catch { /* logging must not change the answer */ }
    try {
      if (!res.headersSent) answer(res, 'api', 401, 'Unauthorized')
      else if (!res.writableEnded) res.end()
    } catch {
      res.destroy()
    }
  })
  return true
}

/**
 * First gate of the app server: 403 for a non-loopback peer, a foreign Host (static files included), and, for
 * an allowed Host, anything outside the read-only surface or from another origin; POST /pair is answered here by the
 * pairing; /events and /status without a live pairing cookie get 401. True when it answered.
 * A loopback Host without an allow list goes through untouched (/pair is not one of its routes). With an allow list
 * (#517), a loopback Host gets the static app and POST /pair; every other route needs the pairing cookie (401).
 */
export function gateRemoteRequest(req: http.IncomingMessage, res: http.ServerResponse, allowed: readonly string[], kind: ResponseKind): boolean {
  const host = req.headers.host
  const cls = requestHostClass(req, allowed)
  if (!isLoopbackAddress(req.socket.remoteAddress) || cls === 'foreign') return answer(res, kind, 403, 'Forbidden')
  const isPair = (req.url ?? '').split('?')[0] === '/pair'
  if (cls === 'loopback') {
    if (!requiresRemotePairing(cls, allowed)) return false
    if (isPair) return answerPair(req, res, allowed)
    if (isStaticAppRoute(req.method, req.url)) return false
    // Every other loopback route (data, POST /scope, /launch, OPTIONS...) is a loopback one: the cookie opens it whole
    if (!isRemotePaired(req, allowed)) return answer(res, kind, 401, 'Unauthorized')
    return false
  }
  if (isRemoteCrossOrigin(req.headers, host ?? '')) return answer(res, kind, 403, 'Forbidden')
  if (isPair) return answerPair(req, res, allowed)
  if (!isRemoteReadOnlyRoute(req.method, req.url)) return answer(res, kind, 403, 'Forbidden')
  if (needsPairing(req.url) && !isRemotePaired(req, allowed)) return answer(res, kind, 401, 'Unauthorized')
  return false
}

/** ::1 in any spelling (brackets, zeros written out), not another IPv6 address. */
function isIpv6Loopback(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (!/^[0-9a-f:]+$/.test(v) || !v.includes(':')) return false
  return /^(?:0{0,4}:){2,7}0{0,3}1$/.test(v) && v.split('::').length <= 2
}

const TUNNEL_HINT = 'For remote access, forward a named tunnel (Tailscale serve) to 127.0.0.1 and name it with --allow-host and --token-file (#241).'

/**
 * Why the start must stop (exit code 2), or null. Reads its arguments only, never the environment (#474): listening
 * outside loopback takes an explicit --host AND an explicit --remote, and there is no default address (never an
 * implicit 0.0.0.0). v1 is tunnel only, so even both flags are refused until TLS ships; --allow-host needs
 * --token-file (#517), and --token-file needs --allow-host.
 */
export function remoteStartupError(opts: { allowHosts: readonly string[]; host?: string; remote?: boolean; tokenFile?: string }): string | null {
  const host = opts.host
  const loopbackHost = host !== undefined && ['127.0.0.1', 'localhost'].includes(host.trim().toLowerCase())
  // IPv6 loopback (#478 review, point 6): it is loopback, so --remote is not the answer; the server binds 127.0.0.1 only
  if (host !== undefined && isIpv6Loopback(host)) {
    return `--host ${echo(host)}: IPv6 loopback is not supported, Agent Lens listens on 127.0.0.1 only (IPv4 loopback). `
      + 'Leave out --host (or give 127.0.0.1).'
  }
  if (opts.remote) {
    // A security flag is never ignored: --remote without a real address to listen on is a mistake, not a no-op
    if (host === undefined || host.trim() === '') {
      return '--remote needs an explicit --host <address>: there is no default address (never 0.0.0.0). ' + TUNNEL_HINT
    }
    if (loopbackHost) return `--remote with --host ${echo(host)} does nothing: loopback is already the default. Leave out --remote.`
    return `--remote --host ${echo(host)}: listening outside loopback is refused until TLS ships (#241): without it the pairing `
      + 'token and the event stream (prompts, tool outputs, file contents) would travel in clear text. ' + TUNNEL_HINT
  }
  if (host !== undefined && host.trim() === '') return '--host needs an address (only 127.0.0.1 / localhost are accepted).'
  if (host !== undefined && !loopbackHost) {
    return `--host ${echo(host)}: Agent Lens only listens on loopback (127.0.0.1); another address needs an explicit --remote `
      + '(no environment variable), and is refused even then until TLS ships. ' + TUNNEL_HINT
  }
  const tokenFile = opts.tokenFile
  // A security flag is never a no-op: --token-file alone would write nothing and pair nothing
  if (opts.allowHosts.length === 0) {
    return tokenFile === undefined ? null : '--token-file only goes with --allow-host <name>: without a tunnel name there is nothing to pair.'
  }
  const { hosts, errors } = parseAllowedHosts(opts.allowHosts)
  if (errors.length > 0) return `--allow-host: ${errors.join('; ')}`
  if (tokenFile === undefined) {
    return '--allow-host needs --token-file <path>: the pairing token of this start is written there (owner only), '
      + 'and it is printed only on a terminal, never in a log (#517).'
  }
  if (tokenFile.trim() === '') return '--token-file needs a path (a file in a folder only you can read).'
  return null
}
