/**
 * Remote access guards, step 1 of #241.
 *
 * v1 is "tunnel only": the relay never listens outside 127.0.0.1. A tunnel that exposes a name (Tailscale serve)
 * forwards to it, so its peer is loopback and the only thing that changes is the Host header, which names the
 * tunnel. `--allow-host <name>` adds such a name to an explicit list (no wildcard, no suffix match: DNS rebinding).
 * An SSH -L tunnel is NOT covered: the remote browser opens http://localhost:<port>, its Host is loopback and it
 * gets the loopback surface. Step 2 (token) has to cover that case too.
 * A request whose Host is on the list only reaches a strict read-only surface (/events, /status, the static
 * app); /context, /issue-links, /observations, /statusline and POST /scope stay loopback only.
 *
 * The SSE stream carries prompts, tool outputs and file contents. Until token authentication ships (step 2 of
 * #241), REMOTE_AUTH_AVAILABLE is false and the start refuses --allow-host: the wiring below is exercised by
 * tests, never by a running app.
 */
import type * as http from 'http'
import { RELAY_MAX_ALLOWED_HOSTS } from '../extension/src/constants'
import { isLoopbackAddress, isLoopbackHostHeader } from '../extension/src/hook-guards'
import { applySecurityHeaders, type ResponseKind } from './server-hardening'

/** Flipped by the token authentication step of #241; until then --allow-host stops the start. */
export const REMOTE_AUTH_AVAILABLE = false

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

/** Rate-limit key for an allowed Host: the tunnel peer is always 127.0.0.1, so User-Agent / Origin (chosen by the
 *  client) must not mint new buckets. All clients of one tunnel name share one bucket. */
export function remoteRateKey(host: string): string {
  return `remote|${host.toLowerCase()}`
}

/**
 * First gate of the app server: 403 for a non-loopback peer, a foreign Host (static files included), and, for
 * an allowed Host, anything outside the read-only surface or from another origin. True when it answered.
 */
export function gateRemoteRequest(req: http.IncomingMessage, res: http.ServerResponse, allowed: readonly string[], kind: ResponseKind): boolean {
  const host = req.headers.host
  const cls = requestHostClass(req, allowed)
  const refused = !isLoopbackAddress(req.socket.remoteAddress)
    || cls === 'foreign'
    || (cls === 'allowed' && (!isRemoteReadOnlyRoute(req.method, req.url) || isRemoteCrossOrigin(req.headers, host ?? '')))
  if (!refused) return false
  applySecurityHeaders(res, kind)
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Forbidden')
  return true
}

/** Why the start must stop (exit code 2), or null. v1 never listens outside loopback and needs the token for --allow-host. */
export function remoteStartupError(opts: { allowHosts: readonly string[]; host?: string }): string | null {
  if (opts.host !== undefined && !['127.0.0.1', 'localhost'].includes(opts.host.trim().toLowerCase())) {
    return `--host ${echo(opts.host)}: Agent Lens only listens on loopback (127.0.0.1). For remote access, forward a named tunnel `
      + '(Tailscale serve) to it and name it with --allow-host (#241).'
  }
  if (opts.allowHosts.length === 0) return null
  const { hosts, errors } = parseAllowedHosts(opts.allowHosts)
  if (errors.length > 0) return `--allow-host: ${errors.join('; ')}`
  if (hosts.length > 0 && !REMOTE_AUTH_AVAILABLE) {
    return '--allow-host is refused until token authentication is shipped (#241): the event stream carries prompts, '
      + 'tool outputs and file contents, and anyone who reaches the tunnel would read them.'
  }
  return null
}
