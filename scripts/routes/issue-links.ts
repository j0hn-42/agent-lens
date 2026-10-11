/**
 * GET /issue-links?role=<role>[&session=<id>] : PR/issues ouverts étiquetés agent:<role>, via gh (#63).
 * GET /issue-links?scope=session&session=<id> : PR ouvertes par branche (avec checks) et issues sans agent du
 * projet de la session (#228) ; même cache, mêmes plafonds de processus gh.
 * Chaque échec de cache lance gh avec le jeton de l'utilisateur : refus des requêtes d'un autre site,
 * plafond global de processus gh (en vol et par fenêtre), cache et coalescence (#102).
 */
import {
  RELAY_ISSUE_LINKS_RATE_BURST, RELAY_ISSUE_LINKS_RATE_PER_S, RELAY_ISSUE_LINKS_CACHE_TTL_MS, RELAY_ISSUE_LINKS_CACHE_MAX_ROLES,
  RELAY_ISSUE_LINKS_MAX_GH_IN_FLIGHT, RELAY_ISSUE_LINKS_MAX_PROBES_PER_WINDOW, RELAY_ISSUE_LINKS_PROBE_WINDOW_MS,
} from '../../extension/src/constants'
import { sanitizeRole, sanitizeSessionParam, issueLinksScope, type IssueLink } from '../../extension/src/issue-links'
import type { SessionWork } from '../../extension/src/session-work'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { KeyedCoalescer } from '../server-hardening'
import { guardedRoute, sendJson, sendPlain, type RouteHandler } from './guard'

/** Wait asked of the client after a gh/git failure (gh is not rerun sooner for this key by a polite client) */
const FAILURE_RETRY_AFTER_S = 10

export interface IssueLinksRouteDeps {
  limiter: KeyedRateLimiter
  /** Lu à chaque requête : la portée change à l'exécution (#291) */
  allWorkspaces: boolean | (() => boolean)
  /** Le cwd connu d'une session (suivie, ou issue de l'index). */
  cwdOf: (sessionId: string) => string | undefined
  probe: (role: string, cwd?: string) => Promise<IssueLink[]>
  /** PR et issues du projet situé à `cwd` (le workspace du relais quand il est absent). */
  workProbe: (cwd?: string) => Promise<SessionWork>
}

export function createIssueLinksRoute(deps: IssueLinksRouteDeps): RouteHandler {
  const coalescer = new KeyedCoalescer<unknown>()
  const cache = new Map<string, { at: number; value: unknown }>()
  // Clés dont gh tourne maintenant (une requête de même clé la rejoint), et débuts des exécutions récentes
  const running = new Set<string>()
  let probeStarts: number[] = []

  return guardedRoute({ limiter: deps.limiter, rejectCrossOrigin: true }, async (req, res) => {
    let query = new URLSearchParams()
    try { query = new URL(req.url ?? '', 'http://localhost').searchParams } catch { /* 400 below */ }
    const roles = query.getAll('role')
    const scopes = query.getAll('scope')
    const sessionParams = query.getAll('session')
    const workView = scopes.length > 0
    if (workView && (scopes.length !== 1 || scopes[0] !== 'session' || roles.length > 0)) return sendPlain(res, 400, 'Invalid scope parameter')
    const role = workView ? undefined : roles.length === 1 ? sanitizeRole(roles[0]) : undefined
    if (!workView && !role) return sendPlain(res, 400, 'Invalid role parameter')
    const sessionParam = sessionParams.length === 1 ? sanitizeSessionParam(sessionParams[0]) : undefined
    if ((workView || sessionParams.length > 0) && !sessionParam) return sendPlain(res, 400, 'Invalid session parameter')

    const scope = issueLinksScope({
      session: sessionParam,
      cwd: sessionParam ? deps.cwdOf(sessionParam) : undefined,
      allWorkspaces: typeof deps.allWorkspaces === 'function' ? deps.allWorkspaces() : deps.allWorkspaces,
    })
    // The project of this session is unknown: the relay's own repository would be another project's work
    if (workView && scope.kind === 'unknown') return sendPlain(res, 404, 'Unknown project for this session')
    const cwd = scope.kind === 'cwd' ? scope.cwd : undefined
    const cacheKey = `${workView ? 'work' : role}\u0001${cwd ?? ''}`
    const now = Date.now()
    let value: unknown
    const cached = cache.get(cacheKey)
    if (!workView && scope.kind === 'unknown') {
      value = [] // the project of this node is unknown: the relay's own repository would be another project's issues
    } else if (cached && now - cached.at < RELAY_ISSUE_LINKS_CACHE_TTL_MS) {
      value = cached.value
    } else {
      if (!running.has(cacheKey)) {
        // A new gh run: bounded globally (in flight, and per window), independently of the limiter key
        probeStarts = probeStarts.filter(t => now - t < RELAY_ISSUE_LINKS_PROBE_WINDOW_MS)
        if (running.size >= RELAY_ISSUE_LINKS_MAX_GH_IN_FLIGHT || probeStarts.length >= RELAY_ISSUE_LINKS_MAX_PROBES_PER_WINDOW) {
          return sendPlain(res, 503, 'Busy', { 'Retry-After': '1' })
        }
        probeStarts.push(now)
        running.add(cacheKey)
      }
      try {
        value = await coalescer.run(cacheKey, () => (workView ? deps.workProbe(cwd) : deps.probe(role as string, cwd)))
      } catch {
        // gh or git absent, unauthenticated, rate-limited or timed out: that proves nothing, so neither
        // an empty list nor a cache entry; the card says "unavailable" and retries (#205)
        if (res.destroyed || res.headersSent) return
        return sendPlain(res, 502, 'Issue links unavailable', { 'Retry-After': String(FAILURE_RETRY_AFTER_S) })
      } finally {
        running.delete(cacheKey)
      }
      if (cache.size >= RELAY_ISSUE_LINKS_CACHE_MAX_ROLES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(cacheKey, { at: Date.now(), value })
    }
    if (res.destroyed || res.headersSent) return
    if (workView) sendJson(req, res, 200, { scope: 'session', session: sessionParam, ...(value as SessionWork) })
    else sendJson(req, res, 200, { role, links: value as IssueLink[] })
  })
}
