/**
 * POST /launch and POST /launch/<id>/stop (#229, part 2 of 4): start and stop a headless `claude` on an issue.
 *
 * This route starts a process, so it is the most guarded one and OFF by default: without --allow-launch the relay
 * installs {@link createLaunchDisabledRoute}, which answers 404 to everything. When on, in this order:
 *   1. guardedRoute: loopback peer and Host (a tunnel name is never accepted here, whatever #241 opens), another site
 *      refused, POST only, a dedicated rate limiter -> 403 / 405 / 429;
 *   2. the per-start random token (`Authorization: Bearer`, constant-time comparison) -> 401, before any body is read;
 *   3. Content-Type exactly JSON, capped body, strict JSON -> 415 / 413 / 408 / 400;
 *   4. the pure launch-policy: request shape, repository allow-list and workspace origin, the issue re-read through gh
 *      (open, labelled agent:<role>, written by an OWNER/MEMBER/COLLABORATOR) -> 400 / 403 / 422 / 502;
 *   5. the supervisor's caps -> 409 (issue already launched) / 429 (simultaneous cap).
 * Refusals after the token are written to the journal with a fixed reason; the request body, the issue title and body
 * are never written anywhere and never reach the argv.
 */
import * as crypto from 'crypto'
import * as http from 'http'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { RELAY_LAUNCH_BODY_MAX_BYTES, RELAY_LAUNCH_BODY_TIMEOUT_MS } from '../../extension/src/constants'
import {
  buildLaunchCommand, checkRepoAllowed, evaluateIssue, issueLookupCommand, newSessionId, parseLaunchRequest, parseRepoAllowlist,
  type LaunchRefusal, type LaunchRequest,
} from '../../extension/src/launch-policy'
import { applySecurityHeaders } from '../server-hardening'
import type { LaunchSupervisor, StartRefusal } from '../launch-supervisor'
import { guardedRoute, sendPlain, type RouteHandler } from './guard'
import { isJsonContentType, readLimitedBody } from './scope'

const TOKEN_MIN_LENGTH = 32
const STOP_PATH_RE = /^\/launch\/([0-9a-f]{16})\/stop$/

/**
 * Why the start must stop (exit code 2), or null. Launching needs --allow-launch AND at least one valid --launch-repo;
 * a repository given without --allow-launch is refused too, so that no one believes a flag protects something it does not.
 * The message never echoes the raw value.
 */
export function launchStartupError(opts: { allowLaunch: boolean; repos: readonly string[] }): string | null {
  if (!opts.allowLaunch) {
    return opts.repos.length > 0 ? '--launch-repo has no effect without --allow-launch: add --allow-launch, or remove it (#229).' : null
  }
  const list = parseRepoAllowlist([...opts.repos])
  if (!list.ok || list.value.size === 0) {
    return '--allow-launch needs at least one --launch-repo <owner/name> (letters, digits, "-", "_", "."; no URL), and every one must be valid (#229).'
  }
  return null
}

/** What the console shows at startup. The token is shown here and nowhere else: never served over HTTP, never written to a file. */
export function launchTokenNotice(token: string, repos: readonly string[]): string {
  return [
    `Launch is ON for: ${repos.join(', ')}`,
    'Token of this start (paste it in the launch dialog; it is kept in memory only and changes at each start):',
    `  ${token}`,
    'Anyone who has it and can reach 127.0.0.1 can start an agent on those repositories. See docs/launch-security.md',
  ].join('\n')
}

/** 256 random bits, hex. New at every start of the relay; never written to disk, never in a URL. */
export function newLaunchToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** Constant time: both sides are hashed to a fixed size first, so neither the content nor the length leaks through timing. */
export function tokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function bearerOf(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const m = /^Bearer ([!-~]+)$/i.exec(header)
  return m ? m[1] : undefined
}

export interface LaunchRouteDeps {
  /** Dedicated limiter (RELAY_LAUNCH_RATE_*): it is not shared with any other route */
  limiter: KeyedRateLimiter
  token: string
  /** Lower-case `owner/name` of the repositories that may be launched on (parseRepoAllowlist) */
  allowlist: ReadonlySet<string>
  supervisor: LaunchSupervisor
  /** The workspace's `origin` remote, as git prints it; undefined when there is none. Rejects when git fails. */
  workspaceOrigin: () => Promise<string | undefined>
  /** Runs the gh command of the policy (no shell) and resolves its stdout. Rejects on failure. */
  lookupIssue: (cmd: { file: 'gh'; args: string[] }) => Promise<string>
  /** Source of the --session-id (defaults to crypto.randomUUID) */
  newSessionId?: () => string
  /** `--max-budget-usd`; the policy default when absent */
  budgetUsd?: number
  /** Body read timeout (default RELAY_LAUNCH_BODY_TIMEOUT_MS); injectable for tests */
  bodyTimeoutMs?: number
}

const REFUSAL_STATUS: Record<LaunchRefusal | StartRefusal | 'issue-lookup' | 'origin-lookup', number> = {
  body: 400, repo: 400, issue: 400, role: 400,
  'not-allowed': 403, origin: 403,
  'issue-json': 502, 'issue-lookup': 502, 'origin-lookup': 502,
  'issue-mismatch': 422, 'pull-request': 422, closed: 422, label: 422, author: 422,
  'session-id': 500, caps: 500, command: 500,
  'issue-active': 409, concurrent: 429,
  journal: 503, disposed: 503,
}

function reply(res: http.ServerResponse, status: number, value: unknown, extra: http.OutgoingHttpHeaders = {}): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff', ...extra,
  })
  res.end(body)
}

/** What the relay installs when --allow-launch is absent: the route does not exist. */
export function createLaunchDisabledRoute(): RouteHandler {
  return (_req, res) => {
    applySecurityHeaders(res, 'api')
    sendPlain(res, 404, 'Not found')
  }
}

export function createLaunchRoute(deps: LaunchRouteDeps): RouteHandler {
  if (typeof deps.token !== 'string' || deps.token.length < TOKEN_MIN_LENGTH) throw new Error('launch token too short')
  const sup = deps.supervisor
  const sessionIdSource = deps.newSessionId ?? (() => crypto.randomUUID())

  const refuse = (res: http.ServerResponse, reason: LaunchRefusal | StartRefusal | 'issue-lookup' | 'origin-lookup', req?: LaunchRequest) => {
    sup.recordRefusal(reason, req)
    reply(res, REFUSAL_STATUS[reason] ?? 400, { error: reason }, reason === 'concurrent' ? { 'Retry-After': '30' } : {})
  }

  async function launch(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!isJsonContentType(req.headers['content-type'])) return sendPlain(res, 415, 'Content-Type must be application/json')
    const body = await readLimitedBody(req, RELAY_LAUNCH_BODY_MAX_BYTES, deps.bodyTimeoutMs ?? RELAY_LAUNCH_BODY_TIMEOUT_MS)
    if (res.destroyed) return
    if (!body.ok) {
      const text = body.code === 413 ? 'Payload too large' : body.code === 408 ? 'Request timeout' : 'Bad request'
      return sendPlain(res, body.code, text, body.code === 400 ? {} : { Connection: 'close' })
    }
    let json: unknown
    try { json = JSON.parse(body.text) } catch { return refuse(res, 'body') }
    const parsed = parseLaunchRequest(json)
    if (!parsed.ok) return refuse(res, parsed.reason)
    const request = parsed.value

    // Cheap refusals first: a duplicate or a full house must not cost a git or a gh process
    const early = sup.check(request)
    if (early) return refuse(res, early, request)
    if (!deps.allowlist.has(request.repo.toLowerCase())) return refuse(res, 'not-allowed', request)

    let origin: string | undefined
    try { origin = await deps.workspaceOrigin() } catch { return refuse(res, 'origin-lookup', request) }
    const allowed = checkRepoAllowed(request, { allowlist: deps.allowlist, workspaceOrigin: origin })
    if (!allowed.ok) return refuse(res, allowed.reason, request)

    let stdout: string
    try { stdout = await deps.lookupIssue(issueLookupCommand(request)) } catch { return refuse(res, 'issue-lookup', request) }
    const issue = evaluateIssue(stdout, request)
    if (!issue.ok) return refuse(res, issue.reason, request)

    const sessionId = newSessionId(sessionIdSource)
    if (!sessionId.ok) return refuse(res, sessionId.reason, request)
    const command = buildLaunchCommand(request, { sessionId: sessionId.value, budgetUsd: deps.budgetUsd })
    if (!command.ok) return refuse(res, command.reason, request)

    // The client left while we were reading the issue: nothing is started for nobody
    if (res.destroyed) return
    // Checked again here, synchronously with the start: two requests that crossed during the awaits start one process
    const started = sup.start(request, command.value)
    if (!started.ok) return refuse(res, started.reason, request)
    reply(res, 202, { launch: started.launch })
  }

  function stop(res: http.ServerResponse, id: string) {
    const out = sup.stop(id)
    if (!out.ok) return reply(res, out.reason === 'unknown' ? 404 : 409, { error: out.reason })
    reply(res, 202, { launch: out.launch })
  }

  return guardedRoute({ limiter: deps.limiter, methods: ['POST'], rejectCrossOrigin: true, rateKey: req => req.socket.remoteAddress ?? 'unknown' }, async (req, res) => {
    let pathname = ''
    try { pathname = new URL(req.url ?? '', 'http://localhost').pathname } catch { /* 404 below */ }
    const stopId = STOP_PATH_RE.exec(pathname)?.[1]
    if (pathname !== '/launch' && !stopId) return sendPlain(res, 404, 'Not found')
    // Before any body is read: an unauthenticated caller costs one header comparison
    if (!tokenMatches(bearerOf(req), deps.token)) return sendPlain(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' })
    if (stopId) return stop(res, stopId)
    return launch(req, res)
  })
}
