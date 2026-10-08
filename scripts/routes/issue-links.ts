/**
 * GET /issue-links?role=<role>[&session=<id>] : PR/issues ouverts étiquetés agent:<role>, via gh (#63).
 * Chaque échec de cache lance gh avec le jeton de l'utilisateur : refus des requêtes d'un autre site,
 * plafond global de processus gh (en vol et par fenêtre), cache et coalescence (#102).
 */
import {
  RELAY_ISSUE_LINKS_RATE_BURST, RELAY_ISSUE_LINKS_RATE_PER_S, RELAY_ISSUE_LINKS_CACHE_TTL_MS, RELAY_ISSUE_LINKS_CACHE_MAX_ROLES,
  RELAY_ISSUE_LINKS_MAX_GH_IN_FLIGHT, RELAY_ISSUE_LINKS_MAX_PROBES_PER_WINDOW, RELAY_ISSUE_LINKS_PROBE_WINDOW_MS,
} from '../../extension/src/constants'
import { sanitizeRole, sanitizeSessionParam, issueLinksScope, type IssueLink } from '../../extension/src/issue-links'
import type { KeyedRateLimiter } from '../../extension/src/hook-guards'
import { KeyedCoalescer } from '../server-hardening'
import { guardedRoute, sendJson, sendPlain, type RouteHandler } from './guard'

export interface IssueLinksRouteDeps {
  limiter: KeyedRateLimiter
  allWorkspaces: boolean
  /** Le cwd connu d'une session (suivie, ou issue de l'index). */
  cwdOf: (sessionId: string) => string | undefined
  probe: (role: string, cwd?: string) => Promise<IssueLink[]>
}

export function createIssueLinksRoute(deps: IssueLinksRouteDeps): RouteHandler {
  const coalescer = new KeyedCoalescer<IssueLink[]>()
  const cache = new Map<string, { at: number; links: IssueLink[] }>()
  // Clés dont gh tourne maintenant (une requête de même clé la rejoint), et débuts des exécutions récentes
  const running = new Set<string>()
  let probeStarts: number[] = []

  return guardedRoute({ limiter: deps.limiter, rejectCrossOrigin: true }, async (req, res) => {
    let roles: string[] = []
    try { roles = new URL(req.url ?? '', 'http://localhost').searchParams.getAll('role') } catch { /* 400 below */ }
    const role = roles.length === 1 ? sanitizeRole(roles[0]) : undefined
    if (!role) return sendPlain(res, 400, 'Invalid role parameter')
    let sessionParams: string[] = []
    try { sessionParams = new URL(req.url ?? '', 'http://localhost').searchParams.getAll('session') } catch { /* no session */ }
    const sessionParam = sessionParams.length === 0 ? undefined : sessionParams.length === 1 ? sanitizeSessionParam(sessionParams[0]) : undefined
    if (sessionParams.length > 0 && !sessionParam) return sendPlain(res, 400, 'Invalid session parameter')

    const scope = issueLinksScope({
      session: sessionParam,
      cwd: sessionParam ? deps.cwdOf(sessionParam) : undefined,
      allWorkspaces: deps.allWorkspaces,
    })
    const cwd = scope.kind === 'cwd' ? scope.cwd : undefined
    const cacheKey = `${cwd ?? ''}\u0001${role}`
    const now = Date.now()
    let links: IssueLink[]
    const cached = cache.get(cacheKey)
    if (scope.kind === 'unknown') {
      links = [] // the project of this node is unknown: the relay's own repository would be another project's issues
    } else if (cached && now - cached.at < RELAY_ISSUE_LINKS_CACHE_TTL_MS) {
      links = cached.links
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
        links = await coalescer.run(cacheKey, () => deps.probe(role, cwd))
      } catch {
        links = [] // gh absent, unauthenticated or failing: no link, no error
      } finally {
        running.delete(cacheKey)
      }
      if (cache.size >= RELAY_ISSUE_LINKS_CACHE_MAX_ROLES) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(cacheKey, { at: Date.now(), links })
    }
    if (res.destroyed || res.headersSent) return
    sendJson(req, res, 200, { role, links })
  })
}
