/**
 * Remote pairing, step 2 of #241: what a tunnel Host (--allow-host) has to show before it reads anything.
 *
 * - A pairing token of 256 random bits is drawn at every start, kept in memory, optionally written to --token-file
 *   (mode 0600 on POSIX; on Windows the mode is ignored and the file inherits the ACL of its folder; replaced at every
 *   start, never read back). It is never logged and never served.
 * - EventSource sends no header, so the token travels in the URL FRAGMENT: https://<tunnel>/#pair=<token>. A fragment
 *   is never sent to a server nor written in an access log. The app posts it to POST /pair.
 * - POST /pair compares it in constant time and answers with a separate random pairing id in a cookie
 *   `__Host-...; HttpOnly; Secure; SameSite=Strict; Path=/`. The cookie never carries the token; the relay keeps only
 *   the SHA-256 of each id, with an expiry, at most REMOTE_PAIR_MAX_SESSIONS of them.
 * - Every failure (wrong / missing token, malformed body, wrong Content-Type, oversized body) is the same 401
 *   'Unauthorized'. POST /pair has its own rate limiter, keyed on the tunnel name (its peer is always 127.0.0.1), debited
 *   by failures only, after the token was compared: past the budget a failure gets 429, the right token still pairs.
 *   That limiter only changes the status of a failure: it neither slows nor caps the attempts, and every request is
 *   still read and compared. What one request costs is bounded by REMOTE_PAIR_BODY_MAX_BYTES and
 *   REMOTE_PAIR_BODY_TIMEOUT_MS; what makes guessing hopeless is the 256 bits of the token, not the limiter.
 *
 * Lifetime and revocation (a deliberate choice of this first version):
 * - The token is REUSABLE for the whole run of the relay: every device that has it can pair, again and again.
 * - At most REMOTE_PAIR_MAX_SESSIONS (8) pairings at once; past it, 503 until one expires.
 * - Each pairing lives REMOTE_PAIR_SESSION_TTL_MS (12 h), then the device pairs again with the token.
 * - Nothing revokes one pairing or the token on its own: restarting the relay draws a new token and forgets every
 *   pairing, that is how everything is revoked.
 * - The web side must drop the fragment with history.replaceState BEFORE it posts the token, so the token does not
 *   stay in the address bar, the history or a bookmark.
 *
 * Loopback: without an allow list there is no pairing at all, and loopback is untouched. With one (#517), an SSH -L
 * tunnel or a port forward shows a loopback Host, so a loopback Host pairs too, from its own http origin
 * (http://<Host>), and the gate asks it for the cookie (remote-access.ts, requiresRemotePairing). Browsers keep a
 * Secure cookie from http://localhost and http://127.0.0.1 (both are potentially trustworthy origins).
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type * as http from 'http'
import { isLoopbackAddress, KeyedRateLimiter } from '../extension/src/hook-guards'
import { applySecurityHeaders } from './server-hardening'
import { requestHostClass, isRemoteCrossOrigin, isLoopbackPairCrossOrigin, remoteRateKey } from './remote-access'
import { isJsonContentType, readLimitedBody } from './routes/scope'

/** Name of the pairing cookie. `__Host-`: the browser only keeps it with Secure, Path=/ and no Domain. */
export const PAIR_COOKIE = '__Host-agent-lens-pair'
/** Paired remote clients at once (each device or browser profile is one). */
export const REMOTE_PAIR_MAX_SESSIONS = 8
/** Lifetime of one pairing: past it, the device pairs again with the token of the current start. */
export const REMOTE_PAIR_SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** POST /pair budget per tunnel name: 5 attempts, then one every 10 s. */
export const REMOTE_PAIR_RATE_BURST = 5
export const REMOTE_PAIR_RATE_PER_S = 0.1
/** `{"token":"<43 chars>"}` is 54 bytes. */
export const REMOTE_PAIR_BODY_MAX_BYTES = 128
export const REMOTE_PAIR_BODY_TIMEOUT_MS = 2_000

const TOKEN_BYTES = 32
const SECRET = /^[A-Za-z0-9_-]{43}$/

/** 256 random bits, base64url (43 characters). Used for the token and for each pairing id. */
export function newPairingToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
}

function isSecret(value: unknown): value is string {
  return typeof value === 'string' && SECRET.test(value) && Buffer.from(value, 'base64url').length === TOKEN_BYTES
}

/** Constant-time comparison: both sides are hashed first, so neither the content nor the length leaks through timing. */
export function tokensEqual(candidate: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(candidate, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

/** `{"token":"<43 base64url>"}` and nothing else, or null. */
export function parsePairBody(text: string): string | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'token') return null
  const token = (value as { token: unknown }).token
  return isSecret(token) ? token : null
}

/** The pairing id of the Cookie header: exactly one occurrence of PAIR_COOKIE with a well-formed value, or null. */
export function readPairCookie(header: string | string[] | undefined): string | null {
  if (header === undefined) return null
  const joined = Array.isArray(header) ? header.join('; ') : header
  if (joined.length > 4096) return null
  let found: string | null = null
  let count = 0
  for (const part of joined.split(';')) {
    const pair = part.replace(/^ +/, '')
    const eq = pair.indexOf('=')
    if (eq < 0 || pair.slice(0, eq) !== PAIR_COOKIE) continue
    count++
    found = pair.slice(eq + 1)
  }
  return count === 1 && isSecret(found) ? found : null
}

export function pairCookieHeader(id: string, maxAgeS: number): string {
  return `${PAIR_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeS)}`
}

/** What the start prints (or a tray shows): the token in the fragment only. */
export function pairingUrl(host: string, token: string): string {
  return `https://${host}/#pair=${token}`
}

/**
 * --token-file: writes the token through a temporary file renamed over the target (a symlink in its place is replaced,
 * never followed; a wider existing file is replaced too). Throws on any failure: the start stops.
 * POSIX: mode 0600 (owner only). Windows: the mode is ignored, the file inherits the ACL of its folder; pick a folder
 * only you can read (e.g. under %USERPROFILE%). Nothing is refused there, it is documented.
 */
export function writeTokenFile(file: string, token: string): void {
  const dir = path.dirname(path.resolve(file))
  const tmp = path.join(dir, `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    try {
      fs.writeSync(fd, `${token}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

export interface RemotePairingOptions {
  /** The validated tunnel Host names: POST /pair answers only through one of them. */
  allowedHosts: readonly string[]
  /** Injectable for tests only; default: newPairingToken(). Must be 256 bits of base64url. */
  token?: string
  maxSessions?: number
  ttlMs?: number
  rate?: { burst: number; perSecond: number }
  now?: () => number
}

export interface RemotePairing {
  /** The token of this start (to print in the pairing URL or write to --token-file). Never sent over HTTP. */
  readonly token: string
  /** POST /pair. Answers by itself: 403 / 405 / 429 / 401 / 503 / 204 + cookie. */
  handlePair: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
  /** True when the request carries a live pairing cookie. Says nothing about the Host: callers check it first. */
  isPaired: (req: Pick<http.IncomingMessage, 'headers'>) => boolean
  pairedCount: () => number
}

function plain(res: http.ServerResponse, code: number, text: string, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
  res.end(text)
}

const idKey = (id: string) => crypto.createHash('sha256').update(id, 'utf8').digest('hex')

export function createRemotePairing(options: RemotePairingOptions): RemotePairing {
  const token = options.token ?? newPairingToken()
  if (!isSecret(token)) throw new Error('remote pairing: the token must be 256 bits of base64url')
  const maxSessions = options.maxSessions ?? REMOTE_PAIR_MAX_SESSIONS
  const ttlMs = options.ttlMs ?? REMOTE_PAIR_SESSION_TTL_MS
  const now = options.now ?? Date.now
  const limiter = new KeyedRateLimiter(options.rate?.burst ?? REMOTE_PAIR_RATE_BURST, options.rate?.perSecond ?? REMOTE_PAIR_RATE_PER_S, 16)
  /** SHA-256 of each pairing id -> expiry. The ids themselves are not kept. */
  const sessions = new Map<string, number>()

  const prune = () => {
    const t = now()
    for (const [k, until] of sessions) if (until <= t) sessions.delete(k)
  }

  const isPaired = (req: Pick<http.IncomingMessage, 'headers'>): boolean => {
    const id = readPairCookie(req.headers.cookie)
    if (id === null) return false
    const key = idKey(id)
    const until = sessions.get(key)
    if (until === undefined) return false
    if (until <= now()) { sessions.delete(key); return false }
    return true
  }

  const handlePair = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    applySecurityHeaders(res, 'api')
    const host = req.headers.host ?? ''
    // A tunnel Host from its https origin; a loopback Host (SSH -L, port forward, #517) from its own http origin
    const cls = requestHostClass(req, options.allowedHosts)
    const crossOrigin = cls === 'allowed' ? isRemoteCrossOrigin(req.headers, host) : cls === 'loopback' ? isLoopbackPairCrossOrigin(req.headers, host) : true
    if (!isLoopbackAddress(req.socket.remoteAddress) || crossOrigin) {
      return plain(res, 403, 'Forbidden')
    }
    if (req.method !== 'POST') return plain(res, 405, 'Method not allowed', { Allow: 'POST' })
    // Only failures use the bucket, and only once the token was compared: a client who keeps the bucket empty with
    // wrong attempts cannot lock the owner out (the right token always passes). The bucket only turns a failure's 401
    // into 429: it does not slow the attempts down, each one is still read and compared. The cost of one request is
    // bounded by REMOTE_PAIR_BODY_MAX_BYTES and REMOTE_PAIR_BODY_TIMEOUT_MS; the 256 bits of the token are what make
    // brute force moot. Its key is the tunnel name (X-Forwarded-For is never read).
    const fail = (extra: http.OutgoingHttpHeaders = {}) => limiter.allow(remoteRateKey(host), now())
      ? plain(res, 401, 'Unauthorized', extra)
      : plain(res, 429, 'Too many requests', { 'Retry-After': '10', ...extra })
    if (!isJsonContentType(req.headers['content-type'])) return fail({ Connection: 'close' })
    const body = await readLimitedBody(req, REMOTE_PAIR_BODY_MAX_BYTES, REMOTE_PAIR_BODY_TIMEOUT_MS)
    if (res.destroyed) return
    if (!body.ok) return fail({ Connection: 'close' })
    const candidate = parsePairBody(body.text)
    // Always one comparison, whatever the body was: a malformed body costs the same as a wrong token
    const match = tokensEqual(candidate ?? '', token)
    if (candidate === null || !match) return fail()
    prune()
    if (sessions.size >= maxSessions) return plain(res, 503, 'Too many clients', { 'Retry-After': '60' })
    const id = newPairingToken()
    sessions.set(idKey(id), now() + ttlMs)
    res.writeHead(204, { 'Cache-Control': 'no-store', 'Set-Cookie': pairCookieHeader(id, ttlMs / 1000) })
    res.end()
  }

  return { token, handlePair, isPaired, pairedCount: () => { prune(); return sessions.size } }
}
